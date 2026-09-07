# Zugfolge · Offline-Demo

Öffne **M15-Offline-Demo.html** per Doppelklick in einem aktuellen Browser
und wähle **Start**. Die Datei liegt unter
`../../outputs/conductor-offline/M15-Offline-Demo.html`. Sie funktioniert allein: kein Server,
keine Anmeldung, keine Internetverbindung und keine zusätzlichen Dateien.

## Spielen

- **Pfeiltasten oder W A S D halten:** durch den Zug gehen. Auf dem
  Touchscreen das Steuerkreuz gedrückt halten.
- **Fahrgast anklicken oder antippen:** deine Figur geht auf dem tatsächlich
  begehbaren Weg zum Fahrgast und beginnt dort die Kontrolle. **E** oder
  **Leertaste** spricht die ausgewählte oder nächstgelegene Person an.
- **Übungsauswahl oben:** führt zu drei unterschiedlichen Fahrgästen. Die
  Auswahl nennt keine Fahrkartenbefunde; diese ergeben sich erst aus der
  Kontrolle.
- Der Fahrgast spricht in einer **Sprechblase direkt im Zug**. Deine
  Antwortoptionen erscheinen im unteren Spielbereich. Antippen, anklicken
  oder mit den Ziffern **1 bis 9** wählen. Im Gespräch wählen Pfeiltasten die
  Antwort und **E / Leertaste** bestätigt sie. Angezeigte Wartezeiten gehören
  zum bestätigten Gesprächsschritt.
- **Wagen und Deck** ändern den Bildausschnitt, **Zu mir** folgt deiner Figur.
  Wenn du zu einem Fahrgast auf einem anderen Deck gehst, nutzt die Figur
  die tatsächliche Treppe. Zoom passt den Ausschnitt an.
- **Bericht** zeigt bestätigte Kontrollfälle und Beträge. **Pause** oder
  **Escape** führt zur Übersicht. **Fortsetzen** öffnet denselben Einsatz;
  **Neu beginnen** startet die Übungsfahrt erneut.

Die Übungszeit pausiert bei geschlossener Spielansicht und verstecktem Tab.
Unterbrechungen von mehr als 60 Sekunden, beispielsweise der Ruhezustand des
Computers, werden ebenfalls als Pause behandelt. Beim Zurückkehren wird
diese Zeit nicht nachgeholt.

Der Browser speichert den lokalen Stand, soweit er dies für Datei-URLs
erlaubt. Die Startseite zeigt einen Hinweis, wenn lokale Speicherung nicht
möglich ist. Ein beschädigter eigener Spielstand wird ausdrücklich abgewiesen;
**Gespeicherte Demo zurücksetzen** löscht nur den Speicherbereich dieser Demo.
Bewegungen werden ungefähr alle zwei Sekunden im Hintergrund gespeichert,
Entscheidungen und reguläres Verlassen vor ihrer Bestätigung. Bei abruptem
Schließen können die letzten noch nicht gespeicherten Schritte entfallen.

## Was die Demo enthält

Eine fiktive Regionalzugfahrt mit der bestehenden M5-Doppelstockkonfiguration
102, 200 Sitz- und 20 Stehplätzen. Der reduzierte Übungskorpus enthält
40 tatsächlich vom Nachfragekern erzeugte Fahrgäste. Die ursprünglichen
Geometrie-, Nachfrage-, Betriebs-, Sitzungs-, Dialog- und Kontrollkerne
arbeiten als Rust-WASM in einem lokalen Worker. Render- und Invoke-Antworten
enthalten öffentliche Projektionen und kleine Zustandsreferenzen. Der lokale
Speicherexport überträgt den vollständigen privaten, ausschließlich fiktiven
Übungsstand an den Mainthread und den eigenen Browserspeicher; er stellt
keine Geheimhaltung gegenüber dem Besitzer der Offline-Datei dar.

