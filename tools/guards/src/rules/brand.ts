/**
 * Sprachregelung: Vergleichbare Verkehrssimulationen werden generisch benannt,
 * nicht namentlich (`CLAUDE.md`, Sprachregelungen).
 *
 * Das erzeugt ein hübsches Problem: Eine Liste verbotener Namen wäre selbst
 * eine Namensnennung — die Regel verstieße gegen sich selbst. Deshalb steht in
 * der Konfiguration nicht der Name, sondern sein SHA-256-Hash. Der Wächter
 * kann prüfen, ohne dass irgendwo im Repositorium steht, wonach er sucht.
 *
 * Einen Namen aufnehmen:
 *
 * ```text
 * pnpm --filter @zugfolge/guards run guards -- brand:add <name>
 * ```
 *
 * Die Liste ist absichtlich leer ausgeliefert. Sie wird lokal gefüllt, wenn
 * sie gebraucht wird.
 */

import { createHash } from "node:crypto";

import type { Finding, GuardConfig, Rule, SourceFile } from "../types.js";

/** Kürzere Wörter werden nicht geprüft — zu viele zufällige Treffer. */
const MINDESTLAENGE = 4;

const WORTGRENZE = /[\p{L}][\p{L}\p{N}]*/gu;

/** Der Hash eines Wortes, kleingeschrieben. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token.toLowerCase(), "utf8").digest("hex");
}

/** Prüft, ob ein namentlich verbotener Begriff im Text vorkommt. */
export const brandRule: Rule = {
  id: "no-brand-citation",
  title: "Keine Namensnennung vergleichbarer Simulationen",
  scope: "repository",
  check(files: readonly SourceFile[], config: GuardConfig): Finding[] {
    if (config.brandTokenHashes.length === 0) {
      return [];
    }
    const verboten = new Set(config.brandTokenHashes.map((hash) => hash.toLowerCase()));
    const befunde: Finding[] = [];

    for (const datei of files) {
      const zeilen = datei.text.split("\n");
      for (let index = 0; index < zeilen.length; index += 1) {
        for (const treffer of (zeilen[index] ?? "").matchAll(WORTGRENZE)) {
          const wort = treffer[0];
          if (wort.length < MINDESTLAENGE || !verboten.has(hashToken(wort))) {
            continue;
          }
          befunde.push({
            rule: "no-brand-citation",
            path: datei.path,
            line: index + 1,
            message:
              "Namentliche Nennung einer vergleichbaren Simulation (Sprachregelung). " +
              "Generisch umschreiben. Der Name steht bewusst nicht in dieser Meldung.",
          });
        }
      }
    }

    return befunde;
  },
};
