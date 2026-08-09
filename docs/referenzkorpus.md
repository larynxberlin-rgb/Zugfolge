# Technische Fahrzeitreferenz und GTFS-Fahrplan-Holdout für M1.13

M1.13 prüft zwei unterschiedliche Fragen. Sie dürfen nicht zu einer einzigen
„realen Fahrzeit“ vermischt werden:

1. **Technische Kalibrierung:** Bildet das eigene Fahrdynamikmodell die
   technisch mögliche Laufzeit einer vergleichbar konfigurierten Fahrt ab?
2. **Fahrplan-Holdout:** Wie viel Zeit sieht der veröffentlichte Fahrplan für
   dieselbe Linie, Richtung und Haltefolge vor?

[`tools/reference-corpus`](../tools/reference-corpus) hält beide Ebenen
getrennt. Die technische Referenz des Piloten ist ein manuell erzeugtes
Trassenfinder-Einzelbeispiel. Der unter CC BY 4.0 angebotene GTFS.DE-Feed dient
als unabhängiger Fahrplan-Holdout und als Quelle der planmäßigen Haltezeiten.
Keiner der beiden Dienste ist eine Laufzeitabhängigkeit des Spiels.

Der aktuelle Pilotlauf besteht die **Kalibrierung** mit 1.263 gegenüber 1.260
Sekunden. Er ist ausdrücklich `calibration-only` und noch nicht
`releaseQualified`: Weil derselbe Trassenfinder-Wert zum Einstellen und Prüfen
der effektiven Abschnittsgeschwindigkeiten verwendet wird, ist das Ergebnis
kein unabhängiger Validierungsnachweis und darf noch nicht signiert werden.

## Warum der erste Vergleich fehlschlug

Der erste versionierte Lauf meldete 1.014 gegenüber 1.380 Sekunden. Das war
nicht nur ein zu schnelles Modell, sondern ein fehlerhaft definierter
Vergleich:

- S5 und S5X wurden trotz unterschiedlicher Liniencharakteristik in einer
  Gruppe zusammengefasst, weil `trainCategory` im Gruppenschlüssel fehlte.
- Der P20 einer **Sollfahrzeit** wurde als „technische Referenz“ bezeichnet.
  GTFS enthält jedoch Fahrplanreserven und keine technische
  Infrastruktur-/Fahrdynamikberechnung.
- Die eigene Gesamtdauer enthielt 60 Sekunden Aufenthalt, während die
  Vergleichsgröße als technische Laufzeit bezeichnet wurde.
- Die Pilotstrecke bestand aus drei pauschalen 160-km/h-Segmenten. Reale
  Geschwindigkeitswechsel waren nicht modelliert.

Die Korrektur ist strukturell: Der Gruppenschlüssel enthält jetzt die
Linienkategorie, Halte- und Laufzeiten werden separat ausgewiesen, und nur eine
unabhängig berechnete technische Größe darf das Feld
`technicalReferenceSeconds` belegen. Die alten 1.014/1.380 Sekunden bleiben als
Audit-Historie nachvollziehbar, sind aber kein gültiger Modellvergleich.

## Technische Referenz aus dem Trassenfinder

Das versionierte, von Hand erstellte Ergebnisprotokoll liegt in
[`trassenfinder-reference.json`](../tools/reference-corpus/pilot/2026-08/trassenfinder-reference.json).
Es enthält keine automatisiert gespeicherte API-Antwort, sondern nur die
Abfrageparameter, die in der Weboberfläche abgelesenen gerundeten Kennzahlen,
den Zeitpunkt und die fachlichen Einschränkungen.

Abfrage vom 9. August 2026 für Fahrplanjahr 2026:

- Strecke: Leipzig Hbf (Tiefgleise) – Leipzig Messe Hp – Leipzig/Halle
  Flughafen – Halle (Saale) Hbf;
- Verkehrsart: Schienenpersonennahverkehr mit Triebwagen;
- Fahrzeugvorlage: `E-Tfz - DB 442 (4-teilig)`, Vmax 160 km/h,
  Bremshundertstel 160, Bremsstellung R+Mg, PZB und LZB;
- je eine Minute Aufenthalt an beiden Zwischenpunkten, damit beide als echte
  Halte mit Abbremsen und erneutem Anfahren gerechnet werden.

Der Trassenfinder weist 23 Minuten verstrichene Zeit aus. Seine Detailtabelle
trennt davon zwei Minuten Aufenthalt und summiert die technische Laufzeit auf
21 Minuten:

| Abschnitt | Distanz | technische Referenz |
|---|---:|---:|
| Leipzig Hbf (tief) → Leipzig Messe | 6,4 km | 300 s |
| Leipzig Messe → Leipzig/Halle Flughafen | 12,5 km | 420 s |
| Leipzig/Halle Flughafen → Halle Hbf | 18,1 km | 540 s |
| **Gesamt** | **37,0 km** | **1.260 s** |