Die neue Spielhülle verwendet eine bildfüllende Pixelansicht mit der bisherigen
Graphit-/Rot-Palette, am Fahrgast verankerte Gesprächsblasen und ein Antwortmenü
im Spiel. Die neuen Figurenbilder liegen in `assets-v2`; ihre Ableitung ist
separat dokumentiert. Native Positionsbestätigungen bleiben verbindlich.
Gehanimation und Interpolation zeichnen bereits bestätigte Bewegung nach;
Atmung und kleine Blickbewegungen verändern keinen Standort.

Die Außenszene stammt aus der ursprünglichen Szenenprojektion desselben
bestätigten Betriebszustands. Die Originalatlanten für Innenraum und Umgebung
bleiben an ihre Releasepins gebunden. Die zusätzlichen Figurenbilder und
sechs Umgebungskacheln sind eine neue Demo-Grafikfassung; sie verändern kein
produktives Artrelease.

Die drei vorbereiteten Übungspersonen haben im unabhängigen nativen
Komponentenlauf eine gültige Kontrolle, eine reguläre Forderung samt Zahlung
und eine vorläufige Forderung mit späterem Nachweis ermöglicht. Es gibt keinen
festen Erfolgsabschluss beim Anklicken: Es gelten die tatsächlichen angebotenen
Dialogoptionen und deren native Prüfbefunde. Produktionswelten, echte Konten
und Server-Ledgerdaten werden nicht verwendet.

## Build und Nachweise

Aus der Repositorywurzel (Node 24, zuvor `pnpm install --frozen-lockfile`):

```sh
node tools/conductor-offline/check.mjs --typecheck
node tools/conductor-offline/build.mjs
node tools/conductor-offline/check.mjs
```

Die Programme lösen Quellen und Ausgaben relativ zu ihrer eigenen Datei auf;
das Arbeitsverzeichnis des Aufrufers ist beliebig. Der Build verwendet das
bereits installierte esbuild aus dem Repository und verändert keine
Quelldateien. `--out DATEI.html` wählt eine andere HTML-Ausgabe; der
Standardprüflauf erwartet die oben genannte Standardausgabe. Ein Neubau des
Rust-Kerns ist für den HTML-Build nicht nötig. Das strikte
[Kernelgate](native/README.md) prüft vorher das enthaltene WASM und seine
Originalquellen gegen die versionierten Pins.

`check.mjs` führt sequenziell HTML-Build, Worker-/Restoreprüfung,
Uhr-/Pausenregression, die drei nativen Kontrollübungen, ihre tatsächliche
Browserbedienung, Animation und mobile Bedienung sowie den Finalizer aus.
`--components` führt nur Build und Komponentenprüfungen aus; es behauptet
keine Browserabnahme. `--typecheck` führt ausschließlich die strikte
Typprüfung aus. Alle Ergebnisse liegen unter
`outputs/conductor-offline` in der Repositorywurzel. Der Finalizer bindet
HTML, Quellen, Berichte und Bilder unter `acceptance/Abnahme.json`.

Die Browserprüfungen respektieren `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` und
`ZUGFOLGE_BROWSER_EXECUTABLE`. Ohne diese Angaben verwenden sie unter Windows
Edge, unter Linux einen vorhandenen Chromium-/Chrome-Systembrowser oder den
zuvor installierten Playwright-Chromium. Alle Testkontexte laufen offline;
HTTP-, HTTPS- und WebSocket-Anfragen lassen die Abnahme scheitern. Es wird
weder automatisch ein Browser noch eine andere Abhängigkeit installiert.

Die vollständige Neuerzeugung beginnt mit `prepare-fixture.mjs`. Es ruft das
unveränderte Originalbeispiel `session_fixture 2` auf, erreichbar über
`ZUGFOLGE_SESSION_FIXTURE_BINARY` oder
`CARGO_TARGET_DIR/release/examples/session_fixture` (Windows: `.exe`).
Danach folgen in dieser Reihenfolge `prepare-data.mjs`, `prepare-control.mjs`,
`prepare-practice.mjs 0` und `prepare-scene.mjs`. Diese expliziten Befehle
ersetzen lokale Übungseingaben; sie gehören nicht zum normalen Prüflauf.

