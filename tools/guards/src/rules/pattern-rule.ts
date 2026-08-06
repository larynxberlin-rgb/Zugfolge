/**
 * Der gemeinsame Kern aller Musterregeln.
 *
 * Eine Musterregel liest zeilenweise und meldet, was sie trifft. Das ist
 * grob — und genau deshalb geeignet: Sie soll nicht klug sein, sondern
 * unbestechlich. Wer eine Ausnahme braucht, schreibt sie sichtbar in den Code:
 *
 * ```text
 * // guards:allow no-floats — Fahrdynamik rechnet einmalig in der Pipeline
 * ```
 */

import type { Finding, Rule, RuleScope, SourceFile } from "../types.js";

/** Ein einzelnes verbotenes Muster. */
export interface PatternCheck {
  /** Wird je Zeile geprüft; ohne `g`-Flag. */
  readonly regex: RegExp;
  /** Was falsch ist und warum. */
  readonly message: string;
  /** Trifft dieses Muster ebenfalls, gilt die Zeile als zulässig. */
  readonly allowIf?: RegExp;
}

/** Beschreibung einer Musterregel. */
export interface PatternRuleSpec {
  readonly id: string;
  readonly title: string;
  readonly scope: RuleScope;
  /** Nur Dateien mit diesen Endungen; leer bedeutet alle. */
  readonly extensions?: readonly string[];
  /** Nur Dateien mit diesen Namen; leer bedeutet alle. */
  readonly fileNames?: readonly string[];
  readonly checks: readonly PatternCheck[];
}

function passtAufDatei(datei: SourceFile, spec: PatternRuleSpec): boolean {
  const endungen = spec.extensions ?? [];
  const namen = spec.fileNames ?? [];
  if (endungen.length === 0 && namen.length === 0) {
    return true;
  }
  const name = datei.path.slice(datei.path.lastIndexOf("/") + 1);
  return namen.includes(name) || endungen.some((endung) => datei.path.endsWith(endung));
}

/** Ob die Zeile — oder die Zeile davor — eine sichtbare Ausnahme trägt. */
export function isExempt(zeilen: readonly string[], index: number, regelId: string): boolean {
  const marke = `guards:allow ${regelId}`;
  return (zeilen[index] ?? "").includes(marke) || (zeilen[index - 1] ?? "").includes(marke);
}

/** Baut eine Regel aus ihrer Beschreibung. */
export function patternRule(spec: PatternRuleSpec): Rule {
  return {
    id: spec.id,
    title: spec.title,
    scope: spec.scope,
    check(files: readonly SourceFile[]): Finding[] {
      const befunde: Finding[] = [];
      for (const datei of files) {
        if (!passtAufDatei(datei, spec)) {
          continue;
        }
        const zeilen = datei.text.split("\n");
        for (let index = 0; index < zeilen.length; index += 1) {
          const zeile = zeilen[index] ?? "";
          for (const check of spec.checks) {
            if (!check.regex.test(zeile)) {
              continue;
            }
            if (check.allowIf?.test(zeile)) {
              continue;
            }
            if (isExempt(zeilen, index, spec.id)) {
              continue;
            }
            befunde.push({
              rule: spec.id,
              path: datei.path,
              line: index + 1,
              message: check.message,
            });
          }
        }
      }
      return befunde;
    },
  };
}
