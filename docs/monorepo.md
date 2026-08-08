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
  zugfolge-conflict/        Sperrzeiten, Belegungsprofile, Konfliktprüfung (M3.1–M3.3), Rahmenverträge (M3.8)
  zugfolge-planner/         Trassen-Planner (M3.4), PlanningRun, Fahrplanperiode, Ad-hoc-Trassen (M3.5–M3.7)
  zugfolge-sim/             Ereigniskern, TrainRun, Regionsübergabe, Replay und Livemap-Protokoll (M4)
packages/                   TypeScript — fachliche Bibliotheken (ab M2)
  db/                       Postgres-Zugriff über Drizzle, Wurzel der Weltisolation (M2.2)
  identity/                 Konten, Rollen, Weltzugänge; Keycloak-Verifikation (M2.1)
  operators/                EVU: Gründung, Stammdaten, Zuordnung zu Welt und Konto (M2.3)
  economy/                  Ledger-Kern: Integer-Cent, unveränderlich, ausgeglichen (M2.4)
  mailbox/                  Postfach-Grundgerüst: Nachrichten, Fristen, Quittierung (M2.5)
  privacy/                  Datenschutz: Auskunft, Löschung, Aufbewahrungsfristen (M2.6)
  health/                   Health-Check-Vertrag und Aggregation für Status-/Monitoringdienste, Grundlage für M9.5
  livemap/                  Weltisolierter Snapshot-/Delta-Fanout (M4.6)
apps/                       TypeScript — Dienste und Frontend (ab M2 / M4)
  game-api/                 Fastify-Dienst: Authentifizierung, Weltzugang, EVU, Ledger, Postfach, Datenschutz (M2)
  livemap/                  Vite-Frontend: öffentliche Zuglage, Zuglaufansicht und Delta-Interpolation (M4)
spikes/                     Wegwerf-Code mit Verfallsdatum — derzeit leer
tools/                      Werkzeuge für CI und Entwicklung
  guards/                   die Wächter der harten Invarianten
  load/                     äußerer Lastmessharnisch für 180.000 Fahrten und ≥2 Mio. Ereignisse (M4.11)
  tiles/                    reproduzierbare GeoJSON-→PMTiles-Pipeline und Layerspezifikation (M4.7)
