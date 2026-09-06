# M10 — Integrierte Karten- und Bedienabnahme

Stand: 06.09.2026. Die drei Browserfälle in
[`demand-map-browser.e2e.test.ts`](../apps/game-api/src/demand-map-browser.e2e.test.ts)
prüfen die gebauten LiveMap- und Spielerplanungsanwendungen mit echten
MapLibre-Workern, MVT-Kacheln, PMTiles-Rangezugriffen und SSE-Aktualisierungen.
Alle drei Fälle bestehen. Zusammen mit den fünf vorhandenen M10-Browserfällen
sind damit acht M10-Browserfälle vorhanden.

## Korpus und Messgrenze

Die Daten sind ausdrücklich synthetisch. Der lokale Testserver liefert weder
einen produktiven Infrastrukturrelease noch reale Nachfragebeobachtungen.
Die Produktionsanwendungen importieren keine Testdaten, und der Test verändert
keine App-Globals oder Kartenfunktionen. Er bedient das tatsächlich gebaute UI.

[`createDemandMapFixture`](../apps/game-api/src/demand-map-fixture.ts) erzeugt
deterministisch:

| Bestandteil | Umfang |
|---|---:|
| Verteilte Teststationen im Deutschlandausschnitt | 5.000 |
| Zusätzliche Teststationen im dichten Knoten um Leipzig | 400 |
| Teststationen / synthetische Gleisabschnitte insgesamt | je 5.400 |
| Kacheln im PMTiles-v3-Archiv | 27 |
| Archivgröße | 1.300.655 Bytes |
| Gleichzeitig empfangene Zugprojektionen | 5.000 |
| Davon konzentrierte Knotenfahrten | 400 |
| Nachfrage je Cursorseite | 50 Gebiete + 50 Stationen |
| SSE-Last im Messfenster | 100 geänderte Züge je 200 ms, zwei Sekunden lang |

Die Deutschlandpunkte liegen auf einem gleichmäßigen Raster zwischen
6,2–14,714° Ost und 47,4–54,897° Nord. Der Knoten hat ein eigenes 20×20-Raster
um 12,3731° Ost / 51,3397° Nord. Dies ist eine räumlich verteilte und lokal
konzentrierte UI-Belastung; Gleisverläufe, Halte und Züge sind erfunden.
Zoomstufen 3–6 enthalten den Deutschlandausschnitt, 7–14 gezielt den Knoten.
Das Archiv enthält die echten, vom Client verwendeten Ebenennamen; die
zusätzlichen Infrastrukturtypen sind leere Ebenen. Der Fall belegt deshalb
keine Vollständigkeit eines Betriebs- oder Infrastrukturgraphen.

Die ersten 50 Nachfragepunkte sind deutschlandweit verteilt, die nächsten
50 liegen im Knoten. Alle 5.400 Einträge sind paginierbar; der Browser prüft
den Wechsel zwischen diesen beiden Seiten und die Begrenzung der Abfragen.
Die Legende benennt ihre Reichweite als „aktuelle Seite“. Der Test lädt
keine 5.400 Tabellenzeilen gleichzeitig in den DOM.

Die unveränderten lokalen Noto-Sans-Glyphen, ihr OFL-1.1-Lizenztext, die
Quellen und SHA-256-Belege liegen in
[`fixtures/demand-map-font`](../apps/game-api/src/fixtures/demand-map-font/README.md).
Das [Quellenregister](../tools/guards/quellenregister.json) führt den Import
als `maplibre-demotiles-noto-browserfixture`. Es gibt keine externe
Laufzeitabhängigkeit: Der Browserfall prüft, dass sämtliche HTTP-Anfragen
beim lokalen Testserver bleiben.

## Browserablauf und Ergebnis

Gemessen unter Windows mit Chrome **151.0.7922.170**, Playwright **1.62.1**,
Node **24.18.0**, pnpm **11.19.0**, headless und aktivierter
SwiftShader-Unterstützung. Jede Breite verwendet einen neuen Browserkontext,
900 Pixel Höhe und reduzierte Bewegung. Die Messung ist ein lokaler
Einzellauf; sie ist kein Vergleich verschiedener Geräte oder Grafiktreiber.

Die verbindlichen Budgets dieses Tests sind **15 Sekunden bis zur
Zugliste und zum ersten PMTiles-Rangezugriff**, **2 Sekunden bis zur sichtbaren
Nachfrageseite** und **250 ms für das p95 der RAF-Abstände unter Knotenlast**.
Der Startwert ist ausdrücklich kein First-Paint-Messwert. Zusätzlich bestätigt
eine echte MapLibre-Hoverreaktion auf gerenderte Kartenobjekte, dass im
Deutschlandüberblick interaktive Features angekommen sind. Ein direkter
Klick auf das echte Karten-Canvas öffnet anschließend am Knoten das
Auswahlmenü beziehungsweise das Detail des zentrierten Zuges FV 10000.

Messlauf vom 06.09.2026, 01:05 Uhr; drei Fälle erfolgreich in **18,61 s**:

| Viewport | Liste + erster Range | Deutschland-Feature gerendert und erreichbar | Nachfrage sichtbar | p95 RAF-Abstand im Knoten | RAF-Stichproben |
|---|---:|---:|---:|---:|---:|
| 1366×900 | 608 ms | 999 ms | 169 ms | 33 ms | 109 |
| 390×900 | 359 ms | 710 ms | 128 ms | 33 ms | 110 |
| 320×900 | 339 ms | 754 ms | 149 ms | 33 ms | 110 |

