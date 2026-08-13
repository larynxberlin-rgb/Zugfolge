/**
 * Invariante 4 — `world_id` in jeder Tabelle, jedem Index, jedem Event und
 * jeder produktiven Datenbankabfrage.
 *
 * `worlds` ist die einzige eingebaute Ausnahme: Diese Tabelle ist selbst die
 * Wurzel der Mandantentrennung. Wirklich weltuebergreifende Betriebsabfragen
 * muessen lokal und mit tragfaehiger Begruendung sichtbar ausgenommen werden:
 * `// guards:allow world-id — <Begruendung>`.
 */

import { isExempt } from "./pattern-rule.js";
import type { Finding, Rule, SourceFile } from "../types.js";

const TABELLENSCHLUESSEL = "world_id";
const DRIZZLE_SPALTE = "worldId";
const WELTWURZELTABELLE = "worlds";
const PRODUKTIVER_SCRIPT_PFAD = /^(?:apps|packages)\/[^/]+\/src\/.*\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const SCRIPTDATEI = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const TESTDATEI = /(?:^|\/)(?:__tests__|fixtures)(?:\/|$)|\.(?:test|spec|integration\.test|e2e\.test)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

function zeileVon(text: string, offset: number): number {
  let zeile = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") zeile += 1;
  }
  return zeile;
}

function bloecke(text: string, muster: RegExp): { name: string; offset: number; block: string }[] {
  const treffer = [...text.matchAll(muster)];
  return treffer.map((eintrag, index) => {
    const offset = eintrag.index ?? 0;
    const naechster = treffer[index + 1]?.index ?? text.length;
    return { name: eintrag[1] ?? "(unbenannt)", offset, block: text.slice(offset, naechster) };
  });
}

function melde(befunde: Finding[], datei: SourceFile, offset: number, message: string): void {
  befunde.push({ rule: "world-id", path: datei.path, line: zeileVon(datei.text, offset), message });
}

function tabellenBefund(name: string): string {
  return `Tabelle '${name}' hat keine ${TABELLENSCHLUESSEL} (Invariante 4). Weltisolation wird nachgewiesen, nicht diszipliniert.`;
}

function indexBefund(name: string): string {
  return `Index '${name}' fuehrt keine ${TABELLENSCHLUESSEL} (Invariante 4). Ohne Weltbezug im Index verlaesst eine Abfrage die eigene Welt nur ueber den vollen Tabellenscan.`;
}

