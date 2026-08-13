/**
 * Die Musterregeln — je eine harte Invariante aus `AGENTS.md`.
 *
 * Diese Datei liest kein Wächter: Sie enthält die verbotenen Muster selbst und
 * würde jede Prüfung sofort auslösen. Sie steht deshalb in `ignore`
 * (`guards.config.json`) und ist über `pattern-rules.test.ts` abgedeckt.
 */

import { patternRule } from "./pattern-rule.js";
import type { Rule } from "../types.js";

const RUST = [".rs"] as const;
const MANIFESTE = ["Cargo.toml", "package.json"] as const;

/**
 * Invariante 5 — kein Payment-Tier-Feld in Planner, Nachfrage, Wirtschaft,
 * Trassenvergabe oder Live-Disposition.
 *
 * Die Regel gilt bewusst **nicht** überall: Entitlements sind in der
 * Monetarisierung (M13.3) genau richtig. Verboten ist, dass der Bezahlstatus
 * in eine spielerische Entscheidung hineinreicht. Welche Domänen das sind,
 * steht in `guards.config.json`.
 */
const keinPaymentTier = patternRule({
  id: "no-payment-tier",
  title: "Kein Bezahlstatus in spielentscheidenden Domänen",
  scope: "domains",
  checks: [
    {
      regex: /\b(payment|billing|subscription|plan|pricing)[_-]?(tier|level|rank)\b/i,
      message:
        "Bezahlstatus in einer spielentscheidenden Domäne (Invariante 5). " +
        "Der Bezahlstatus darf Trassenvergabe, Nachfrage und Disposition nicht berühren.",
    },
    {
      regex: /\b(is[_-]?(premium|paying|subscriber|plus)|has[_-]?(plus|premium)|paywall)\b/i,
      message:
        "Bezahlstatus in einer spielentscheidenden Domäne (Invariante 5). " +
        "Fähigkeiten werden über Spielzustand entschieden, nie über den Vertrag des Spielers.",
    },
    {
      regex: /\b(entitlement\w*|premium[_-]?only|plus[_-]?only|zugfolge[_-]?plus)\b/i,
      message:
        "Entitlements gehören in die Monetarisierung (M13.3), nicht in diese Domäne " +
        "(Invariante 5).",
    },
  ],
});

/** Invariante 3 — keine Gleitkommazahlen im zustandsrelevanten Pfad. */
const keineGleitkommazahlen = patternRule({
  id: "no-floats",
  title: "Keine Gleitkommazahlen im Zustand",
  scope: "domains",
  extensions: RUST,
  checks: [
    {
      regex: /\bf(32|64)\b/,
      message:
        "Gleitkommazahl im zustandsrelevanten Pfad (Invariante 3). " +
        "Geld als i64 Cent, Zeiten als Sekunden, Positionen als Millimeter. " +
        "Ausnahme nur mit 'guards:allow no-floats — <Begründung>'.",
    },
  ],
});

