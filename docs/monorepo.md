# Monorepo: Aufbau, Domänengrenzen, Werkzeuge

Ergebnis von **M0.2**. Beschreibt, wo Code liegt, welche Grenzen zwischen
Domänen gelten und wodurch sie durchgesetzt werden.

---

## 1. Verzeichnisse

```text
crates/                 Rust — Simulationskern, Solver, Release-Pipeline
  zugfolge-determinism/ Determinismus-Testharnisch (M0.2)
packages/               TypeScript — fachliche Bibliotheken (ab M2)
apps/                   TypeScript — Dienste und Frontend (ab M2 / M4)
spikes/                 Wegwerf-Code mit Verfallsdatum (M0.3)
tools/                  Werkzeuge für CI und Entwicklung
  guards/               die Wächter der harten Invarianten
docs/                   Spezifikation und Entscheidungen
.github/workflows/      CI
```

`packages/`, `apps/` und `spikes/` sind im pnpm-Workspace beziehungsweise in
der Wächterkonfiguration bereits vorgesehen und noch leer. Sie werden angelegt,
wenn der erste Milestone sie füllt — ein leeres Verzeichnis mit Platzhalter ist
kein Aufbau, sondern eine Behauptung.

**Sprachregel für Bezeichner:** Öffentliche Bezeichner — Typen, Funktionen,
Felder, Kommandos, Dateinamen — sind englisch und stehen in `docs/glossar.md`.
Kommentare, Fehlermeldungen, Commit-Nachrichten und Testnamen sind deutsch.
Innerhalb einer Funktion ist die Sprache frei; sie verlässt die Datei nicht.

---

## 2. Werkzeugkette

| Schicht | Werkzeug | Sperrdatei |
|---------|----------|------------|
| Rust | Cargo-Workspace, `rust-toolchain.toml` (Kanal `stable`) | `Cargo.lock` |
| TypeScript | pnpm-Workspace, Node.js 22 LTS | `pnpm-lock.yaml` |
| Tests | `cargo test`, Vitest | — |
| Lizenzen | cargo-deny (`deny.toml`), `pnpm licenses list` | — |

Beide Sperrdateien gehören ins Repositorium. Wer sie nicht erzeugen kann, weil
lokal keine Werkzeugkette installiert ist, startet den Workflow
**Artefakte erzeugen** und committet das Ergebnis.

Der Rust-Kanal ist bewusst noch nicht auf eine Patchversion gepinnt. Der Pin
kommt mit M1.12, wenn `InfraRelease`-Artefakte reproduzierbar sein müssen.

---

## 3. Domänen mit Regelbindung

Eine **Domäne** ist ein Pfadbereich, für den bestimmte Invarianten gelten. Die
Liste ist keine vollständige Karte des Repositoriums, sondern die Zuordnung
„welche Regel gilt wo". Sie steht maschinenlesbar in
`tools/guards/guards.config.json` und wird gegen dieses Dokument geprüft.

| Domäne | Pfade | Status | Was dort besonders gilt |
|--------|-------|--------|-------------------------|
| `determinism-core` | `crates/zugfolge-determinism/**` | aktiv | ganzzahlig, uhrfrei, geordnet — der Harnisch muss selbst halten, was er prüft |
| `simulation-core` | `crates/zugfolge-sim/**`, `crates/zugfolge-conflict/**`, `spikes/**` | geplant | vollständiger Kernvertrag: kein Bezahlstatus, keine Uhr, keine Datenbank |
| `path-allocation` | `crates/zugfolge-planner/**`, `packages/path-allocation/**` | geplant | Reihenfolge und Bezahlstatus beeinflussen das Ergebnis nicht (E4, `infrastruktur.md` 2) |
| `dispatch` | `crates/zugfolge-rules/**`, `packages/dispatch/**` | geplant | das Betriebsprogramm wirkt offline und für alle gleich (E2, E13) |
| `demand` | `packages/demand/**`, `crates/zugfolge-demand/**` | geplant | Nachfrage folgt dem Angebot, nie dem Vertrag des Spielers |
| `economy` | `packages/economy/**`, `packages/tender/**`, `apps/economy-service/**` | geplant | Ledger in Integer-Cent; Wertung deterministisch aus dem `EconomyRelease` |
| `infra-pipeline` | `crates/zugfolge-infra/**` | geplant | **der einzige Ort mit Gleitkommarechnung** — sie endet in ganzzahligen Fahrzeittabellen |

