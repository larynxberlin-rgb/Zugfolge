# Roadmap-Status

<!-- Automatisch aus .github/milestones.json erzeugt. Nicht von Hand bearbeiten. -->

Diese Matrix trennt vorhandenen Kerncode, Integration, Produktionsreife und formale Abnahme.
Die GitHub-Milestones und ihre Issue-/PR-Zuordnung werden durch
`.github/workflows/milestones.yml` idempotent aus derselben Quelle synchronisiert.
Die Roadmap ist absichtlich abhaengigkeitsbasiert; deshalb werden keine kuenstlichen
Kalendertermine gesetzt.

| Milestone | Kern | Integration | Betrieb | Abnahme | Issues / PRs | Abhaengigkeiten |
|---|---|---|---|---|---:|---|
| M0 | nachgewiesen | nachgewiesen | nicht relevant | nachgewiesen | 6 / 6 | — |
| M1 | nachgewiesen | blockiert | blockiert | blockiert | 1 / 7 | M0 |
| M2 | nachgewiesen | nachgewiesen | nachgewiesen | nachgewiesen | 5 / 3 | M0 |
| M3 | nachgewiesen | nachgewiesen | nachgewiesen | nachgewiesen | 1 / 4 | M1, M2 |
| M4 | nachgewiesen | nachgewiesen | nachgewiesen | nachgewiesen | 5 / 1 | M3 |
| M5 | nachgewiesen | nachgewiesen | nachgewiesen | nachgewiesen | 2 / 3 | M1, M2 |
| M6 | nachgewiesen | nachgewiesen | nachgewiesen | nachgewiesen | 10 / 2 | M2, M5 |
| M7 | nachgewiesen | nachgewiesen | nachgewiesen | nachgewiesen | 0 / 0 | M4, M5, M6 |
| M8 | offen | offen | offen | offen | 0 / 0 | M4, M7 |
| M9 | offen | offen | blockiert | blockiert | 3 / 2 | M0, M4, M6, M7, M8 |
| M10 | offen | offen | offen | offen | 0 / 0 | M9 |
| M11 | offen | offen | offen | offen | 0 / 0 | M9 |
| M12 | offen | offen | offen | offen | 0 / 0 | M6, M10, M11 |
| M13 | offen | offen | offen | offen | 0 / 0 | M9, M12 |
| M14 | offen | offen | offen | offen | 0 / 0 | M9 |

Ein GitHub-Milestone wird nur geschlossen, wenn alle drei maschinell pruefbaren
Bedingungen gelten: Jeder Roadmap-Teilpunkt steht auf `erledigt`, jedes zugeordnete
Issue beziehungsweise jeder PR ist geschlossen, und mindestens ein reproduzierbarer
Nachweis ist in `.github/milestones.json` hinterlegt. Leere Zukunfts-Milestones
bleiben offen.

GitHub-Ansicht: https://github.com/larynxberlin-rgb/Zugfolge/milestones
