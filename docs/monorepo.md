# Monorepo: Aufbau, Domänengrenzen, Werkzeuge

Ergebnis von **M0.2**, fortgeschrieben in **M0.3** und **M1.1**. Beschreibt, wo
Code liegt, welche Grenzen zwischen Domänen gelten und wodurch sie durchgesetzt
werden.

---

## 1. Verzeichnisse

```text
crates/                     Rust — Simulationskern, Solver, Release-Pipeline
  zugfolge-determinism/     Determinismus-Testharnisch (M0.2)
  zugfolge-infra/           Betriebsgraph und Infra-Release-Pipeline (M1)
packages/                   TypeScript — fachliche Bibliotheken (ab M2)
apps/                       TypeScript — Dienste und Frontend (ab M2 / M4)
spikes/                     Wegwerf-Code mit Verfallsdatum
  blocking-time-staircase/  Sperrzeitentreppe und Konfliktprüfung (M0.3)
tools/                      Werkzeuge für CI und Entwicklung
  guards/                   die Wächter der harten Invarianten
docs/                       Spezifikation und Entscheidungen
.github/workflows/          CI
```

`packages/` und `apps/` sind im pnpm-Workspace bereits vorgesehen und noch
leer. Sie werden angelegt, wenn der erste Milestone sie füllt — ein leeres
Verzeichnis mit Platzhalter ist kein Aufbau, sondern eine Behauptung.

**`spikes/` ist Wegwerf-Code, und zwar mit ausgesprochenem Verfallsdatum.** Ein
Spike hat eine Frage zu beantworten und danach zu verschwinden; bleibt er
liegen, wird er zur zweiten, ungepflegten Wahrheit neben dem echten Modell.
Deshalb nennt die README jedes Spikes den Milestone, mit dem er gelöscht wird,
und kein Paket außerhalb von `spikes/` darf von einem Spike abhängen.

| Spike | Frage | Verfällt mit |
|-------|-------|--------------|
| `blocking-time-staircase` | Trägt die Konfliktprüfung über Sperrzeiten? (M0.3) | M3.1 |

Rust-Spikes sind Mitglieder des Cargo-Workspace (`members = ["crates/*",
"spikes/*"]`). Das ist Absicht: Sie laufen dadurch in derselben CI, unter
denselben Lints und unter denselben Wächtern wie der spätere Kern. Ein Spike,
der die Invarianten nicht einhalten muss, beweist über den Kern nichts.

**Sprachregel für Bezeichner:** Öffentliche Bezeichner — Typen, Funktionen,
Felder, Kommandos, Dateinamen — sind englisch und stehen in `docs/glossar.md`.
Kommentare, Fehlermeldungen, Commit-Nachrichten und Testnamen sind deutsch.
Innerhalb einer Funktion ist die Sprache frei; sie verlässt die Datei nicht.

---

## 2. Werkzeugkette

