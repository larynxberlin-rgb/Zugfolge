# Zugfolge

Persistentes, serverautoritäres Browsergame: Eisenbahn-Unternehmenssimulation
mit hohem betrieblichem, infrastrukturellem und wirtschaftlichem Realismus.
Öffentliche Welten laufen dauerhaft in 1:1-Echtzeit ohne Wipes. Erste
Pilotregion: **Leipzig–Halle–Erfurt**.

> **Stand September 2026:** M0 bis M8 sind fachlich abgenommen und
> reproduzierbar nachgewiesen. Die unabhängige Release-Qualifizierung und
> echte Signatur des Pilot-InfraRelease sind nachgewiesen
> ([Issue #48, geschlossen](https://github.com/larynxberlin-rgb/Zugfolge/issues/48)).
> Davon getrennte Kalibrierungsfixtures bleiben bewusst `calibration-only`
> und `releaseQualified: false`; sie sind keine produktiven Releases.
> M9 bleibt in Arbeit: Betriebsdrills gegen den laufenden Zielstack, Backup/
> Restore, Alarmierung, Release-/Rollback-Abnahme sowie der Betrieb mit
> externen Spielern sind jeweils durch konkrete Protokolle zu belegen.
> Neue Auditbefunde werden in [#491](https://github.com/larynxberlin-rgb/Zugfolge/issues/491)
> nachverfolgt. Die kanonische Milestone-Statusquelle ist
> [`docs/milestones.md`](docs/milestones.md); Quellcode und grüne PR-CI ersetzen
> keinen dort verlangten Betriebsnachweis.

## Wo was steht

| Ich will … | … lesen |
|------------|---------|
| verstehen, worum es geht | [`docs/produkt.md`](docs/produkt.md) |
| wissen, was entschieden ist | [`docs/entscheidungen.md`](docs/entscheidungen.md), [`docs/adr/`](docs/adr/README.md) |
| Code beitragen | [`docs/monorepo.md`](docs/monorepo.md) und [`AGENTS.md`](AGENTS.md) |
| Tests und CI ausführen | [`docs/ci.md`](docs/ci.md) |
| Begriffe nachschlagen | [`docs/glossar.md`](docs/glossar.md) |
| die Reihenfolge kennen | [`docs/milestones.md`](docs/milestones.md) |
| das UX-Zielbild und die künftigen Arbeitsräume verstehen | [`docs/ux-spieler-shell.md`](docs/ux-spieler-shell.md) |
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

Vorausgesetzt sind Rust **1.94.1** gemäß [`rust-toolchain.toml`](rust-toolchain.toml), Node.js 24 LTS
und pnpm 11 — oder ein Lauf von `bash .claude/setup.sh`, das genau das
einrichtet.

Der Rust-Pin hält Release-Artefakte reproduzierbar. Ein Wechsel wird bewusst
im Commit begründet und anhand der Release-Golden-Master geprüft; siehe
[`docs/monorepo.md`](docs/monorepo.md#2-werkzeugkette).

```bash
cargo test --workspace
```

```bash
pnpm install --frozen-lockfile && pnpm build && pnpm test
```

```bash
pnpm guards
```

Der letzte Befehl prüft die harten Invarianten, die kein Compiler sieht — etwa
dass der Bezahlstatus eines Spielers keine spielentscheidende Domäne berührt.

Die PR-CI besteht aus vier Jobs für Rust, TypeScript, native Integration und
Repository-Wächter samt Abhängigkeitsprüfung. Größere Last-, Infrastruktur- und
Betriebsabnahmen werden bei Bedarf manuell gestartet. Auswahl und Befehle:
[`docs/ci.md`](docs/ci.md).

## Mitarbeit

Beiträge brauchen ein unterzeichnetes [CLA](CLA.md). Tests sichern beobachtbares
Spielverhalten und behobene Fehler ab. Für kleine Refactorings, Dokumentation
oder Formatierung reichen passende vorhandene Prüfungen; neue Tests sollen
einen konkreten Fehler erkennen können.

## Lizenz

PolyForm Shield 1.0.0 — **Source Available**, nicht Open Source. Erlaubt ist
jede Nutzung außer dem Betrieb eines konkurrierenden Produkts. Die Datei
[`LICENSE`](LICENSE) nennt Sebastian Barowski als Rechteinhaber und ist damit
wirksam. Umsetzung und Durchsetzung (CLA, Schichtentrennung):
[`docs/rechteschutz.md`](docs/rechteschutz.md); Begründung:
[`docs/geschaeft.md`](docs/geschaeft.md).
