# Zugfolge

Persistentes, serverautoritäres Browsergame: Eisenbahn-Unternehmenssimulation
mit hohem betrieblichem, infrastrukturellem und wirtschaftlichem Realismus.
Öffentliche Welten laufen dauerhaft in 1:1-Echtzeit ohne Wipes. Erste
Pilotregion: **Leipzig–Halle–Erfurt**.

> **Stand nach dem Projektaudit (August 2026):** M0 und M2 sind vollständig
> nachgewiesen. Die Domänenimplementierungen von M1 bis M6 sind weitgehend
> vorhanden; noch nicht als abgeschlossen gelten der signierte Modellvergleich
> des real erfassten Pilotkorpus (M1.13), die produktive Planner-Anbindung des Bildfahrplans
> (M3.10), der vollständige Rust-Runtime-Startpfad zur Livemap (M4.6), der
> M5-Single-Writer-Betriebsnachweis in der M6-Mobilisierung. Der periodische
> M6-Kommando-Worker und die GTFS-basierte Losableitung sind implementiert.
> M7 bis M14 sind offen. Der detaillierte Status steht in
> [`docs/milestones.md`](docs/milestones.md); „erledigt“ bedeutet dort wieder
> einen reproduzierbaren Beweis und nicht nur vorhandenen Quellcode.

## Wo was steht

| Ich will … | … lesen |
|------------|---------|
| verstehen, worum es geht | [`docs/produkt.md`](docs/produkt.md) |
| wissen, was entschieden ist | [`docs/entscheidungen.md`](docs/entscheidungen.md), [`docs/adr/`](docs/adr/README.md) |
| Code beitragen | [`docs/monorepo.md`](docs/monorepo.md) und [`CLAUDE.md`](CLAUDE.md) |
| Begriffe nachschlagen | [`docs/glossar.md`](docs/glossar.md) |
| die Reihenfolge kennen | [`docs/milestones.md`](docs/milestones.md) |
| den GTFS-Fahrplan-Referenzkorpus erzeugen | [`docs/referenzkorpus.md`](docs/referenzkorpus.md) |
| verstehen, wie GTFS zu Linien und Ausschreibungen wird | [`docs/gtfs-angebotsplanung.md`](docs/gtfs-angebotsplanung.md) |

## Aufbau

```text
crates/     Rust — Simulationskern, Solver, Release-Pipeline
            zugfolge-determinism/  Determinismus-Testharnisch
            zugfolge-infra/        Betriebsgraph und Infra-Release-Pipeline (M1)
            zugfolge-conflict/     Sperrzeiten, Belegungsprofile, Konfliktprüfung (M3.1–M3.3)
            zugfolge-planner/      Trassen-Planner (M3.4)
            zugfolge-sim/          Ereigniskern, Replay und Livemap-Protokoll (M4)
            zugfolge-fleet/        Fahrzeugkatalog und individuelle Flotte (M5.1–M5.1b)
packages/   TypeScript — fachliche Bibliotheken (ab M2)
            db/                    Drizzle-Schema, Wurzel der Weltisolation (M2.2)
            identity/              Konten, Rollen, Weltzugänge (M2.1)
            operators/             EVU (M2.3)
            economy/               Ledger-Kern (M2.4), M6-Zustand und transaktionale Outbox
            gtfs/                  Fahrtenbilder, Infrastrukturbindung und SPNV-Lose
            mailbox/               Postfach (M2.5)
            privacy/               Auskunft, Löschung, Aufbewahrung (M2.6)
apps/       TypeScript — Dienste und Frontend (ab M2 / M4)
            game-api/              Fastify-Dienst, Health, Replay- und Livemap-Adapter
spikes/     Wegwerf-Code mit Verfallsdatum — derzeit leer
tools/      Werkzeuge für CI und Entwicklung
docs/       Spezifikation, Entscheidungen, Glossar
```

Vollständig mit Domänengrenzen und Durchsetzung:
[`docs/monorepo.md`](docs/monorepo.md).

## Loslegen

Vorausgesetzt sind eine Rust-Werkzeugkette (Kanal `stable`), Node.js 24 LTS
und pnpm 11 — oder ein Lauf von `bash .claude/setup.sh`, das genau das
einrichtet.

```bash
cargo test --workspace
```

```bash
pnpm install && pnpm -r build && pnpm -r test
```

```bash
pnpm guards
```

Der letzte Befehl prüft die harten Invarianten, die kein Compiler sieht — etwa
dass der Bezahlstatus eines Spielers keine spielentscheidende Domäne berührt.

## Mitarbeit

Beiträge brauchen ein unterzeichnetes [CLA](CLA.md). Kein Beitrag ohne einen
Test, der ohne ihn fehlschlägt.

## Lizenz

PolyForm Shield 1.0.0 — **Source Available**, nicht Open Source. Erlaubt ist
jede Nutzung außer dem Betrieb eines konkurrierenden Produkts. Die Datei
[`LICENSE`](LICENSE) nennt Sebastian Barowski als Rechteinhaber und ist damit
wirksam. Umsetzung und Durchsetzung (CLA, Schichtentrennung):
[`docs/rechteschutz.md`](docs/rechteschutz.md); Begründung:
[`docs/geschaeft.md`](docs/geschaeft.md).