`prepare-data.mjs` lädt die signierten Originalatlanten über den unveränderten
Releaseprüfer und exportiert die fiktive M6-Übungskonfiguration. Die übrigen
Vorbereitungsprogramme erzeugen explizite Übungseingaben vor dem ersten
Checkpoint. `prepare-control.mjs` benutzt die Originalfunktionen aus dem
WASM. `prepare-practice.mjs 0` erzeugt die globale Übungsnachfrage erneut;
es ersetzt keine einzelnen Fahrgäste. `prepare-scene.mjs` erfordert die
gebauten Game-API-Pakete und den vorhandenen nativen Szenenkern: über
`ZUGFOLGE_RUNTIME_NATIVE_PATH` oder `ZUGFOLGE_CONDUCTOR_SCENE_TEST_BINARY`,
sonst `CARGO_TARGET_DIR/release/examples/scene_json` (unter Windows `.exe`).
Seine lokal aufgelöste Deploymentdatei liegt nur unter
`outputs/conductor-offline/preparation/scene`; absolute Rechnerpfade werden
nicht als Demoquelle eingecheckt. Der normale Prüflauf verändert diese
versionierten Fachfakten nicht.

JavaScript, CSS, JSON, Bilder und WASM werden in eine einzige HTML-Datei
eingebettet. Das Spielskript liegt komprimiert vor und wird beim Öffnen rein
lokal über `DecompressionStream` entpackt. Fehlt diese Browserfunktion,
erscheint eine konkrete Fehlermeldung; aktuelle Edge-/Chrome-Versionen sind
für die Browserprüfung vorgesehen. Auch der Hintergrund-Worker entsteht aus
eingebettetem Code.
Die Content-Security-Policy sperrt Netzwerkverbindungen und externe Skripte,
Schriften oder Workerdateien. `outputs/conductor-offline/build-info.json` dokumentiert den genauen
HTML-SHA-256-Wert, die eingebetteten Daten, Original-UI-Bausteine und neuen
Spiel-/Workerquellen. Sein roher JSON-Dateihash unterscheidet sich vom nativen
`fixtureHash`, der die typisierte Rust-Serialisierung bindet.

Der Originalbericht und die Dialog-Fokusführung werden weiterverwendet.
`src/game-mode.ts` steuert die Spieloberfläche; `src/game-renderer.ts` zeichnet
die öffentliche Projektion. Bewegungsabstände und Taktung nutzen die tatsächlich
gepinnten Bewegungsregeln. Die Oberfläche berechnet keine Fahrkartenwahrheit,
Forderung oder Polizeientscheidung.

Native Smoke-/Komponentenbelege und Browserbelege werden getrennt geführt.
`CONTROL-PRACTICE.md` beschreibt die drei tatsächlichen Übungsverläufe und
ihre jeweils getrennten Nachweise.
Ein nativer Komponentenlauf belegt keine Browserbedienung. Die abschließende
Browserprüfung muss die tatsächliche HTML-Datei über `file://` mit deaktiviertem
Netzwerk prüfen: gehaltenes Gehen, Touch, Außenszene, Figurenanimation,
Gespräche im Spiel, alle drei Übungsabläufe und Wiederherstellung.

`assemble-idle-gif.py` kann mit installiertem Pillow optional die tatsächlich
aufgenommenen Animationsbilder in ein GIF umwandeln. Der reguläre Prüflauf
benötigt weder Python noch einen GIF-Converter. Alte lokale Fehlerberichte,
frühere Dashboard-Demos und Build-Caches sind kein Bestandteil dieses Tools.