function pruefeSql(datei: SourceFile): Finding[] {
  const befunde: Finding[] = [];
  const zeilen = datei.text.split("\n");
  for (const eintrag of bloecke(datei.text, /create\s+table(?:\s+if\s+not\s+exists)?\s+"?([\w.]+)"?/gi)) {
    if (eintrag.name === WELTWURZELTABELLE) continue;
    const bis = eintrag.block.indexOf(";");
    const rumpf = bis === -1 ? eintrag.block : eintrag.block.slice(0, bis);
    const zeile = zeileVon(datei.text, eintrag.offset);
    if (!rumpf.includes(TABELLENSCHLUESSEL) && !isExempt(zeilen, zeile - 1, "world-id")) {
      melde(befunde, datei, eintrag.offset, tabellenBefund(eintrag.name));
    }
  }

  const indexMuster = /create\s+(?:unique\s+)?index(?:\s+concurrently)?(?:\s+if\s+not\s+exists)?\s+"?[\w.]+"?\s+on\s+"?([\w.]+)"?(?:\s+using\s+\w+)?\s*\(([^)]*)\)/gi;
  for (const treffer of datei.text.matchAll(indexMuster)) {
    const tabelle = treffer[1] ?? "(unbenannt)";
    const spalten = treffer[2] ?? "";
    const offset = treffer.index ?? 0;
    const zeile = zeileVon(datei.text, offset);
    if (tabelle !== WELTWURZELTABELLE && !spalten.includes(TABELLENSCHLUESSEL) && !isExempt(zeilen, zeile - 1, "world-id")) {
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

/** Findet das Ende eines Query-Ausdrucks, ohne Semikolons in Strings mitzunehmen. */
function queryEnde(text: string, start: number): number {
  let rund = 0;
  let eckig = 0;
  let geschweift = 0;
  let string: "'" | '"' | "`" | undefined;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const zeichen = text[index];
    if (string !== undefined) {
      if (escaped) escaped = false;
      else if (zeichen === "\\") escaped = true;
      else if (zeichen === string) string = undefined;
      continue;
    }
    if (zeichen === "'" || zeichen === '"' || zeichen === "`") {
      string = zeichen;
      continue;
    }
    if (zeichen === "(") rund += 1;
    else if (zeichen === ")") rund = Math.max(0, rund - 1);
    else if (zeichen === "[") eckig += 1;
    else if (zeichen === "]") eckig = Math.max(0, eckig - 1);
    else if (zeichen === "{") geschweift += 1;
    else if (zeichen === "}") geschweift = Math.max(0, geschweift - 1);
    else if (zeichen === ";" && rund === 0 && eckig === 0 && geschweift === 0) return index + 1;
  }
  return text.length;
}

function passendeKlammer(text: string, offen: number): number {
  let tiefe = 0;
  let string: "'" | '"' | "`" | undefined;
  let escaped = false;
  for (let index = offen; index < text.length; index += 1) {
    const zeichen = text[index];
    if (string !== undefined) {
      if (escaped) escaped = false;
      else if (zeichen === "\\") escaped = true;
      else if (zeichen === string) string = undefined;
      continue;
    }
    if (zeichen === "'" || zeichen === '"' || zeichen === "`") string = zeichen;
    else if (zeichen === "(") tiefe += 1;
    else if (zeichen === ")" && --tiefe === 0) return index;
  }
  return text.length - 1;
}

function passendeGeschweifteKlammer(text: string, offen: number): number {
  let tiefe = 0;
  let string: "'" | '"' | "`" | undefined;
  let escaped = false;
  for (let index = offen; index < text.length; index += 1) {
    const zeichen = text[index];
    if (string !== undefined) {
      if (escaped) escaped = false;
      else if (zeichen === "\\") escaped = true;
      else if (zeichen === string) string = undefined;
      continue;
    }
    if (zeichen === "'" || zeichen === '"' || zeichen === "`") string = zeichen;
    else if (zeichen === "{") tiefe += 1;
    else if (zeichen === "}" && --tiefe === 0) return index;
  }
  return text.length - 1;
}

function lokaleScopes(text: string): ReadonlyMap<string, string> {
  const scopes = new Map<string, string>();
  for (const match of text.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    const start = match.index ?? 0;
    const parameterStart = text.indexOf("(", start);
    const parameterEnd = parameterStart >= 0 ? passendeKlammer(text, parameterStart) : start;
    const bodyStart = text.indexOf("{", parameterEnd + 1);
    if (name !== undefined && bodyStart >= 0) scopes.set(name, text.slice(start, passendeGeschweifteKlammer(text, bodyStart) + 1));
  }
  for (const match of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    const name = match[1];
    const start = match.index ?? 0;
    if (name !== undefined) scopes.set(name, text.slice(start, queryEnde(text, start)));
  }
  return scopes;
}

function bezeichnerAusCode(text: string): { name: string; index: number }[] {
  const result: { name: string; index: number }[] = [];
  let string: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < text.length;) {
    const zeichen = text[index];
    if (string !== undefined) {
      if (escaped) escaped = false;
      else if (zeichen === "\\") escaped = true;
      else if (zeichen === string) string = undefined;
      index += 1;
      continue;
    }
    if (zeichen === "'" || zeichen === '"') {
      string = zeichen;
      index += 1;
      continue;
    }
    if (zeichen === "/" && text[index + 1] === "/") {
      index = text.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (zeichen === "/" && text[index + 1] === "*") {
      const ende = text.indexOf("*/", index + 2);
      index = ende < 0 ? text.length : ende + 2;
      continue;
    }
    if (zeichen !== undefined && /[A-Za-z_$]/.test(zeichen)) {
      let ende = index + 1;
      while (ende < text.length && /[\w$]/.test(text[ende] ?? "")) ende += 1;
      result.push({ name: text.slice(index, ende), index });
      index = ende;
      continue;
    }
    index += 1;
  }
  return result;
}

function tabellenName(tabelle: string): string {
  return tabelle.slice(tabelle.lastIndexOf(".") + 1);
}

function vorangestellterBezeichner(text: string, index: number): string | undefined {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(text[cursor] ?? "")) cursor -= 1;
  if (text[cursor] !== ".") return undefined;
  cursor -= 1;
  while (cursor >= 0 && /\s/.test(text[cursor] ?? "")) cursor -= 1;
  const ende = cursor + 1;
  while (cursor >= 0 && /[\w$]/.test(text[cursor] ?? "")) cursor -= 1;
  return text.slice(cursor + 1, ende) || undefined;
}

