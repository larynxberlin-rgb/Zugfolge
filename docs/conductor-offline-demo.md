# Schaffnerspiel ohne Server testen

Die Offline-Demo ist eine einzelne HTML-Datei mit einer fiktiven Regionalzugfahrt,
40 tatsächlichen Fahrgästen und dem ursprünglichen Rust-Spielkern als WebAssembly.
Sie lässt sich direkt im Browser öffnen. Spielserver, Anmeldung und Netzverbindung
werden dafür nicht benötigt. Quellen, Übungsdaten und Bildherkunft stehen unter
[`tools/conductor-offline`](../tools/conductor-offline/README.md).

Nach `pnpm install --frozen-lockfile` erzeugt dieser Aufruf die Datei:

```sh
node tools/conductor-offline/build.mjs
```

Danach `outputs/conductor-offline/M15-Offline-Demo.html` öffnen und **Start** wählen.
Die CI stellt dieselbe Demo samt Prüfberichten als Artefakt `conductor-offline-demo`
bereit. Der Build verwendet die vorhandenen Workspace-Abhängigkeiten und die
gepinnten Bild-/WASM-Dateien. Er benötigt keine privaten Signierschlüssel.

## Spielen

- Einen Fahrgast anklicken oder antippen: Die Spielfigur geht auf dem tatsächlich
  begehbaren Weg zu ihm und beginnt dort die Kontrolle. Treppen gehören zum Weg.
- Pfeiltasten oder W A S D halten: gehen. Auf Touchscreens das Steuerkreuz halten.
  E oder Leertaste spricht die ausgewählte oder nächste Person an.
- **Fahrkarte prüfen** zeigt den tatsächlichen Befund. Antworten lassen sich im
  Spiel anklicken, antippen oder mit den Ziffern 1 bis 9 wählen.
- Die Auswahl **Übung 1–3** führt zu drei unterschiedlichen Kontrollfällen.
  Die Nummern verraten keinen Fahrscheinbefund vor der Prüfung.
- Eine Forderung bleibt als Ergebniskarte im Spiel sichtbar. Betrag und Zahlung
  aktualisieren sich nach den bestätigten Ereignissen. **Weitergehen** schließt
  die Anzeige; **Bericht** zeigt abgeschlossene und später veränderte Fälle.
- **Wagen und Deck** ändern den Bildausschnitt, **Zu mir** folgt der Figur.
  **Pause** führt zur Übersicht. **Fortsetzen** setzt denselben Einsatz fort;
  **Neu beginnen** startet eine neue Übungsfahrt.

Der Browser speichert den Stand lokal, soweit er dies für Datei-URLs erlaubt.
Die Übersicht und ein verdeckter Tab pausieren die Übungszeit. Längere
Unterbrechungen werden beim Wiederaufnehmen nicht als nachzuholende Fahrtzeit
gerechnet. Bei abruptem Schließen können noch ungespeicherte Gehschritte entfallen.

## Überarbeitete Darstellung und Kontrolle

Die neue Spielansicht enthält kompakte Pixelfiguren mit vier Gehrichtungen,
Blinzeln und kleinen Gesten. Die Atmung bewegt nur den oberen Spritebereich
um einen logischen Pixel. Die Füße und die tatsächlichen Positionen bleiben
dabei fest; individuelle Phasen verhindern synchrone Bewegungen aller Figuren.
Ganzzahliger Zoom und deaktivierte Bildglättung erhalten das Pixelraster.
Die Systemeinstellung für reduzierte Bewegung wird berücksichtigt.

Die Landschaft folgt der ursprünglichen Szenenprojektion der tatsächlichen
Zugbewegung. Die Oberfläche interpoliert nur zwischen bestätigten Positionen.
Ein eingebetteter Worker übernimmt die Rust-Berechnungen und private Checkpoints,
damit Gehen, Zeitfortschreibung und Speichern die Zeichenanimation nicht blockieren.
Zum lokalen Speichern übergibt er den serialisierten Checkpoint an die
Browserpersistenz; die Renderantworten enthalten nur öffentliche Projektionen.
Sprechblasen sind am tatsächlichen Gesprächspartner innerhalb der Spielansicht
verankert; Antworten und Ergebnisse stehen ebenfalls im Spiel.

Der Übungskorpus ergänzt die fehlenden Tarif-/Erwerbsbelege für durchreisende
Fahrgäste. Die native Kontrolle erhält damit auch für diese Fahrtketten die
benötigten Eingaben. Sie erzeugt weder pauschal eine Forderung noch pauschal
einen Abschluss ohne Forderung. Die drei geprüften Fälle sind eine gültige Karte,
eine reguläre Forderung über 60 Euro und eine vorläufige Forderung über 60 Euro
mit später bestätigtem Nachweis und Reduzierung auf 7 Euro. Sämtliche Beträge
gehören zur fiktiven Übung.

## Prüfung und Einordnung

```sh
node tools/conductor-offline/check.mjs
```

Der Prüflauf baut die HTML-Datei und prüft den ursprünglichen WASM-Kern,
Worker-/Restoreverhalten, Pausenbehandlung und die tatsächlichen Bedienwege.
Beide Browserfahrten laufen mit deaktiviertem Netzwerk gegen `file://`.
Sie prüfen Forderungen und Zahlungen, Gesprächsfortsetzung, Neustart,
gehaltene Tastatur-/Toucheingaben, Sprechblasen auf 320/390 Pixel breiten
Bildschirmen sowie gerenderte Atemphasen mit festen Fußpixeln. Die gemessene
Bildkadenz ist ein Ergebnis des jeweiligen Prüfhosts. Berichte und Bildhashes
werden an die tatsächlich geprüfte HTML-Datei gebunden.

Die Demo ist ein eigenständiges Testwerkzeug im PR. Die produktive LiveMap
verwendet weiterhin ihre autorisierte HTTP-/SSE-Oberfläche und die registrierten
Originalreleases. Die zusätzlichen Demo-Bilder sind mit Quellen, Prompts und
technischer Ableitung dokumentiert; sie werden nicht als neue produktive
Atlasfreigabe ausgegeben. Die Aufnahme der Demo schließt die offenen
Deutschland-/Gesamtabnahmebedingungen aus #215 und #222 nicht.
