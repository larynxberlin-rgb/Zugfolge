/** Ausführung der Regeln und Aufbereitung der Befunde. */

import { compileGlobs } from "./glob.js";
import type { Finding, GuardConfig, Rule, SourceFile } from "./types.js";

/**
 * Die Dateien, auf die eine domänengebundene Regel angewandt wird.
 *
 * Führt keine Domäne die Regel, prüft sie nichts. Das ist gewollt und der
 * Grund, warum es die Regel `coverage` gibt.
 */
export function filesForRule(
  files: readonly SourceFile[],
  config: GuardConfig,
  ruleId: string,
): SourceFile[] {
  const pfade = config.domains
    .filter((domain) => domain.rules.includes(ruleId))
    .flatMap((domain) => domain.paths);
  if (pfade.length === 0) {
    return [];
  }
  const trifftPfad = compileGlobs(pfade);
  return files.filter((datei) => trifftPfad(datei.path));
}

/** Führt alle übergebenen Regeln aus. */
export function runRules(
  files: readonly SourceFile[],
  config: GuardConfig,
  rules: readonly Rule[],
): Finding[] {
  const befunde: Finding[] = [];
  for (const regel of rules) {
    const auswahl =
      regel.scope === "repository" ? files : filesForRule(files, config, regel.id);
    befunde.push(...regel.check(auswahl, config));
  }
  befunde.sort((links, rechts) => {
    if (links.rule !== rechts.rule) {
      return links.rule < rechts.rule ? -1 : 1;
    }
    if (links.path !== rechts.path) {
      return links.path < rechts.path ? -1 : 1;
    }
    return links.line - rechts.line;
  });
  return befunde;
}

/** Menschenlesbarer Bericht. */
export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) {
    return "Wächter: keine Befunde.";
  }

  const zeilen: string[] = [];
  let letzteRegel = "";
  for (const befund of findings) {
    if (befund.rule !== letzteRegel) {
      zeilen.push(`\n${befund.rule}`);
      letzteRegel = befund.rule;
    }
    const ort = befund.line === 0 ? befund.path : `${befund.path}:${befund.line}`;
    zeilen.push(`  ${ort}`);
    zeilen.push(`      ${befund.message}`);
  }
  zeilen.push(`\n${findings.length} Befund(e).`);
  return zeilen.join("\n");
}