/** Invariante 2 — kein `now()` im Simulationskern. */
const keineUhr = patternRule({
  id: "no-wallclock",
  title: "Keine gelesene Uhrzeit im Kern",
  scope: "domains",
  checks: [
    {
      regex: /\b(SystemTime|Instant)::now\b|\b(Utc|Local)::now\b/,
      message:
        "Gelesene Uhrzeit im Simulationskern (Invariante 2). " +
        "Simulationszeit ist ein expliziter Wert — SimTime aus zugfolge-determinism.",
    },
    {
      regex: /\bDate\.now\s*\(|\bnew Date\s*\(\s*\)|\bperformance\.now\s*\(/,
      message:
        "Gelesene Uhrzeit in einer zustandsrelevanten Domäne (Invariante 2). " +
        "Der Zeitpunkt gehört als Wert in das Kommando.",
    },
  ],
});

/** Determinismus — Zufall kommt ausschließlich aus benannten Substreams. */
const keinUngesaeterZufall = patternRule({
  id: "no-random",
  title: "Kein ungesäter Zufall",
  scope: "domains",
  checks: [
    {
      regex: /\bMath\.random\s*\(|\bcrypto\.(randomUUID|getRandomValues)\s*\(/,
      message:
        "Ungesäter Zufall. Jeder Zufall kommt aus einem benannten Substream des " +
        "Weltseeds — sonst ist die Welt nicht wiederholbar und nachträglich nicht prüfbar.",
    },
    {
      regex: /\brand::(random|thread_rng)\b|\bthread_rng\s*\(/,
      message:
        "Ungesäter Zufall. WorldSeed::substream verwenden (zugfolge-determinism).",
    },
  ],
});

/** Determinismus — Iterationsreihenfolge muss reproduzierbar sein. */
const keineUngeordneteIteration = patternRule({
  id: "no-unordered-iteration",
  title: "Keine ungeordneten Mengen im Zustand",
  scope: "domains",
  extensions: RUST,
  checks: [
    {
      // Nur echte Verwendungen, nicht die Erwähnung im Fließtext: `HashMap<`,
      // `HashMap::new` oder `collections::HashMap`.
      regex: /\bHash(Map|Set)\s*[<:]|collections::Hash(Map|Set)\b/,
      message:
        "HashMap/HashSet im zustandsrelevanten Pfad: Die Iterationsreihenfolge ist " +
        "nicht reproduzierbar. BTreeMap/BTreeSet verwenden.",
    },
  ],
});

/** Invariante 7 — kein Datenbankzugriff aus dem Simulationskern. */
const keineDatenbankImKern = patternRule({
  id: "no-db-in-core",
  title: "Kein Datenbank- oder Netzzugriff im Kern",
  scope: "domains",
  fileNames: MANIFESTE,
  checks: [
    {
      regex: /^\s*"?(sqlx|diesel|sea-orm|tokio-postgres|postgres|deadpool-postgres|drizzle-orm|pg)"?\s*[:=]/,
      message:
        "Datenbankabhängigkeit im Kern (Invariante 7). " +
        "Kommandos rein, Events raus — die Persistenz liegt bei den Game-Services.",
    },
    {
      regex: /^\s*"?(reqwest|hyper|axum|ureq|undici|node-fetch|got|axios)"?\s*[:=]/,
      message:
        "Netzabhängigkeit im Kern (Invariante 6): kein externer Dienst im heißen Pfad.",
    },
  ],
});

/** E16 — Lizenzkennung und Selbstbezeichnung. */
const sprachregelungen = patternRule({
  id: "language",
  title: "Sprachregelungen und Lizenzkennung",
  scope: "repository",
  checks: [
    {
      regex: /^\s*license\s*=\s*"(?!LicenseRef-PolyForm-Shield-1\.0\.0")/,
      message:
        "Fremde Lizenzkennung in einem eigenen Manifest (E16). " +
        'Richtig ist "LicenseRef-PolyForm-Shield-1.0.0" oder license.workspace = true.',
    },
    {
      regex: /"license"\s*:\s*"(?!LicenseRef-PolyForm-Shield-1\.0\.0")/,
      message:
        "Fremde Lizenzkennung in einem eigenen Manifest (E16). " +
        'Richtig ist "LicenseRef-PolyForm-Shield-1.0.0".',
    },
    {
      regex: /\b(Zugfolge|[Dd]as Projekt|[Dd]ieses Projekt)\b[^.\n]{0,60}\bOpen[-\s]Source\b/,
      allowIf: /\b(nicht|kein\w*|niemals|statt|anders als)\b/i,
      message:
        "Das Projekt heißt Source Available, niemals Open Source (E16, Sprachregelung). " +
        "Über die Open-Source-Definition zu schreiben ist erlaubt — sich so zu nennen nicht.",
    },
  ],
});

/** Alle Musterregeln in fester Reihenfolge. */
export const PATTERN_RULES: readonly Rule[] = [
  keinPaymentTier,
  keineGleitkommazahlen,
  keineUhr,
  keinUngesaeterZufall,
  keineUngeordneteIteration,
  keineDatenbankImKern,
  sprachregelungen,
];
