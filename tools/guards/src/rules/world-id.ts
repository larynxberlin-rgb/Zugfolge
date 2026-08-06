/**
 * Invariante 4 — `world_id` in jeder Tabelle.
 *
 * Die Regel greift ins Leere, solange es kein Schema gibt, und schlägt in dem
 * Augenblick an, in dem die erste Tabelle ohne Weltbezug entsteht. Genau dafür
 * steht sie schon in M0.2 und nicht erst in M2.2: `world_id` nachträglich
 * einzuziehen hieße, jede Abfrage und jede Zeile anzufassen.
 */

import type { Finding, Rule, SourceFile } from "../types.js";

const TABELLENSCHLUESSEL = "world_id";

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

function pruefeSql(datei: SourceFile): Finding[] {
  const befunde: Finding[] = [];
  for (const eintrag of bloecke(
    datei.text,
    /create\s+table(?:\s+if\s+not\s+exists)?\s+"?([\w.]+)"?/gi,
  )) {
    const bis = eintrag.block.indexOf(";");
    const rumpf = bis === -1 ? eintrag.block : eintrag.block.slice(0, bis);
    if (!rumpf.includes(TABELLENSCHLUESSEL)) {
      befunde.push({
        rule: "world-id",
        path: datei.path,
        line: zeileVon(datei.text, eintrag.offset),
        message:
          `Tabelle '${eintrag.name}' hat keine ${TABELLENSCHLUESSEL} (Invariante 4). ` +
          "Weltisolation wird nachgewiesen, nicht diszipliniert.",
      });
    }
  }
  return befunde;
}

function pruefeDrizzle(datei: SourceFile): Finding[] {
  const befunde: Finding[] = [];
  for (const eintrag of bloecke(datei.text, /pgTable\s*\(\s*["'`]([\w.]+)["'`]/g)) {
    if (!eintrag.block.includes(TABELLENSCHLUESSEL)) {
      befunde.push({
        rule: "world-id",
        path: datei.path,
        line: zeileVon(datei.text, eintrag.offset),
        message:
          `Tabelle '${eintrag.name}' hat keine ${TABELLENSCHLUESSEL} (Invariante 4). ` +
          "Weltisolation wird nachgewiesen, nicht diszipliniert.",
      });
    }
  }
  return befunde;
}

/** Prüft SQL-Migrationen und Drizzle-Schemata auf `world_id`. */
export const worldIdRule: Rule = {
  id: "world-id",
  title: "world_id in jeder Tabelle",
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
