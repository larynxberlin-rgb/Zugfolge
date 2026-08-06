/** Grundtypen der Wächter. */

/** Eine eingelesene Datei des Arbeitsbaums. */
export interface SourceFile {
  /** Pfad relativ zur Repositoriumswurzel, immer mit `/`. */
  readonly path: string;
  /** Vollständiger Inhalt. */
  readonly text: string;
}

/** Ein Regelverstoß. */
export interface Finding {
  /** Kennung der Regel, die angeschlagen hat. */
  readonly rule: string;
  /** Pfad relativ zur Repositoriumswurzel. */
  readonly path: string;
  /** Zeilennummer ab 1; `0`, wenn der Befund die ganze Datei betrifft. */
  readonly line: number;
  /** Was falsch ist — und warum es falsch ist. */
  readonly message: string;
}

/**
 * Wo eine Regel greift.
 *
 * - `domains`: nur in den Domänen, die die Regel in `guards.config.json`
 *   ausdrücklich führen. So bleibt `entitlement` in der Monetarisierung
 *   erlaubt und in der Trassenvergabe verboten.
 * - `repository`: im ganzen Arbeitsbaum.
 */
export type RuleScope = "domains" | "repository";

/** Eine Domäne des Monorepos mit ihren Grenzen. */
export interface Domain {
  readonly id: string;
  readonly title: string;
  /** `active`, sobald Code existiert; vorher `planned`. */
  readonly status: "active" | "planned";
  /** Glob-Muster relativ zur Wurzel. */
  readonly paths: readonly string[];
  /** Kennungen der Regeln, die in dieser Domäne gelten. */
  readonly rules: readonly string[];
}

/** Inhalt von `guards.config.json`. */
export interface GuardConfig {
  readonly domains: readonly Domain[];
  /**
   * SHA-256-Hashes kleingeschriebener Wörter, die nicht im Repositorium
   * vorkommen dürfen — siehe Regel `no-brand-citation`.
   */
  readonly brandTokenHashes: readonly string[];
  /** Lizenzen, die in Abhängigkeiten zulässig sind (SPDX-Kennungen). */
  readonly allowedLicenses: readonly string[];
  /** Lizenzen, die ausdrücklich unzulässig sind. */
  readonly deniedLicenses: readonly string[];
  /** Verzeichnisse und Dateien, die kein Wächter liest. */
  readonly ignore: readonly string[];
}

/** Eine Regel. */
export interface Rule {
  readonly id: string;
  readonly title: string;
  readonly scope: RuleScope;
  check(files: readonly SourceFile[], config: GuardConfig): Finding[];
}