Die Oberfläche rundet Zeiten auf volle Minuten und Distanzen auf 100 Meter.
Der Wert ist laut Betreiber ein unverbindlicher Richtwert aus einer
vereinfachten Berechnung in einem leeren Netz, keine Referenzwahrheit. Deshalb
bleibt die Quelle im Quellenregister auf `entwicklung`, wird nie automatisiert
abgerufen und qualifiziert für sich allein keinen produktiven `InfraRelease`.

## GTFS.DE als Fahrplan-Holdout

Der Pilotcapture vom 9. August 2026 bindet das unveränderte Feed-ZIP mit
SHA-256
`0c30da4378f24e287df5cdda9fa1fc12e982318f9353dca3d114642777702650`.
Die aktuelle Vergleichsgruppe enthält ausschließlich 85 S5X-Fahrten zwischen
Leipzig Hbf (tief) und Halle Hbf an fünf Verkehrstagen. S5-Fahrten werden nicht
mehr hineingemischt.

| GTFS-Größe | Ergebnis | Bedeutung |
|---|---:|---|
| Sollfahrzeit P20 | 1.380 s | robuster Fahrplan-Holdout |
| Sollfahrzeit Median | 1.380 s | typische veröffentlichte Fahrplanzeit |
| Sollfahrzeit Mittelwert | 1.440 s | macht längere Fahrplanlagen sichtbar |
| Soll-Laufzeit P20 | 1.320 s | Sollfahrzeit abzüglich Zwischenhalte; enthält weiterhin Reserve |
| Zwischenhalte P20 | 60 s | Leipzig Messe 0 s, Flughafen 60 s |

`scheduledRunningP20Seconds` ist trotz abgezogener Haltezeit keine technische
Referenz. Auch dieser Wert kann Fahrzeitreserven, Konstruktionsspielräume und
planmäßige Warteanteile enthalten.

## Kalibrierverfahren und Ergebnis

Das bisherige Modell kennt noch keine detaillierten Geschwindigkeitsbänder für
den Pilotkorridor. Der Modellläufer bestimmt deshalb deterministisch je
Abschnitt eine **effektive Ersatzgeschwindigkeit**. Er durchsucht ganzzahlige
Werte von 40 km/h bis zur Abschnitts-Vmax in Schritten von 1 km/h und wählt den
Wert mit der kleinsten Abweichung; bei Gleichstand gewinnt der höhere Wert.
Diese Ersatzwerte sind aggregierte Kalibrierparameter, keine Behauptung über
örtliche Streckenhöchstgeschwindigkeiten.

| Abschnitt | Rohmodell bei 160 km/h | effektive Geschwindigkeit | kalibriertes Modell | Referenz | Abweichung |
|---|---:|---:|---:|---:|---:|
| Leipzig Hbf (tief) → Leipzig Messe | 189 s | 83 km/h | 301 s | 300 s | +1 s |
| Leipzig Messe → Leipzig/Halle Flughafen | 326 s | 116 km/h | 421 s | 420 s | +1 s |
| Leipzig/Halle Flughafen → Halle Hbf | 452 s | 129 km/h | 541 s | 540 s | +1 s |
| **Gesamt** | **967 s** | – | **1.263 s** | **1.260 s** | **+3 s** |

Die vorab definierte Gesamttoleranz ist der größere Wert aus 30 Sekunden und
fünf Prozent der Referenz, hier also 63 Sekunden. Der technische
Kalibriervergleich besteht. Mit der aus GTFS getrennt übernommenen Haltezeit
von 60 Sekunden ergibt das Modell 1.323 Sekunden Fahrplanzeit. Gegenüber dem
S5X-P20 von 1.380 Sekunden bleiben 57 Sekunden Fahrplanreserve sichtbar; sie
werden nicht in Fahrzeug oder Infrastruktur hineinkalibriert.

Der Modelllauf ist an folgende Identitäten gebunden:

- `InfraRelease`-Checksum:
  `994ff2a6cc06bc9ce324f3691d30645765d574f44f09ea4f102e44c1ccd536d3`;
- SHA-256 der unveränderten Modelleingabe:
  `dbbb347c62f4cae0e0c6ad44b58bcae0fa1ae09bffa6990a41bab4509627ab4f`;
- SHA-256 des manuellen Referenzprotokolls:
  `1de4506127603bceac14f8c1542de35853df214b0dbb09c91e32b067e240b990`.

## Kalibrierung ist keine Release-Validierung

Der Report besitzt zwei getrennte Zustände:

- `passed` sagt, dass die Rechnung innerhalb der technischen Toleranz liegt;
- `releaseQualified` sagt zusätzlich, dass der Wert aus einem unabhängigen
  Validierungssatz stammt.

Für den aktuellen Pilot gilt `passed: true`, aber `releaseQualified: false`.
Das Signatur-Gate akzeptiert nur einen Report, bei dem beide Bedingungen
erfüllt sind. Damit kann ein passend kalibriertes Modell nicht versehentlich
als unabhängig bewiesener Release ausgegeben werden.

Für den Abschluss von M1.13 fehlen weiterhin:

- detaillierte, belastbare Infrastrukturprofile anstelle effektiver
  Ersatzgeschwindigkeiten;
- mindestens eine getrennte technische Validierungsstrecke oder ein vor der
  Validierung eingefrorener Referenzsatz, der nicht zur Kalibrierung diente;
- die Freigabe durch die benannte Release-Verantwortung und eine echte
  Ed25519-Signatur.

## Quellen, Rechte und Nachvollziehbarkeit

`gtfs-de-rv` ist im
[`Quellenregister`](../tools/guards/quellenregister.json) für den Offline-Import
freigegeben. Attribution, Feed-URL, Abrufzeit, Filterkonfiguration sowie ZIP-
und Tabellenhashes werden bewahrt; P20, Median und Mittelwert sind als eigene
statistische Bearbeitung gekennzeichnet.

Die Trassenfinder-Routensuche bleibt davon getrennt. Es gibt keinen API-Abruf,
keinen Rohdatenimport und keine Nutzung im Spiel. Das eingecheckte Protokoll ist
die minimale Dokumentation einer einzelnen, unmittelbar für diese Kalibrierung
verwendeten manuellen Webabfrage. Die offizielle Einschränkung automatisierter
oder zweckfremder Speicherung bleibt im Quellenregister sichtbar; vor einer
systematischen Referenzsammlung ist eine ausdrückliche Freigabe des Betreibers
einzuholen. Das ist eine konservative Projektregel, keine Rechtsberatung.

## Reproduzierbarer Ablauf

1. GTFS-Feed herunterladen, sicher entpacken und hashen:

   ```bash
   node tools/reference-corpus/cli.mjs capture-gtfs \
     pilot.json artifacts/gtfs-raw artifacts/capture-manifest.json
   ```

2. Fahrten derselben `trip_id` normalisieren. Linie, Richtung, Haltefolge und
   `characteristicsId` werden explizit gefiltert:

   ```bash
   node tools/reference-corpus/cli.mjs normalize-gtfs \
     pilot.json artifacts/capture-manifest.json artifacts/gtfs-raw \
     artifacts/observations.json
   ```

3. Das manuell erstellte technische Referenzprotokoll fachlich prüfen und
   dessen Hash in `model-config.json` binden. Dann Modell und Manifest bauen:

   ```bash
   cargo run --locked -p zugfolge-reference-model -- \
     tools/reference-corpus/pilot/2026-08/model-config.json \
     tools/reference-corpus/pilot/2026-08/model-results.json \
     tools/reference-corpus/pilot/2026-08/pilot.infrarelease.json
   ```

4. Technische Referenz und Fahrplan-Holdout vergleichen:

   ```bash
   node tools/reference-corpus/cli.mjs compare \
     tools/reference-corpus/pilot/2026-08/config.json \
     tools/reference-corpus/pilot/2026-08/reference-corpus.json \
     tools/reference-corpus/pilot/2026-08/model-results.json \
     tools/reference-corpus/pilot/2026-08/deviation-report.json
   ```

5. Erst ein bestandener **und** unabhängig qualifizierter Report darf mit dem
   nicht im Repository liegenden Ed25519-Release-Schlüssel signiert werden:

   ```bash
   node tools/reference-corpus/cli.mjs sign \
     artifacts/reference-corpus.json artifacts/deviation-report.json \
     artifacts/pilot.infrarelease release-private.pem \
     artifacts/pilot-release.bundle.json
   ```

6. Vor Veröffentlichung Signatur und Artefakt-Hash prüfen:

   ```bash
   node tools/reference-corpus/cli.mjs verify \
     artifacts/pilot-release.bundle.json release-public.pem artifacts
   ```

Die Tests prüfen zusätzlich die Trennung von S5 und S5X, die Benennung der
GTFS-Werte, Haltezeitbildung, Hashbindungen, das Kalibrier-/Validierungsgate und
die Manipulationserkennung der Signatur.

Der zweite Verwendungszweck desselben gehashten Captures — Ableitung von
Fahrtenbildern, Linien, Losen und Ausschreibungsmengen — ist in
[`gtfs-angebotsplanung.md`](gtfs-angebotsplanung.md) dokumentiert.