function enthaeltWeltbindung(
  text: string,
  tabelle: string,
  scopes: ReadonlyMap<string, string>,
  roheSqlSpalte = false,
  gesehen = new Set<string>(),
): boolean {
  const identifiers = bezeichnerAusCode(text);
  const erwartet = tabellenName(tabelle);
  if (identifiers.some(({ name, index }) => {
    if (name !== "worldId" && name !== "world_id" && !name.endsWith("WorldId")) return false;
    const prefix = vorangestellterBezeichner(text, index);
    return prefix === erwartet || (roheSqlSpalte && name === "world_id" && prefix === undefined);
  })) return true;
  for (const identifier of identifiers) {
    const { name } = identifier;
    let vorher = identifier.index - 1;
    while (vorher >= 0 && /\s/.test(text[vorher] ?? "")) vorher -= 1;
    if (text[vorher] === "." || gesehen.has(name)) continue;
    const scope = scopes.get(name);
    if (scope === undefined) continue;
    gesehen.add(name);
    if (enthaeltWeltbindung(scope, tabelle, scopes, roheSqlSpalte, gesehen)) return true;
  }
  return false;
}

function queryHatWeltfilter(query: string, tabelle: string, scopes: ReadonlyMap<string, string>): boolean {
  const filter = /\.(?:where|innerJoin|leftJoin|rightJoin|fullJoin)\s*\(/g;
  for (const match of query.matchAll(filter)) {
    const offen = (match.index ?? 0) + match[0].lastIndexOf("(");
    const argument = query.slice(offen + 1, passendeKlammer(query, offen));
    if (enthaeltWeltbindung(argument, tabelle, scopes)) return true;
  }
  return false;
}

function ausnahmeIstBegruendet(zeilen: readonly string[], index: number): boolean {
  for (const zeile of [zeilen[index], zeilen[index - 1]]) {
    const marker = zeile?.indexOf("guards:allow world-id") ?? -1;
    if (marker < 0) continue;
    const begruendung = zeile?.slice(marker + "guards:allow world-id".length).replace(/^[\s\-–—:]+/, "").trim() ?? "";
    return begruendung.length >= 20;
  }
  return false;
}

function queryBefund(operation: string, tabelle: string): string {
  return `${operation.toUpperCase()} auf '${tabelle}' bindet keine Welt in derselben Query (Invariante 4). Filter mit worldId ergaenzen oder die weltuebergreifende Betriebsabfrage sichtbar mit 'guards:allow world-id — <Begruendung>' dokumentieren.`;
}

function templateEnde(text: string, offen: number): number {
  let escaped = false;
  for (let index = offen + 1; index < text.length; index += 1) {
    const zeichen = text[index];
    if (escaped) escaped = false;
    else if (zeichen === "\\") escaped = true;
    else if (zeichen === "`") return index;
  }
  return text.length;
}

function tabelleNachTopLevelFrom(sqlText: string): string | undefined {
  let tiefe = 0;
  let string: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < sqlText.length; index += 1) {
    const zeichen = sqlText[index];
    if (string !== undefined) {
      if (escaped) escaped = false;
      else if (zeichen === "\\") escaped = true;
      else if (zeichen === string) string = undefined;
      continue;
    }
    if (zeichen === "'" || zeichen === '"') string = zeichen;
    else if (zeichen === "(") tiefe += 1;
    else if (zeichen === ")") tiefe = Math.max(0, tiefe - 1);
    else if (tiefe === 0 && /^from\b/i.test(sqlText.slice(index))) {
      return /^from\s+(?:\$\{\s*)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/i
        .exec(sqlText.slice(index))?.[1];
    }
  }
  return undefined;
}

function roheSqlQueryHatWeltfilter(sqlText: string, tabelle: string, scopes: ReadonlyMap<string, string>): boolean {
  const filterStart = /\b(?:where|on)\b/i.exec(sqlText)?.index;
  return filterStart !== undefined && enthaeltWeltbindung(sqlText.slice(filterStart), tabelle, scopes, true);
}

function pruefeRoheSqlQueries(datei: SourceFile): Finding[] {
  if (!PRODUKTIVER_SCRIPT_PFAD.test(datei.path) || TESTDATEI.test(datei.path)) return [];
  const befunde: Finding[] = [];
  const zeilen = datei.text.split("\n");
  const scopes = lokaleScopes(datei.text);
  const raw = /\b(?:db|tx)\s*\.\s*execute\s*\(\s*sql\s*`/g;
  for (const match of datei.text.matchAll(raw)) {
    const offset = match.index ?? 0;
    const offen = offset + match[0].lastIndexOf("`");
    const sqlText = datei.text.slice(offen + 1, templateEnde(datei.text, offen));
    const operation = /^\s*(select|update|delete)\b/i.exec(sqlText)?.[1]?.toLowerCase();
    if (operation === undefined) continue;
    const tabelle = operation === "update"
      ? /^\s*update\s+(?:\$\{\s*)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/i.exec(sqlText)?.[1]
      : tabelleNachTopLevelFrom(sqlText);
    if (tabelle === undefined) continue;
    const weltwurzel = tabelle === WELTWURZELTABELLE || tabelle.endsWith(`.${WELTWURZELTABELLE}`);
    const leereSchemaProbe = operation === "select" && /\blimit\s+0\b/i.test(sqlText);
    const zeile = zeileVon(datei.text, offset) - 1;
    const ausgenommen = isExempt(zeilen, zeile, "world-id");
    if (!weltwurzel && !leereSchemaProbe && !roheSqlQueryHatWeltfilter(sqlText, tabelle, scopes) && !ausgenommen) {
      melde(befunde, datei, offset, queryBefund(operation, tabelle));
    } else if (ausgenommen && !ausnahmeIstBegruendet(zeilen, zeile)) {
      melde(befunde, datei, offset, "Ausnahme fuer eine weltuebergreifende Query braucht eine konkrete Begruendung.");
    }
  }
  return befunde;
}

function pruefeDrizzleQueries(datei: SourceFile): Finding[] {
  if (!PRODUKTIVER_SCRIPT_PFAD.test(datei.path) || TESTDATEI.test(datei.path)) return [];
  const befunde: Finding[] = [];
  const zeilen = datei.text.split("\n");
  const scopes = lokaleScopes(datei.text);
  const operationen = /\b(?:db|tx)\s*\.\s*(selectDistinct|select|update|delete)\s*\(/g;

  for (const match of datei.text.matchAll(operationen)) {
    const offset = match.index ?? 0;
    const operation = match[1] ?? "query";
    const query = datei.text.slice(offset, queryEnde(datei.text, offset));
    const tabelle = operation === "select" || operation === "selectDistinct"
      ? /\.from\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/.exec(query)?.[1]
      : new RegExp(`\\.${operation}\\s*\\(\\s*([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)?)`).exec(query)?.[1];
    if (tabelle === undefined) continue;
    const weltwurzel = tabelle === WELTWURZELTABELLE || tabelle.endsWith(`.${WELTWURZELTABELLE}`);
    const zeile = zeileVon(datei.text, offset) - 1;
    const ausgenommen = isExempt(zeilen, zeile, "world-id");
    if (!weltwurzel && !queryHatWeltfilter(query, tabelle, scopes) && !ausgenommen) {
      melde(befunde, datei, offset, queryBefund(operation, tabelle));
    } else if (ausgenommen && !ausnahmeIstBegruendet(zeilen, zeile)) {
      melde(befunde, datei, offset, "Ausnahme fuer eine weltuebergreifende Query braucht eine konkrete Begruendung.");
    }
  }
  return befunde;
}

export const worldIdRule: Rule = {
  id: "world-id",
  title: "world_id in jeder Tabelle, jedem Index und jeder produktiven Query",
  scope: "repository",
  check(files: readonly SourceFile[]): Finding[] {
    const befunde: Finding[] = [];
    for (const datei of files) {
      if (datei.path.endsWith(".sql")) befunde.push(...pruefeSql(datei));
      if (SCRIPTDATEI.test(datei.path) && datei.text.includes("pgTable")) befunde.push(...pruefeDrizzle(datei));
      if (SCRIPTDATEI.test(datei.path)) {
        befunde.push(...pruefeDrizzleQueries(datei));
        befunde.push(...pruefeRoheSqlQueries(datei));
      }
    }
    return befunde;
  },
};