| Schicht | Werkzeug | Sperrdatei |
|---------|----------|------------|
| Rust | Cargo-Workspace, `rust-toolchain.toml` (Kanal `stable`) | `Cargo.lock` |
| TypeScript | pnpm-Workspace, pnpm 11, Node.js 24 LTS („Krypton") | `pnpm-lock.yaml` |
| Tests | `cargo test`, Vitest | — |
| Lizenzen | cargo-deny (`deny.toml`), `pnpm licenses list` | — |

Die Lizenz-Allowlist ist kurz. Was nicht darin steht, bricht die CI. Eine
einzelne Abhängigkeit lässt sich über eine **namentliche Ausnahme** in
`tools/guards/guards.config.json` zulassen — mit Paketname, genauer Lizenz und
einer Begründung, die der Wächter erzwingt und die in jedem Lizenzbericht
erscheint. Wechselt das Paket die Lizenz, greift die Ausnahme nicht mehr.

**Lieferkette:** pnpm installiert Paketversionen erst 24 Stunden nach ihrer
Veröffentlichung (`minimumReleaseAge` in `pnpm-workspace.yaml`). Kompromittierte
Releases werden erfahrungsgemäß innerhalb weniger Stunden entdeckt und entfernt;
die Wartezeit kostet fast nichts und fängt genau dieses Fenster ab.

Beide Sperrdateien gehören ins Repositorium. Wer sie nicht erzeugen kann, weil
lokal keine Werkzeugkette installiert ist, startet den Workflow
**Artefakte erzeugen** und committet das Ergebnis.

**Umgebung einrichten** — auf einem frischen Linux-Container, in WSL oder als
Setup-Skript einer Cloud-Umgebung:

```bash
bash .claude/setup.sh
```

Das Skript installiert Rust, Node und pnpm nach `$HOME`, ohne Root-Rechte, und
lädt danach **alle** Abhängigkeiten vor — geholt *und* übersetzt. Damit läuft
die Arbeit auch dann weiter, wenn das Netz nach dem Setup eingeschränkt ist.
Es ist wiederholbar; ein zweiter Lauf installiert nichts neu. Der Workflow
`setup.yml` prüft es in einem nackten Debian-Container, sobald es sich ändert.

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
| `simulation-core` | `crates/zugfolge-sim/**`, `crates/zugfolge-conflict/**`, `spikes/**` | aktiv | vollständiger Kernvertrag: kein Bezahlstatus, keine Uhr, keine Datenbank |
| `path-allocation` | `crates/zugfolge-planner/**`, `packages/path-allocation/**` | geplant | Reihenfolge und Bezahlstatus beeinflussen das Ergebnis nicht (E4, `infrastruktur.md` 2) |
| `dispatch` | `crates/zugfolge-rules/**`, `packages/dispatch/**` | geplant | das Betriebsprogramm wirkt offline und für alle gleich (E2, E13) |
| `demand` | `packages/demand/**`, `crates/zugfolge-demand/**` | geplant | Nachfrage folgt dem Angebot, nie dem Vertrag des Spielers |
| `economy` | `packages/economy/**`, `packages/tender/**`, `apps/economy-service/**` | geplant | Ledger in Integer-Cent; Wertung deterministisch aus dem `EconomyRelease` |
| `infra-pipeline` | `crates/zugfolge-infra/**` | aktiv | **der einzige Ort mit Gleitkommarechnung** — sie endet in ganzzahligen Fahrzeittabellen |

**Status ist kein Kommentar, sondern eine Prüfung.** Eine `aktive` Domäne muss
Dateien treffen, eine `geplante` darf keine treffen. Legt jemand
`crates/zugfolge-sim/` an, schlägt der Wächter `coverage` fehl und verlangt die
Umstellung auf `aktiv` — womit alle Regeln dieser Domäne ab dem ersten Commit
greifen. Das ist der Mechanismus, der verhindert, dass Invarianten erst
nachträglich eingezogen werden. Genau so ist `simulation-core` in M0.3 aktiv
geworden: Der Spike unter `spikes/` fiel in ihre Pfade, und der Wächter hat den
Statuswechsel eingefordert, bevor die erste Sperrzeit gerechnet wurde. Und
genauso `infra-pipeline` in M1.1, mit dem ersten Domänenmodell des
Betriebsgraphen.

**`infra-pipeline` ist die einzige Domäne ohne `no-floats`** — und das ist der
Grund, warum sie überhaupt eine eigene ist. Die Fahrdynamik rechnet dort
einmalig mit Gleitkomma und gibt ganzzahlige Fahrzeittabellen aus (M1.10). Was
sie **liefert**, ist ganzzahlig; das Domänenmodell aus M1.1 kommt dabei ohne
eine einzige Gleitkommazahl aus, bis hin zu 16,7 Hz in Milli-Hertz.

---

## 4. Wie die Invarianten durchgesetzt werden

| # | Invariante | Durchsetzung |
|---|-----------|--------------|
| 1 | keine inkompatiblen Belegungen derselben Konfliktressource | seit M0.3 im Spike gegen eine zweite, unabhängig geschriebene Prüfung getestet (`spikes/blocking-time-staircase/tests/invariante.rs`); der eigentliche Property-Test folgt mit M3 |
| 2 | kein `now()` im Simulationskern | `clippy.toml` (`disallowed-methods`) und Wächter `no-wallclock` |
| 3 | keine Gleitkommazahlen im Zustand | `clippy::float_arithmetic`, `clippy::float_cmp`, Wächter `no-floats` |
| 4 | `world_id` in jeder Abfrage, jedem Index, jedem Event | Wächter `world-id` gegen SQL und Drizzle; vollständiger Nachweis in M2.2 |
| 5 | kein Payment-Tier-Feld in spielentscheidenden Domänen | Wächter `no-payment-tier` |
| 6 | kein externer Dienst im heißen Pfad | Wächter `no-db-in-core` (Netzabhängigkeiten in Kernmanifesten) |
| 7 | kein Datenbankzugriff aus dem Simulationskern | Wächter `no-db-in-core` |
| 8 | kein Import ohne dokumentierte Rechtefreigabe | Wächter `rights-gate` gegen das Quellenregister (M0.4, `docs/rechte.md`) |

Dazu kommen zwei Regeln, die keine Invariante sind, aber dieselbe Wirkung
haben: `no-random` (Zufall nur aus benannten Substreams) und
`no-unordered-iteration` (`BTreeMap` statt `HashMap`). Ohne sie ist Invariante
„gleicher Seed ⇒ gleicher Zustand" nicht haltbar.

Und der Wächter `layer-separation` (E16, M0.5) hält die proprietären Schichten —
`EconomyRelease`, Balancing, Fahrzeugkatalog, Weltdaten, Markenassets — aus dem
öffentlichen Baum. `.gitignore` ist die Bitte, der Wächter der Riegel. Herleitung
in `docs/rechteschutz.md`.

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
