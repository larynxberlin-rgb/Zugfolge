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
  zugfolge-planning-runtime/ Persistierbarer PlanningRun-Single-Writer und Bildfahrplanprojektion (M3.10)
  zugfolge-planning-runtime-napi/ Schmale napi-rs-Grenze des Planning-Single-Writers
  zugfolge-sim/             Ereigniskern, TrainRun, Regionsübergabe, Replay und Livemap-Protokoll (M4)
  zugfolge-sim-runtime/     Persistierbare, versionierte Single-Writer-/Delta-Grenze (M4.6)
  zugfolge-fleet/           Flotte, Formation, Umlauf, Personal, Versorgung und Beschaffung (M5)
  zugfolge-runtime/         Autoritativer Flotten- und Betriebsübergangszustand (M5/M6.7)
  zugfolge-runtime-napi/    Schmale napi-rs-Grenze für M5/M6
  zugfolge-rules/           Betriebsprogramm, Dispositionsregeln, Erklärungen und Rücktest (M7)
  zugfolge-disruption/      Policies, Ursachen, Wirkungen, Fahrdienstleitung und Ersatzplanung (M8)
packages/                   TypeScript — fachliche Bibliotheken (ab M2)
  db/                       Postgres-Zugriff über Drizzle, Wurzel der Weltisolation (M2.2)
  disruption-provider/      Rechtegeprüfter Snapshot-Adapter für REALISTIC (M8.12)
  identity/                 Konten, Rollen, Weltzugänge; Keycloak-Verifikation (M2.1)
  operators/                EVU: Gründung, Stammdaten, Zuordnung zu Welt und Konto (M2.3)
  economy/                  Ledger-Kern: Integer-Cent, unveränderlich, ausgeglichen (M2.4)
  mailbox/                  Postfach-Grundgerüst: Nachrichten, Fristen, Quittierung (M2.5)
  privacy/                  Datenschutz: Auskunft, Löschung, Aufbewahrungsfristen (M2.6)
  health/                   Health-Check-Vertrag und Aggregation für Status-/Monitoringdienste, Grundlage für M9.5
  design-system/            Palette, Komponenten, Icons und Dichtestufen (M3.9)
  planning-projection/      Strikter Clientvertrag für Bildfahrplan und Konflikterklärung (M3.10)
  planning-runtime-native/  Fail-closed Loader des Planning-Node-Addons
  planning-worker/          Weltgebundener Command-Consumer und atomare Planning-Projektion
  livemap/                  Weltisolierter Snapshot-/Delta-Fanout (M4.6)
  runtime-native/           Fail-closed Loader für Flotten-, Betriebs- und Regional-Runtimes
  dispatch/                 Kanonischer M7-Plattformvertrag, EVU-Projektionen und Operations-Stream
  cooperation/              EVU-Verträge, Fahrzeug-Sekundärmarkt und Störungshilfe (M12.1/M12.2)
  commerce/                 Entitlements, signierte Odoo-Grenze, idempotente Queue und Bridge (M13)
odoo/addons/zugfolge_admin/ Eigenes Odoo-Administrationsmodul; keine Odoo-Instanz oder OCA-Quellkopie
apps/                       TypeScript — Dienste und Frontend (ab M2 / M4)
  game-api/                 Fastify-Dienst: Authentifizierung, Weltzugang, EVU, Ledger, Postfach, Datenschutz (M2)
  game-web/                 Bildfahrplan, Sperrzeitentreppe und Konflikterklärung (M3.10)
  livemap/                  Vite-Frontend: öffentliche Zuglage, Zuglaufansicht und Delta-Interpolation (M4)
  operations-center/        Vite-Frontend: Regel-Editor, Betriebszentrale und Tagesberichte (M7)
spikes/                     Wegwerf-Code mit Verfallsdatum — derzeit leer
tools/                      Werkzeuge für CI und Entwicklung
  guards/                   die Wächter der harten Invarianten
  load/                     äußerer Lastmessharnisch für 180.000 Fahrten und ≥2 Mio. Ereignisse (M4.11)
  m7-acceptance/            echter 48h-Rust-Ereigniserzeuger für die M7-Abnahme
  m7-e2e/                   Rust → Event-Log → Betriebszentrale → Tagesbericht
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

M3.10 ergänzt diese Grenze, ohne eine zweite Planungslogik einzuführen:
`zugfolge-planning-runtime` führt den echten `PlanningRun` aus und erzeugt den
revisionierten Rust-Zustand sowie die Projektion. `packages/planning-worker`
ordnet ausschließlich welt- und kontogebundene Kommandos, Infrastruktur-
Release-Fakten und den atomaren Datenbank-Commit. Der Browser erhält nur den
strikten Vertrag aus `packages/planning-projection`; weder API noch Client
dürfen Konflikte oder Alternativen selbst entscheiden.