docs/                       Spezifikation und Entscheidungen
.github/workflows/          CI
```

`packages/` und `apps/` füllen sich seit **M2**: `packages/db` trägt das
gemeinsame Drizzle-Schema — `worlds` als Wurzel der Mandantentrennung, das
append-only Event-Log `domain_events`, Weltzugang, Konto und Kontorolle
(M2.1) sowie, seit M2.3–M2.5, `operators`, die drei Ledger-Tabellen und
`mailbox_messages` —, den Postgres-Client und das weltgebundene Repository
des Event-Logs (Abschnitt 3 und 4). Darüber bündeln vier fachliche Pakete je
eine Domäne: `packages/identity` (M2.1) Keycloak-Tokenverifikation, Konto und
Rolle; `packages/operators` (M2.3) die EVU-Entität; `packages/economy`
(M2.4) den Ledger-Kern; `packages/mailbox` (M2.5) das Postfach; und
`packages/privacy` (M2.6) Auskunft, Löschung und Aufbewahrungsfristen quer
über die anderen vier. `apps/game-api` verdrahtet alle fünf zu einem
Fastify-Dienst. Siehe [`weltgeruest.md`](weltgeruest.md).

Quer zu jedem einzelnen Milestone liegt `packages/health`: der
Health-Check-Vertrag, gegen den jedes Paket meldet, ob es erreichbar ist.
`packages/db` (M2.2) trägt darauf die Datenbankprüfung, `apps/game-api`
aggregiert sie unter `GET /health/ready`. Kein eigener Milestone, sondern die
früh gelegte Grundlage für die Betriebsreife aus M9.5 — siehe
[`architektur.md`](architektur.md) Abschnitt 6. Weitere
Unterverzeichnisse entstehen, sobald ein Milestone sie tatsächlich füllt —
ein leeres Verzeichnis mit Platzhalter ist kein Aufbau, sondern eine
Behauptung.

`crates/` ist seit **M3** um zwei Crates gewachsen, und der Schnitt zwischen
ihnen ist kein Zufall: `zugfolge-conflict` beantwortet, ob eine Trasse
**zulässig** ist (Sperrzeiten M3.1, Belegungsprofile M3.2, Konfliktprüfung
M3.3), `zugfolge-planner`, welche Trasse **gut** ist (M3.4). Das sind zwei
Fragen und deshalb zwei Crates — der Spike aus M0.3 hatte genau das als Befund
hinterlassen. Sie liegen auch in verschiedenen Wächterdomänen (`simulation-core`
und `path-allocation`, Abschnitt 3), weil für die Trassenvergabe eine Regel
gilt, die für den Prüfer keinen Sinn ergibt: Reihenfolge und Bezahlstatus
dürfen das Ergebnis nicht beeinflussen. Siehe
[`infrastruktur.md`](infrastruktur.md) 6 bis 9.

**`spikes/` ist Wegwerf-Code, und zwar mit ausgesprochenem Verfallsdatum.** Ein
Spike hat eine Frage zu beantworten und danach zu verschwinden; bleibt er
liegen, wird er zur zweiten, ungepflegten Wahrheit neben dem echten Modell.
Deshalb nennt die README jedes Spikes den Milestone, mit dem er gelöscht wird,
und kein Paket außerhalb von `spikes/` darf von einem Spike abhängen.

| Spike | Frage | Verfällt mit |
|-------|-------|--------------|
| — | derzeit ist kein Spike offen | — |

`blocking-time-staircase` (M0.3) ist **mit M3.1 verfallen und gelöscht**, wie
seine README es angekündigt hatte. Was er beantwortet hat, steht seither nicht
mehr in ihm, sondern im Modell: das Ressourcenmodell, das beide Konfliktarten
trägt, die halboffenen Intervalle und der von sich aus erklärbare Befund —
alles in `crates/zugfolge-conflict`. Seine offenen Punkte sind ebenfalls
abgearbeitet: der Bahnhofskopf über die Ausschlussmengen aus M1.7, die
Fahrdynamik über M1.10, die betrieblich richtige Auflösung über den Planner aus
M3.4.

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

Der Rust-Kanal ist mit **M1.12 auf eine Patchversion gepinnt**
(`rust-toolchain.toml`): Ein `InfraRelease` ist ein unveränderliches,
reproduzierbares Artefakt, und seine Prüfsumme darf nicht an der Toolchain
hängen. rustup installiert die gepinnte Version samt Komponenten selbsttätig;
der Golden-Master des `InfraRelease` wird gegen genau sie erzeugt, auf Linux und
Windows. Ein Wechsel ist eine bewusste Entscheidung und im Commit zu begründen.

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
| `path-allocation` | `crates/zugfolge-planner/**`, `packages/path-allocation/**` | aktiv | Reihenfolge und Bezahlstatus beeinflussen das Ergebnis nicht (E4, `infrastruktur.md` 2) |
| `dispatch` | `crates/zugfolge-rules/**`, `packages/dispatch/**` | geplant | das Betriebsprogramm wirkt offline und für alle gleich (E2, E13) |
| `demand` | `packages/demand/**`, `crates/zugfolge-demand/**` | geplant | Nachfrage folgt dem Angebot, nie dem Vertrag des Spielers |
| `economy` | `packages/economy/**`, `packages/tender/**`, `apps/economy-service/**` | aktiv | Ledger in Integer-Cent (M2.4); Wertung deterministisch aus dem `EconomyRelease` (M6) |
| `infra-pipeline` | `crates/zugfolge-infra/**` | aktiv | **der einzige Ort mit Gleitkommarechnung** — sie endet in ganzzahligen Fahrzeittabellen |
| `world-isolation` | `packages/db/**` | aktiv | Postgres-Zugriff der Game-Services; Wurzel der Weltisolation — `worlds`, das Event-Log und das weltgebundene Repository (M2.2) |

**Status ist kein Kommentar, sondern eine Prüfung.** Eine `aktive` Domäne muss
Dateien treffen, eine `geplante` darf keine treffen. Legt jemand
`crates/zugfolge-sim/` an, schlägt der Wächter `coverage` fehl und verlangt die
Umstellung auf `aktiv` — womit alle Regeln dieser Domäne ab dem ersten Commit
greifen. Das ist der Mechanismus, der verhindert, dass Invarianten erst
nachträglich eingezogen werden. Genau so ist `simulation-core` in M0.3 aktiv
geworden: Der Spike unter `spikes/` fiel in ihre Pfade, und der Wächter hat den
Statuswechsel eingefordert, bevor die erste Sperrzeit gerechnet wurde. Und
genauso `path-allocation` in M3.4: Der erste Commit in
`crates/zugfolge-planner` hat den Wächter ausgelöst, bevor der erste
Trassenkandidat entstanden war. Genauso
`infra-pipeline` in M1.1, mit dem ersten Domänenmodell des Betriebsgraphen —
und `economy` in M2.4, mit dem ersten Code des Ledger-Kerns in
`packages/economy`.

**`infra-pipeline` ist die einzige Domäne ohne `no-floats`** — und das ist der
Grund, warum sie überhaupt eine eigene ist. Die Fahrdynamik rechnet dort
einmalig mit Gleitkomma und gibt ganzzahlige Fahrzeittabellen aus (M1.10). Was
sie **liefert**, ist ganzzahlig; das Domänenmodell aus M1.1 kommt dabei ohne
eine einzige Gleitkommazahl aus, bis hin zu 16,7 Hz in Milli-Hertz.

---

## 4. Wie die Invarianten durchgesetzt werden

| # | Invariante | Durchsetzung |
|---|-----------|--------------|
| 1 | keine inkompatiblen Belegungen derselben Konfliktressource | seit M3.3 als Property-Test über 400 gestreute Lagen, geprüft gegen eine zweite, unabhängig geschriebene Prüfung (`crates/zugfolge-conflict/tests/invariante.rs`); das Belegungsbuch hält sie über `try_insert` **durch Konstruktion** |
| 2 | kein `now()` im Simulationskern | `clippy.toml` (`disallowed-methods`) und Wächter `no-wallclock` |
| 3 | keine Gleitkommazahlen im Zustand | `clippy::float_arithmetic`, `clippy::float_cmp`, Wächter `no-floats` |
| 4 | `world_id` in jeder Abfrage, jedem Index, jedem Event | Wächter `world-id` gegen SQL und Drizzle, prüft Tabelle **und** Index; dazu das weltgebundene Repository in `packages/db` und der Isolationstest gegen eine echte Datenbank (M2.2) |
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
