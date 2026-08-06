# Rust-Domäne — Simulationskern, Solver, Release-Pipeline

Gilt für alles unter `crates/`. Ergänzt die Wurzel-`CLAUDE.md`, hebt sie nie
auf.

## Was hier hineingehört

Sperrzeiten, Fahrdynamik, Konfliktprüfung, Trassen-Solver, Regel-Engine,
regionale Single-Writer, Infra- und Economy-Release-Pipeline. Alles, wofür
`docs/architektur.md` Abschnitt 2 den Rust-Schnitt begründet: nationale
Rechenlast, bitgenaue Reproduzierbarkeit über Jahre, kaum veränderliches
Regelwerk.

## Was hier nicht hineingehört

Verträge, Ausschreibungen, Märkte, Postfach, Entitlements, Odoo-Bridge,
Delta-Fanout. Das sind Game-Services in TypeScript — sie ändern sich ständig
und haben kein Rechenproblem.

## Der Vertrag des Kerns

> Kommandos rein, Events raus. Kein Datenbankzugriff, keine Uhr, kein Netz.

Ein Crate, das eine Datenbank, eine Uhr oder einen HTTP-Client anfasst, ist per
Definition kein Kernbestandteil. Der Wächter `no-db-in-core` prüft die
Manifeste, `clippy.toml` die Aufrufe.

## Regeln, die der Compiler hält

| Regel | Durchsetzung |
|-------|--------------|
| kein `unsafe` | `unsafe_code = "forbid"` in `Cargo.toml` |
| keine Gleitkommazahl im Zustand | `clippy::float_arithmetic`, `clippy::float_cmp`, Wächter `no-floats` |
| kein `now()` | `clippy.toml` → `disallowed-methods` |
| kein `HashMap`/`HashSet` im Zustand | `clippy.toml` → `disallowed-types` |
| kein stiller Zahlenverlust | `clippy::cast_possible_truncation` und Geschwister auf `deny` |

Eine Ausnahme ist zulässig — aber nur als `#[allow(..., reason = "...")]` an
der engstmöglichen Stelle, nie durch Streichen der Regel. Die Fahrdynamik in
der Release-Pipeline ist der vorgesehene Fall: Sie rechnet **einmalig** mit
Gleitkomma und gibt ganzzahlige Fahrzeittabellen aus.

## Neues Crate anlegen

1. `crates/zugfolge-<name>/Cargo.toml` mit `…workspace = true` für Version,
   Edition, Lizenz und `[lints] workspace = true`.
2. Bezeichner englisch, Kommentare und Fehlermeldungen deutsch. Fachbegriffe
   nach `docs/glossar.md` — dort steht die verbindliche Zuordnung.
3. Zustandsrelevantes Modell? Dann `DeterministicModel` aus
   `zugfolge-determinism` implementieren und einen Golden-Master anlegen.
4. In `docs/monorepo.md` eintragen. Der Wächter `coverage` schlägt sonst an.

## Tests

- Kein Beitrag ohne einen Test, der ohne ihn fehlschlägt.
- Zustandsmodelle bekommen einen Determinismus-Test **und** einen
  Golden-Master. Ein geänderter Golden-Master braucht eine Begründung im
  Commit — er ist entweder eine bewusste Regeländerung oder ein Fehler.
- Golden-Master neu erzeugen: `ZUGFOLGE_GOLDEN_UPDATE=1 cargo test`.
- Invariante 1 („keine zwei Züge auf derselben Konfliktressource") gehört ab
  M3 in einen Property-Test, nicht in Beispieltests.
