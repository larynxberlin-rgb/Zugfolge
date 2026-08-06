# Zugfolge

Persistentes, serverautoritäres Browsergame: Eisenbahn-Unternehmenssimulation
mit hohem betrieblichem, infrastrukturellem und wirtschaftlichem Realismus.
Öffentliche Welten laufen dauerhaft in 1:1-Echtzeit ohne Wipes. Erste
Pilotregion: **Leipzig–Halle–Erfurt**.

> **Stand:** Konzeption abgeschlossen, Fundament steht (M0.1, M0.2). **M0.3 ist
> geführt:** Der Wegwerf-Spike zur Sperrzeitentreppe erkennt echte
> Belegungskonflikte und macht sie im Bildfahrplan sichtbar — siehe
> [`spikes/blocking-time-staircase/`](spikes/blocking-time-staircase/README.md).
> Der nächste Schritt ist M0.4, das Rechte-Gate.

## Wo was steht

| Ich will … | … lesen |
|------------|---------|
| verstehen, worum es geht | [`docs/produkt.md`](docs/produkt.md) |
| wissen, was entschieden ist | [`docs/entscheidungen.md`](docs/entscheidungen.md), [`docs/adr/`](docs/adr/README.md) |
| Code beitragen | [`docs/monorepo.md`](docs/monorepo.md) und [`CLAUDE.md`](CLAUDE.md) |
| Begriffe nachschlagen | [`docs/glossar.md`](docs/glossar.md) |
| die Reihenfolge kennen | [`docs/milestones.md`](docs/milestones.md) |

## Aufbau

```text
crates/     Rust — Simulationskern, Solver, Release-Pipeline
packages/   TypeScript — fachliche Bibliotheken (ab M2)
apps/       TypeScript — Dienste und Frontend (ab M2 / M4)
spikes/     Wegwerf-Code mit Verfallsdatum
tools/      Werkzeuge für CI und Entwicklung
docs/       Spezifikation, Entscheidungen, Glossar
```

Vollständig mit Domänengrenzen und Durchsetzung:
[`docs/monorepo.md`](docs/monorepo.md).

## Loslegen

Vorausgesetzt sind eine Rust-Werkzeugkette (Kanal `stable`), Node.js 22 LTS
und pnpm 10.

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
jede Nutzung außer dem Betrieb eines konkurrierenden Produkts. Siehe
[`LICENSE`](LICENSE) und [`docs/geschaeft.md`](docs/geschaeft.md).

> **Achtung:** Die Datei `LICENSE` trägt bis zum Einsetzen des Volltexts einen
> Warnblock und ist bis dahin nicht gültig.