Der Lauf führte insgesamt 24 echte HTTP-Rangeanfragen aus. Der Test prüft
zusätzlich zur Zustellung der SSE-Nachrichten deren sichtbare Anwendung:
Die Verspätungszahl ändert sich vom Snapshotwert 500 auf 490 beziehungsweise
590. Das Sendeintervall wird auch bei einem Fehler im Messfenster zuverlässig
beendet. Die RAF-Werte begründen weder ein 60-fps-Versprechen noch eine
Millionenobjekt- oder Produktionslastfreigabe.

An allen drei Breiten werden außerdem geprüft:

- Nachfrage gezielt ein-/ausschalten, Legende und Zeit-/Herkunftsangabe;
  aktuelles Fenster ausdrücklich als „keine Zeitreihe“.
- Gebiets-/Stationsseiten, verständliche fehlende Belegung und getrennt
  bekannte Kapazität; tatsächliche Listenwahl eines Zuges.
- Sichtbare, kollisionsfreie Nachfragelegende neben den Kartenwerkzeugen;
  Suche auf schmalen Displays über den regulären aufklappbaren Überblick.
- Karte → ausgewählter Zug → SPFV-Formular → Rückweg zur ausgewählten Karte;
  Zugkennung, Suchfilter und eingeschaltete Nachfrage bleiben erhalten.
- Keine Browserexceptions oder Kartenfehler, auch nach Zoom, SSE-Last und
  Rücknavigation; keine externen HTTP-Anfragen.

## Sichtprüfung und gefundener Fehler

Die gerenderten PNGs wurden tatsächlich betrachtet. Der Deutschlandausschnitt
zeigt die räumlich verteilten synthetischen Züge; im Knoten ist die hohe
Markerdichte sichtbar. Bei dieser Dichte dienen die geprüfte Suche und die
zugängliche Zugliste zur eindeutigen Auswahl. Die Bilder behaupten keine
reale Strecken- oder Stationsgeographie.

Die erste Sichtprüfung fand eine Überlagerung der Nachfragelegende durch
„Deutschland / Gesamtes Spielnetz / Umgebung“. In
[`demand.css`](../apps/livemap/src/demand.css) wurde ihr unterer Abstand von
48 auf 120 Pixel erhöht. Ein Bounding-Box-Test verhindert für alle drei
Breiten eine erneute Schnittfläche mit den Kartenwerkzeugen. Ein zu früh
aufgenommener Deutschland-Zwischenframe wurde verworfen; die abgelegten Bilder
entstehen erst nach dem Nachweis gerenderter interaktiver Kartenobjekte.

| Geprüfte Ansicht | Bild |
|---|---|
| Deutschlandüberblick, 1366×900 | [PNG](screenshots/m10/demand-map-germany-1366.png) |
| Dichter Knoten, 1366×900 | [PNG](screenshots/m10/demand-map-node-1366.png) |
| Dichter Knoten, 390×900 | [PNG](screenshots/m10/demand-map-node-390.png) |
| Dichter Knoten, 320×900 | [PNG](screenshots/m10/demand-map-node-320.png) |

## Reproduzieren

Nach `pnpm install --frozen-lockfile` und mit verfügbarem Chrome/Chromium:

```sh
pnpm --filter @zugfolge/livemap... build
pnpm --filter @zugfolge/game-web... build
ZUGFOLGE_BROWSER_E2E=1 pnpm --filter @zugfolge/game-api exec vitest run src/demand-map-browser.e2e.test.ts --maxWorkers=1
```

PowerShell setzt die Variable vorher mit
`$env:ZUGFOLGE_BROWSER_E2E='1'`. Ein abweichender Browserpfad kann über
`ZUGFOLGE_BROWSER_EXECUTABLE` angegeben werden. Optional schreibt
`ZUGFOLGE_DEMAND_MAP_REPORT` die Messwerte als JSON und
`ZUGFOLGE_DEMAND_MAP_SCREENSHOT_DIR` die vier PNGs in das angegebene Verzeichnis.
Im regulären Lauf enthält die Konsolenausgabe dieselben Messwerte unter
`M10_MAPLIBRE_WORKLOAD`. API-Typecheck, alle 15 Wächter und `git diff --check`
wurden zusätzlich erfolgreich ausgeführt.

## Einordnung der Issues

Dieser Nachweis schließt die zuletzt fehlende UI-/UX-Prüfung von Datenmenge,
Kartenleistung und Listenalternativen im Deutschlandüberblick und dichten
Knoten für **#361** sowie der erreichbaren Legende, Zugwahl und nächsten
Handlung auf schmalen Displays für **#379**. Zusammen mit den vorhandenen
fachlichen API-, Berechtigungs-, SPFV- und UI-Nachweisen können beide Issues
im Umfang ihres jeweiligen Textes schließend mit **#534** verknüpft werden.
Die übrige kriteriumsgenaue Zuordnung steht im
[Issue-Abgleich](m10-issue-verknuepfung.md).

Die produktive Deutschland-Release-Qualifizierung, reale Nachfragekalibrierung,
autoritative Haltbelege, tatsächliche Betriebseinnahmen und eine externe
Spielerabnahme bleiben eigenständige Nachweise. Dieser synthetische
Browserfall ersetzt sie nicht und schließt weder #210/#173 noch den gesamten
Milestone allein ab.
