/**
 * Schichtentrennung von Code, Daten und Marke (E16, M0.5).
 *
 * Der eigentliche Kopierschutz liegt nicht im Lizenztext, sondern darin, dass
 * die proprietären Schichten gar nicht erst im öffentlichen Repositorium
 * liegen: EconomyRelease, Fahrzeugkatalog und Balancing, Weltdaten und
 * Betriebshistorie, Marken- und Gestaltungsassets. `.gitignore` hält sie
 * draußen — aber `.gitignore` ist eine Bitte, kein Riegel: eine Datei mit
 * `git add -f` landet trotzdem im Baum.
 *
 * Diese Regel ist der Riegel. Legt jemand eine Datei in einem proprietären
 * Pfad an, schlägt sie an — unabhängig davon, was `.gitignore` sagt.
 *
 * **Grenze:** Der Wächter liest nur Textdateien (siehe repo.ts). Rohdaten als
 * Binärformat (`*.pbf`, `*.pmtiles`, `*.tif`) erreichen ihn nicht; die fängt
 * `.gitignore` ab. Der teuerste Fall — ein als Text abgelegter EconomyRelease,
 * eine Balancing-Tabelle, ein Fahrzeugkatalog — wird hier gefangen.
 */

import { compileGlobs } from "../glob.js";
import type { Finding, Rule, SourceFile } from "../types.js";

/**
 * Pfade, die eine proprietäre Schicht tragen und deshalb nicht ins öffentliche
 * Repositorium gehören. Spiegelt den Kopf von `.gitignore` (docs/geschaeft.md 4,
 * docs/rechteschutz.md).
 */
export const PROPRIETAERE_PFADE: readonly string[] = [
  // Balancing, Wirtschaft und Fahrzeugkatalog
  "data/economy/**",
  "data/balancing/**",
  "data/fahrzeugkatalog/**",
  "**/*.economyrelease",
  "**/*.economyrelease.json",
  // Weltdaten, Betriebshistorie, Spielerdaten
  "data/worlds/**",
  "data/eventlog/**",
  "data/replays/**",
  "backups/**",
  // Aus OSM abgeleitete, getrennt lizenzierte Releases
  "data/osm/**",
  "data/dem/**",
  "data/infra/**",
  // Marken- und Gestaltungsassets
  "assets/brand/**",
  "assets/liveries/**",
];

/** Ausnahme im Code, sichtbar im Review — wie bei den Musterregeln. */
const AUSNAHME = "guards:allow layer-separation";

/** Prüft, dass keine proprietäre Schicht im öffentlichen Baum liegt. */
export const layerSeparationRule: Rule = {
  id: "layer-separation",
  title: "Keine proprietäre Schicht im öffentlichen Repositorium",
  scope: "repository",
  check(files: readonly SourceFile[]): Finding[] {
    const findings: Finding[] = [];
    const proprietaer = compileGlobs(PROPRIETAERE_PFADE);
    for (const datei of files) {
      if (!proprietaer(datei.path)) {
        continue;
      }
      if (datei.text.includes(AUSNAHME)) {
        continue;
      }
      findings.push({
        rule: "layer-separation",
        path: datei.path,
        line: 0,
        message:
          "Proprietäre Schicht im öffentlichen Repositorium (E16, Schichtentrennung). " +
          "EconomyRelease, Balancing, Fahrzeugkatalog, Weltdaten und Markenassets bleiben " +
          "draußen — sie schützen zuverlässiger als jeder Lizenztext (docs/rechteschutz.md).",
      });
    }
    return findings;
  },
};