Seit **M5.1** hält `zugfolge-fleet` bewusst zwei Ebenen auseinander: Der
versionierte `VehicleCatalogRelease` beschreibt Typen, Quellen, Bau-/Marktzeiten
und belegte Zugsicherungsoptionen; `VehicleAsset` und `FleetSnapshot` halten
den individuellen, weltgebundenen Zustand. Die echte redaktionelle
Katalogdatei bleibt als proprietäres Weltdatum außerhalb dieses öffentlichen
Baums (E16). Im Crate liegen nur Schema, Regeln und fiktive Testdaten. Der
Offline-Compiler in `zugfolge-fleet::release_catalog` ist die einzige Grenze,
die einen belegten Quellkatalog und konkreten Welt-Seed in den
Fleet-Authority-Release sowie das Operational-v2-Fahrzeuginventar projiziert.
Seine Receipt bindet beide Eingaben und alle Ausgaben; ein JavaScript-Werkzeug
darf diese fachliche Projektion nicht nachbauen. Vollständiger Vertrag:
[`fahrzeugkatalog.md`](fahrzeugkatalog.md).

Der produktive M5-Pfad liegt in `zugfolge-runtime`: Ein serververtrauenswürdiger,
weltgebundener Authority-Release wird beim Start geprüft und beim Initialisieren
in den Rust-Zustand eingefroren. Folgekommandos enthalten nur Kennungen und
Absichten. `packages/economy` persistiert Rust-Zustand, kompakten Replay-Beleg
und abgeleiteten Mobilisierungssnapshot in einer Transaktion. Die Game-API
nimmt deshalb weder fremde Rust-Zustände noch fertige Snapshots entgegen.

Seit **M5.8** ist `zugfolge-fleet` der Orchestrator für Zusatzfahrten und darf
deshalb von `zugfolge-sim` abhängen, nicht umgekehrt: Nach erfolgreicher
Trassen-, Personal- und Kostenprüfung erzeugt es ausschließlich den reinen
`Command::Materialize`. Der Simulationskern bleibt dadurch frei von
Flottenwissen und Datenbankzugriff. Kapazitätsfähige Anlagen- und
Rangierreservierungen liegen in `zugfolge-conflict`, damit neben
Sperrzeitentreppen keine zweite Konfliktsemantik entsteht.

Seit **M7** implementiert `zugfolge-rules` als einzige Engine die
Dispositionsentscheidung am M4.4-Vertrag. `packages/dispatch` darf die
versionierte Struktur validieren und Ereignisse projizieren, aber keine Regel
auswerten. `apps/game-api` ist Persistenz- und Autorisierungsgrenze;
`apps/operations-center` ist ein reiner Client dieser serverautoritativen
Schnittstelle. Vollständiger Vertrag: [`betriebsprogramm.md`](betriebsprogramm.md).

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

Rust-Spikes und explizite Rust-Werkzeuge sind Mitglieder des Cargo-Workspace
(`crates/*`, `spikes/*` und die benannten Werkzeuge unter `tools/`). Das ist
Absicht: Sie laufen dadurch in derselben CI, unter
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
| Rust | Cargo-Workspace, `rust-toolchain.toml` (Patchversion `1.94.1`) | `Cargo.lock` |
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
der Golden-Master des `InfraRelease` wird gegen genau sie auf Linux erzeugt.
Linux ist die einzige unterstützte Betriebs- und CI-Plattform. Ein Wechsel ist
eine bewusste Entscheidung und im Commit zu begründen.

---

## 3. Domänen mit Regelbindung

Eine **Domäne** ist ein Pfadbereich, für den bestimmte Invarianten gelten. Die
Liste ist keine vollständige Karte des Repositoriums, sondern die Zuordnung
„welche Regel gilt wo". Sie steht maschinenlesbar in
`tools/guards/guards.config.json` und wird gegen dieses Dokument geprüft.