**Status ist kein Kommentar, sondern eine Prüfung.** Eine `aktive` Domäne muss
Dateien treffen, eine `geplante` darf keine treffen. Legt jemand
`crates/zugfolge-sim/` an, schlägt der Wächter `coverage` fehl und verlangt die
Umstellung auf `aktiv` — womit alle Regeln dieser Domäne ab dem ersten Commit
greifen. Das ist der Mechanismus, der verhindert, dass Invarianten erst
nachträglich eingezogen werden.

---

## 4. Wie die Invarianten durchgesetzt werden

| # | Invariante | Durchsetzung |
|---|-----------|--------------|
| 1 | keine inkompatiblen Belegungen derselben Konfliktressource | Property-Test ab M3 — nichts davon ist heute prüfbar |
| 2 | kein `now()` im Simulationskern | `clippy.toml` (`disallowed-methods`) und Wächter `no-wallclock` |
| 3 | keine Gleitkommazahlen im Zustand | `clippy::float_arithmetic`, `clippy::float_cmp`, Wächter `no-floats` |
| 4 | `world_id` in jeder Abfrage, jedem Index, jedem Event | Wächter `world-id` gegen SQL und Drizzle; vollständiger Nachweis in M2.2 |
| 5 | kein Payment-Tier-Feld in spielentscheidenden Domänen | Wächter `no-payment-tier` |
| 6 | kein externer Dienst im heißen Pfad | Wächter `no-db-in-core` (Netzabhängigkeiten in Kernmanifesten) |
| 7 | kein Datenbankzugriff aus dem Simulationskern | Wächter `no-db-in-core` |
| 8 | kein Import ohne dokumentierte Rechtefreigabe | M0.4 — Rechte-Gate, noch offen |

Dazu kommen zwei Regeln, die keine Invariante sind, aber dieselbe Wirkung
haben: `no-random` (Zufall nur aus benannten Substreams) und
`no-unordered-iteration` (`BTreeMap` statt `HashMap`). Ohne sie ist Invariante
„gleicher Seed ⇒ gleicher Zustand" nicht haltbar.

Vollständige Liste: `pnpm guards -- --list`.

---

## 5. Determinismus-Testharnisch

`crates/zugfolge-determinism` liefert vier Bausteine:

| Baustein | Zweck |
|----------|-------|
| `WorldSeed` + `Substream` | ein Seed je Welt und Periode, aufgeteilt in **benannte** Ströme |
| `Rng` | SplitMix64, ganzzahlig, ohne jede Gleitkommaschnittstelle |
| `StateHasher` / `StateHash` | kanonischer, plattformunabhängiger Zustands-Hash |
| `Scenario` / `run` / `assert_deterministic` | Replay zweier Läufe und Vergleich |

Die Substreams werden über ihren **Namen** abgeleitet, nicht über einen Index.
Ein neuer Strom verändert die bestehenden dadurch nicht — sonst verschöbe das
Einfügen eines Stroms rückwirkend jede bereits gelaufene Welt.

Der Golden-Master unter `crates/zugfolge-determinism/tests/golden/` ist der
eigentliche Nachweis: Die CI erzeugt ihn auf Linux **und** auf Windows und
vergleicht gegen dieselbe Datei.

---

## 6. Befehle

```bash
cargo test --workspace
```

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

```bash
pnpm install && pnpm -r build && pnpm -r test
```

```bash
pnpm guards
```

```bash
pnpm licenses list --json | node tools/guards/dist/licenses-cli.js
```

---

## 7. Was M0.2 bewusst **nicht** enthält

- Keine Datenbank, kein Schema, keine Migration — das ist M2.
- Kein Sperrzeitenmodell — das ist M0.3, und zwar als Wegwerf-Spike.
- Kein Message-Broker und kein Cache. `docs/architektur.md`: erst wenn eine
  Messung sie verlangt.
- Keine leeren Beispielpakete. Ein Gerüst, das nichts trägt, wird nicht
  gewartet und steht bei M1 im Weg.
