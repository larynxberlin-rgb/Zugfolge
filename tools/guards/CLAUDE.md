# Wächter — Domänenanleitung

Gilt für `tools/guards`. Ergänzt die Wurzel-`CLAUDE.md`, hebt sie nie auf.

## Zweck

Die harten Invarianten aus `CLAUDE.md` prüfen, **soweit kein Compiler sie
sieht**. Was Rust oder Clippy halten können, gehört nach `clippy.toml` und
`Cargo.toml` — nicht hierher. Hier steht nur, was sprachübergreifend, über
Manifeste hinweg oder gegen Dokumentation geprüft werden muss.

## Aufbau

| Datei | Inhalt |
|-------|--------|
| `guards.config.json` | die Domänenkarte: welche Pfade, welcher Status, welche Regeln |
| `src/rules/pattern-rules.ts` | die Musterregeln — enthält die verbotenen Muster selbst |
| `src/rules/world-id.ts` | Invariante 4 gegen SQL-Migrationen und Drizzle-Schemata |
| `src/rules/glossary.ts` | Aufbau und Vollständigkeit von `docs/glossar.md` |
| `src/rules/coverage.ts` | die Regel, die verhindert, dass die Konfiguration verrottet |
| `src/rules/brand.ts` | Namensnennung, geprüft über Hashes statt über eine Namensliste |
| `src/licenses.ts` | Auswertung von `pnpm licenses list --json` |

## Zwei Eigenheiten, die Absicht sind

**`src/rules/` wird von den Wächtern nicht gelesen.** Diese Dateien enthalten
die verbotenen Muster im Klartext und würden jede Prüfung sofort auslösen. Sie
stehen deshalb in `ignore`. Ihr Ersatz ist Testabdeckung: Jede Regel hat einen
Fixture-Test, der ohne sie fehlschlägt.

**Die Namensregel kennt keine Namen.** Eine Liste verbotener Marken wäre selbst
eine Namensnennung. In der Konfiguration stehen deshalb SHA-256-Hashes.
Aufnehmen mit `pnpm --filter @zugfolge/guards run guards -- brand:add <wort>`.

## Eine Regel ergänzen

1. Musterregel? Dann einen Eintrag in `PATTERN_RULES` — mehr nicht.
2. Sonst ein eigenes Modul mit `Rule`-Schnittstelle und Eintrag in
   `src/rules/index.ts`.
3. Zwei Tests: einer, der einen echten Verstoß meldet, und einer, der einen
   ähnlich aussehenden, aber zulässigen Fall in Ruhe lässt. Ohne den zweiten
   wird die Regel bei der ersten Falschmeldung abgeschaltet.
4. Die Regel in die betroffenen Domänen in `guards.config.json` eintragen.
   `coverage` meldet Tippfehler in Regelkennungen.

## Grenzen

Ein Wächter ist ein Zeilenleser, kein Übersetzer. Er wird Muster übersehen und
gelegentlich danebenliegen. Für den Fall gibt es die sichtbare Ausnahme:

```text
// guards:allow no-floats — Fahrdynamik rechnet einmalig in der Pipeline
```

Sie steht im Code, nicht in der Konfiguration — damit sie im Review auffällt.
Eine Regel abzuschalten, weil sie stört, ist der einzige Weg, auf dem diese
Prüfungen wertlos werden.