| Domäne | Pfade | Status | Was dort besonders gilt |
|--------|-------|--------|-------------------------|
| `determinism-core` | `crates/zugfolge-determinism/**` | aktiv | ganzzahlig, uhrfrei, geordnet — der Harnisch muss selbst halten, was er prüft |
| `simulation-core` | `crates/zugfolge-sim/**`, `crates/zugfolge-sim-runtime/**`, `crates/zugfolge-runtime{,-napi}/**`, `crates/zugfolge-conflict/**`, `crates/zugfolge-fleet/**`, `crates/zugfolge-disruption/**`, `packages/runtime-native/**`, `spikes/**` | aktiv | vollständiger Kernvertrag: kein Bezahlstatus, keine Uhr, keine Datenbank |
| `path-allocation` | `crates/zugfolge-planner/**`, `crates/zugfolge-planning-runtime{,-napi}/**`, `packages/path-allocation/**`, `packages/planning-{projection,runtime-native,worker}/**` | aktiv | Reihenfolge und Bezahlstatus beeinflussen das Ergebnis nicht (E4, `infrastruktur.md` 2) |
| `dispatch` | `crates/zugfolge-rules/**`, `packages/dispatch/**` | aktiv | das Betriebsprogramm wirkt offline und für alle gleich (E2, E13) |
| `demand` | `packages/demand/**`, `crates/zugfolge-demand/**` | geplant | Nachfrage folgt dem Angebot, nie dem Vertrag des Spielers |
| `economy` | `packages/economy/**`, `packages/cooperation/**`, `packages/tender/**`, `apps/economy-service/**` | aktiv | Ledger und Kooperation in Integer-Cent; Wertung deterministisch aus dem `EconomyRelease` (M6/M12) |
| `infra-pipeline` | `crates/zugfolge-infra/**` | aktiv | **der einzige Ort mit Gleitkommarechnung** — sie endet in ganzzahligen Fahrzeittabellen |
| `world-isolation` | `packages/db/**` | aktiv | Postgres-Zugriff der Game-Services; Wurzel der Weltisolation — `worlds`, das Event-Log und das weltgebundene Repository (M2.2) |
| `release-tools` | `tools/audits/**`, `tools/reference-corpus/**`, `tools/reference-model/**`, `tools/region-import/**`, `tools/tiles/**` | aktiv | nicht autoritative Datei-I/O-, Import- und Kartenadapter; Freigabeentscheidungen bleiben in Rust |
| `operations-tools` | `tools/alpha-ops/**`, `tools/guards/**`, `tools/load/**`, `tools/m7-acceptance/**`, `tools/m7-e2e/**` | aktiv | Betriebs-, Abnahme-, Last- und Governance-Werkzeuge ohne fachliche Laufzeitautorität |
| `platform-services` | explizit aufgezählte übrige `packages/*` und `apps/*` | aktiv | vollständige Zuordnung aller Produktionspakete; neue Pakete erzwingen vor dem ersten Commit eine bewusste Wächterentscheidung |

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

Die öffentliche InfraRelease-, Jahresplan- und technische
Referenzkorpus-Qualifikationsbildung liegt mit `zugfolge-infra-release`
vollständig in `crates/zugfolge-infra`. Die
JavaScript-Einstiege unter `tools/region-import/` dürfen nur Dateipfade und den
Rust-Prozess orchestrieren. Das gilt ebenso für den synchronen Aufruf aus
`tools/reference-corpus/artifact-chain.mjs`: Capture-Konfiguration, Korpus,
Qualifikationsnachweis, getrennte Kalibrierungs- und Validierungsdatensätze samt
Konfigurationen, Modellkonfiguration, Modellergebnis, Report und Kandidat werden
jeweils als Record plus exakte Bytes an Rust übergeben. Rust hasht und parst sie
selbst, rekonstruiert den disjunkten Holdout-Vergleich und entscheidet anhand der
eingefrorenen Toleranz. Bei Ketten-, Bundle- und Signaturprüfung erhält derselbe
Rust-Verifier außerdem Capture-Manifest, Quellarchiv, jede Quelltabelle,
normalisierte Beobachtungen und das gespeicherte Release-Manifest. JavaScript
transportiert nur sichere relative Pfade, Dateien, Prozessaufruf und Ergebnis.
Der Repository-Wächter `rust-release-pipeline`
verhindert eine zweite autoritative Schema-, Rechte-, Qualifikations- oder
Freigabeentscheidung in JavaScript oder TypeScript (E5/M1.12).

Die ältere JavaScript-Korpusbildung ist nur noch ein mit
`ZUGFOLGE_NON_AUTHORITATIVE_CORPUS_BUILD=1` ausdrücklich zu aktivierender,
nicht autoritativer Build-Zwischenschritt. Sie kann weder
Manifest noch Jahresplan erzeugen und damit keinen Release freigeben. Der
produktive Jahreslauf endet zwingend im Rust-Compiler; eine spätere Portierung
weiterer Importadapter ändert diese Autoritätsgrenze nicht.

Zusätzlich muss jedes Manifest unmittelbar unter `crates/*`, `packages/*`,
`apps/*` und `tools/*` mindestens einen ausdrücklich genannten aktiven
Domänenpfad treffen.
Jede produktive Source-Datei gehört exakt einer aktiven Domäne. Eine echte
Querlagenausnahme muss als enger Pfad mit tragfähiger Begründung in
`coverageExceptions` stehen; Überlappungen dürfen nie ausgenommen werden. Ein
Catch-all wie `packages/**` ist absichtlich nicht eingetragen: Ein neu
angelegtes Produktionspaket stoppt damit den Wächterlauf, bis seine Regeln und
Autoritätsgrenzen bewusst festgelegt sind.

Der Arbeitsbaum-Leser verwendet eine explizite Textformat-Allowlist. Sie
umfasst auch Python-Werkzeuge und JSX-Oberflächen, damit diese Dateien die
Coverage-Prüfung tatsächlich erreichen. Ignorierte Verzeichnisse werden vor
dem Betreten abgeschnitten; Binärdateien werden nicht als Text gelesen.
Glob-Muster werden je Pfadauswahl einmal kompiliert und im Prüflauf
wiederverwendet, ohne einen globalen Cache über mehrere Konfigurationen.

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
eigentliche Nachweis: Die CI erzeugt ihn auf der unterstützten Linux-Plattform
und vergleicht ihn gegen die eingecheckte Referenzdatei.

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
