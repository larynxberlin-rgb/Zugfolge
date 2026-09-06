# Roadmap-Status

<!-- Automatisch aus .github/milestones.json erzeugt. Nicht von Hand bearbeiten. -->

Diese Matrix trennt vorhandenen Kerncode, Integration, Produktionsreife und formale Abnahme.
Die GitHub-Milestones und ihre Issue-/PR-Zuordnung werden durch
`.github/workflows/milestones.yml` idempotent aus derselben Quelle synchronisiert.
Die Roadmap ist absichtlich abhaengigkeitsbasiert; deshalb werden keine kuenstlichen
Kalendertermine gesetzt.

| Milestone | Kern | Integration | Betrieb | Abnahme | Issues gesamt / PRs | Abhaengigkeiten |
|---|---|---|---|---|---:|---|
| M0 | nachgewiesen | nachgewiesen | nicht relevant | nachgewiesen | 11 / 6 | — |
| M1 | nachgewiesen | nachgewiesen | nachgewiesen | nachgewiesen | 13 / 7 | M0 |
| M2 | nachgewiesen | nachgewiesen | nachgewiesen | nachgewiesen | 11 / 3 | M0 |
| M3 | nachgewiesen | nachgewiesen | nachgewiesen | nachgewiesen | 11 / 4 | M1, M2 |
| M4 | nachgewiesen | nachgewiesen | nachgewiesen | nachgewiesen | 16 / 1 | M3 |
| M5 | nachgewiesen | nachgewiesen | nachgewiesen | nachgewiesen | 18 / 3 | M1, M2 |
| M6 | nachgewiesen | nachgewiesen | nachgewiesen | nachgewiesen | 28 / 2 | M2, M5 |
| M7 | nachgewiesen | nachgewiesen | nachgewiesen | nachgewiesen | 7 / 0 | M4, M5, M6 |
| M8 | nachgewiesen | nachgewiesen | blockiert | nachgewiesen | 12 / 0 | M4, M7 |
| M9 | in Arbeit | in Arbeit | blockiert | blockiert | 19 / 2 | M0, M4, M6, M7, M8 |
| M10 | nachgewiesen | nachgewiesen | blockiert | nachgewiesen | 14 / 4 | M9 |
| M11 | offen | offen | offen | offen | 5 / 0 | M9 |
| M12 | in Arbeit | in Arbeit | offen | blockiert | 5 / 0 | M6, M10, M11 |
| M13 | in Arbeit | in Arbeit | offen | offen | 9 / 0 | M9, M12 |
| M14 | in Arbeit | in Arbeit | blockiert | blockiert | 4 / 0 | M9 |
| M15 | in Arbeit | in Arbeit | blockiert | in Arbeit | 24 / 4 | M4, M5, M6, M8, M10 |

Die Issue-Zahl kombiniert explizite Manifestzuordnungen mit den automatisch anhand
ihres `[Roadmap x.y]`-Vertrags erkannten Roadmap-Issues. PRs werden separat gezählt.
Ein GitHub-Milestone wird nur geschlossen, wenn alle vier Reifegrade `nachgewiesen`
oder `nicht relevant` sind, jeder Roadmap-Teilpunkt `erledigt`, jedes explizit oder
automatisch zugeordnete Issue beziehungsweise jeder PR geschlossen und mindestens ein
reproduzierbarer Nachweis hinterlegt ist. Leere Zukunfts-Milestones bleiben offen.

GitHub-Ansicht: https://github.com/larynxberlin-rgb/Zugfolge/milestones
