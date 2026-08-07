/**
 * Invariante 4 — `world_id` in jeder Tabelle, jedem Index, jedem Event.
 *
 * Die Regel greift ins Leere, solange es kein Schema gibt, und schlägt in dem
 * Augenblick an, in dem die erste Tabelle ohne Weltbezug entsteht. Genau dafür
 * steht sie schon in M0.2 und nicht erst in M2.2: `world_id` nachträglich
 * einzuziehen hieße, jede Abfrage und jede Zeile anzufassen. M2.2
 * (`packages/db`) macht sie vollständig: Tabelle, Index und — als
 * Postgres-Tabelle geführt — auch das Event-Log.
 *
 * Eine Ausnahme ist eingebaut, keine erfunden: `worlds` ist die Wurzel der
 * Mandantentrennung selbst und trägt deshalb keine eigene `world_id`. Jede
 * weitere Ausnahme gehört sichtbar in den Code, nicht in diese Datei —
 * `// guards:allow world-id — <Begründung>`.
 */

import { isExempt } from "./pattern-rule.js";
import type { Finding, Rule, SourceFile } from "../types.js";

const TABELLENSCHLUESSEL = "world_id";
const DRIZZLE_SPALTE = "worldId";
/** Die einzige Tabelle, die *ist* die Welt statt eine ihrer Zeilen zu sein. */
const WELTWURZELTABELLE = "worlds";

function zeileVon(text: string, offset: number): number {
  let zeile = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") {
      zeile += 1;
    }
  }
  return zeile;
}

/** Zerlegt einen Text in Blöcke, die je bei `muster` beginnen. */
function bloecke(text: string, muster: RegExp): { name: string; offset: number; block: string }[] {
  const treffer = [...text.matchAll(muster)];
  return treffer.map((eintrag, index) => {
    const offset = eintrag.index ?? 0;
    const naechster = treffer[index + 1]?.index ?? text.length;
    return {
      name: eintrag[1] ?? "(unbenannt)",
      offset,
      block: text.slice(offset, naechster),
    };
  });
}

function melde(befunde: Finding[], datei: SourceFile, offset: number, message: string): void {
  befunde.push({ rule: "world-id", path: datei.path, line: zeileVon(datei.text, offset), message });
}

function tabellenBefund(name: string): string {
  return (
    `Tabelle '${name}' hat keine ${TABELLENSCHLUESSEL} (Invariante 4). ` +
    "Weltisolation wird nachgewiesen, nicht diszipliniert."
  );
}

function indexBefund(name: string): string {
  return (
    `Index '${name}' führt keine ${TABELLENSCHLUESSEL} (Invariante 4). ` +
    "Ohne Weltbezug im Index verlässt eine Abfrage die eigene Welt nur über den vollen Tabellenscan."
  );
}

function pruefeSql(datei: SourceFile): Finding[] {
  const befunde: Finding[] = [];
  const zeilen = datei.text.split("\n");

  for (const eintrag of bloecke(
    datei.text,
    /create\s+table(?:\s+if\s+not\s+exists)?\s+"?([\w.]+)"?/gi,
  )) {
    if (eintrag.name === WELTWURZELTABELLE) {
      continue;
    }
    const bis = eintrag.block.indexOf(";");
    const rumpf = bis === -1 ? eintrag.block : eintrag.block.slice(0, bis);
    const zeile = zeileVon(datei.text, eintrag.offset);
    if (!rumpf.includes(TABELLENSCHLUESSEL) && !isExempt(zeilen, zeile - 1, "world-id")) {
      melde(befunde, datei, eintrag.offset, tabellenBefund(eintrag.name));
    }
  }

  const indexMuster =
    /create\s+(?:unique\s+)?index(?:\s+concurrently)?(?:\s+if\s+not\s+exists)?\s+"?[\w.]+"?\s+on\s+"?([\w.]+)"?(?:\s+using\s+\w+)?\s*\(([^)]*)\)/gi;
  for (const treffer of datei.text.matchAll(indexMuster)) {
    const tabelle = treffer[1] ?? "(unbenannt)";
    const spalten = treffer[2] ?? "";
    const offset = treffer.index ?? 0;
    const zeile = zeileVon(datei.text, offset);
    if (
      tabelle !== WELTWURZELTABELLE &&
      !spalten.includes(TABELLENSCHLUESSEL) &&
      !isExempt(zeilen, zeile - 1, "world-id")
    ) {
      melde(befunde, datei, offset, indexBefund(`${tabelle}: ${treffer[0]?.trim() ?? ""}`.slice(0, 80)));
    }
  }

  return befunde;
}

function pruefeDrizzle(datei: SourceFile): Finding[] {
  const befunde: Finding[] = [];
  const zeilen = datei.text.split("\n");

  for (const eintrag of bloecke(datei.text, /pgTable\s*\(\s*["'`]([\w.]+)["'`]/g)) {
    const ausgenommen = eintrag.name === WELTWURZELTABELLE;

    if (!ausgenommen) {
      const zeile = zeileVon(datei.text, eintrag.offset);
      if (!eintrag.block.includes(TABELLENSCHLUESSEL) && !isExempt(zeilen, zeile - 1, "world-id")) {
        melde(befunde, datei, eintrag.offset, tabellenBefund(eintrag.name));
      }
    }

    const indexMuster = /\b(?:uniqueIndex|index)\s*\(\s*["'`]([\w-]+)["'`]\s*\)\s*\.on\s*\(([^)]*)\)/g;
    for (const treffer of eintrag.block.matchAll(indexMuster)) {
      const indexName = treffer[1] ?? "(unbenannt)";
      const spalten = treffer[2] ?? "";
      const offset = eintrag.offset + (treffer.index ?? 0);
      const zeile = zeileVon(datei.text, offset);
      if (!ausgenommen && !spalten.includes(DRIZZLE_SPALTE) && !isExempt(zeilen, zeile - 1, "world-id")) {
        melde(befunde, datei, offset, indexBefund(indexName));
      }
    }
  }

  return befunde;
}

/** Prüft SQL-Migrationen und Drizzle-Schemata auf `world_id` — in Tabelle und Index. */
export const worldIdRule: Rule = {
  id: "world-id",
  title: "world_id in jeder Tabelle, jedem Index, jedem Event",
  scope: "repository",
  check(files: readonly SourceFile[]): Finding[] {
    const befunde: Finding[] = [];
    for (const datei of files) {
      if (datei.path.endsWith(".sql")) {
        befunde.push(...pruefeSql(datei));
      }
      if (datei.path.endsWith(".ts") && datei.text.includes("pgTable")) {
        befunde.push(...pruefeDrizzle(datei));
      }
    }
    return befunde;
  },
};
