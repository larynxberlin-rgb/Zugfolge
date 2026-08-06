# Spikes — Domänenanleitung

Gilt für alles unter `spikes/`. Ergänzt die Wurzel-`CLAUDE.md`, hebt sie nie
auf.

## Was ein Spike ist

Ein Spike beantwortet **eine** Frage, die sich nicht am Reißbrett entscheiden
lässt, und verschwindet danach. Er ist kein Prototyp, kein Vorgriff und keine
erste Fassung des echten Modells. Bleibt er liegen, wird er zur zweiten,
ungepflegten Wahrheit neben dem Kern — und das ist teurer, als ihn nie gebaut
zu haben.

Deshalb gelten drei Regeln ohne Ausnahme:

1. **Verfallsdatum.** Die README nennt den Milestone, mit dem der Spike gelöscht
   wird. Er steht auch in `docs/monorepo.md`.
2. **Keine Abhängigkeit von außen.** Kein Paket außerhalb von `spikes/` darf
   einen Spike verwenden. Ein Spike hängt seinerseits nur an
   `zugfolge-determinism`.
3. **Ergebnis vor Code.** Ein Spike ohne aufgeschriebenen Befund hat seine
   Aufgabe nicht erfüllt, auch wenn er läuft. Der Befund gehört in die README:
   was trägt, was fehlt, in welchen Milestone das Fehlende gehört.

## Was trotzdem gilt

Spikes sind Mitglieder des Cargo-Workspace und liegen in der Wächterdomäne
`simulation-core`. Sie unterliegen damit denselben Lints, denselben Wächtern
und derselben CI wie der spätere Kern: ganzzahlig, uhrfrei, ohne ungesäten
Zufall, ohne ungeordnete Menge, ohne Datenbank.

**Das ist kein Formalismus.** Ein Spike, der die Invarianten umgehen darf,
beweist über den Kern nichts — er beweist nur, dass die Frage unter anderen
Bedingungen lösbar wäre.

Ein zustandsrelevantes Modell braucht auch hier `DeterministicModel` und einen
Golden-Master. Gerade im Spike ist das billig: Er ist die erste Stelle, an der
eine Rechnung plattformabhängig werden kann, und die letzte, an der es nichts
kostet, das zu merken.

## Neuen Spike anlegen

1. `spikes/<frage-in-englisch>/Cargo.toml` mit `…workspace = true` und
   `[lints] workspace = true`.
2. README mit Frage, Aufbau, **Verfallsdatum** und — nach getaner Arbeit —
   Befund.
3. Eintrag in der Spike-Tabelle in `docs/monorepo.md`.
4. Bezeichner und Dateinamen englisch, Kommentare und Testnamen deutsch,
   Fachbegriffe nach `docs/glossar.md`.

## Löschen

Wenn der Milestone erreicht ist, der den Spike ablöst: Verzeichnis löschen,
Zeile aus `docs/monorepo.md` entfernen, fertig. Was vom Spike bleiben soll,
steht dann längst in der Spezifikation — nicht im Code.
