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

Der Legacy-Report besitzt zwei getrennte Zustände:

- `passed` sagt, dass die Rechnung innerhalb der technischen Toleranz liegt;
- `releaseQualified` sagt zusätzlich, dass der Wert aus einem unabhängigen
  Validierungssatz stammt.

Für den aktuellen Pilot gilt `passed: true`, aber `releaseQualified: false`.
Sein Schema `v2` enthält jetzt zusätzlich einen expliziten
`qualificationBlocker`. Selbst ein nachträglich eingesetztes
`qualification: "validation"` kann einen Legacy-Report nicht freigeben.

Ein releasefähiger `v3`-Report besitzt deshalb kein vertrauenswürdiges
`qualification`-Eingabefeld. Die Freigabe wird ausschließlich aus einem
gehashten `zugfolge-qualification-evidence/v1` abgeleitet. Der Nachweis bindet
je eine eingefrorene Kalibrierungs- und Validierungsdatei sowie deren getrennte
Auswertungskonfiguration. Folgende Bedingungen werden maschinell geprüft:

- Datensatz-ID, Datensatzhash, Konfigurations-ID und Konfigurationshash sind
  zwischen Kalibrierung und Validierung verschieden;
- die sortierten Stichproben-IDs besitzen eigene Hashes und überlappen nicht;
- beide Datensätze und Konfigurationen tragen denselben expliziten
  Einfrierzeitpunkt wie ihre jeweilige Partition;
- die bereits in der gehashten Capture-Konfiguration eingefrorene
  Mindestanzahl beider Partitionen ist erreicht;
- jedes Modellergebnis verweist auf genau eine Validierungsstichprobe, keine
  Kalibrierungsstichprobe, und alle eingefrorenen Validierungsstichproben werden
  genau einmal ausgewertet;
- technische Referenzsekunden, Referenzgruppe und Zugcharakteristik stammen
  aus dieser gebundenen Validierungsstichprobe, nicht aus einem freien Feld des
  Modellergebnisses.

Erst wenn alle Vergleiche innerhalb der vorab versionierten Toleranz liegen,
setzt der reproduzierte Report `passed: true` und `releaseQualified: true`.

### Durchgehende Hashkette

Das signierbare Bundle `zugfolge-pilot-release-bundle/v3` verweist auf eine
exakte Artefaktkettendatei. Die Ed25519-Signatur bindet deren Byte-Hash; die
Vollprüfung liest anschließend jedes Artefakt erneut und prüft jede Kante:

| Von | Nach | maschinell geprüfte Bindung |
|---|---|---|
| Capture-Konfiguration | Capture-Manifest | exakter Dateihash und kanonischer Inhalts-Hash |
| Capture-Manifest | ZIP und Tabellen | SHA-256, Bytezahl, vollständige geordnete Tabellenliste |
| Capture-Manifest | normalisierte Beobachtungen | Manifest-, Konfigurations-, Archiv- und Tabellenlistenhash |
| normalisierte Beobachtungen | Referenzkorpus | exakter Dateihash und Hash der kanonischen Beobachtungsliste |
| Referenzkorpus und Evidenzpartitionen | Modellkonfiguration | exakte Hashes aller Capture-, Korpus-, Kalibrierungs- und Validierungsartefakte |
| Modellkonfiguration | Modellergebnis | SHA-256 der unveränderten Konfigurationsbytes und identische Artefaktbindungen |
| Modellergebnis | Abweichungsreport | exakter Ergebnisdateihash; Report wird vollständig neu berechnet |
| Abweichungsreport | qualifiziertes Release-Manifest | exakte Hashes von Kandidat, Korpus, Evidenz, Ergebnis und Report |
| Release-Manifest | Bundle | exakter Manifesthash, Kettenhash und Release-Checksum unter Ed25519 |

`signBundle` akzeptiert im Prozess nur ein Bundle, das unmittelbar zuvor gegen
alle Dateien geprüft wurde. `verify-signature` prüft bewusst nur die
kryptographische Signatur und reicht nicht für eine Veröffentlichung;
`verify` ist die vorgeschriebene Vollprüfung der Signatur und jeder
Artefaktkante.

### Ehrlicher Pilotstatus und konkrete Voraussetzungen

Es wurde kein realer Pilot-Release erzeugt oder signiert. Der eingecheckte
Pilot bleibt ein bestandener Kalibrierlauf und ist aus folgenden, getrennt zu
behandelnden Gründen nicht releasefähig:

1. Das ursprüngliche Feed-ZIP, die gehashten Tabellen und das daraus erzeugte
   normalisierte Beobachtungsartefakt liegen nicht gemeinsam als prüfbare
   Artefaktmenge vor. Das vorhandene Capture-Manifest und der aggregierte
   Korpus ersetzen diese Dateien nicht.
2. Das Trassenfinder-Einzelbeispiel wurde zum Einstellen der effektiven
   Abschnittsgeschwindigkeiten verwendet. Es ist damit Kalibrierung, kein
   unabhängiger Validierungsholdout.
3. Es fehlen ein separat freigegebener technischer Validierungsdatensatz, eine
   getrennte eingefrorene Validierungskonfiguration und belastbare
   Infrastrukturprofile anstelle der effektiven Ersatzgeschwindigkeiten.
4. Nach Vorliegen dieser Eingaben muss der Modelllauf ein
   `zugfolge-model-results/v3` ohne behauptetes `qualification`-Feld und mit
   den exakten Artefaktbindungen erzeugen; erst danach kann der `v3`-Report
   reproduziert werden.
5. Zuletzt fehlen die namentliche Release-Freigabe und die Signatur mit dem
   außerhalb des Repositorys verwahrten echten Ed25519-Release-Schlüssel.

Die Punkte 1 bis 3 und 5 benötigen externe Datenbereitstellung,
Rechte-/Verantwortungsfreigabe oder Schlüsselzugriff. Sie dürfen weder durch
den synthetischen Positivtest noch durch neu heruntergeladene, inhaltlich
abweichende Daten ersetzt werden.

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

Der gehärtete Ablauf beginnt mit einer Capture-Konfiguration im Schema
`zugfolge-gtfs-capture/v2`. Alle Pfade in Evidenz-, Finalisierungs- und
Kettenkonfigurationen sind relativ zum angegebenen Artefaktordner.

1. GTFS-Feed herunterladen, sicher entpacken und Konfigurationsbytes, Archiv
   sowie jede Tabelle hashen:

   ```bash
   node tools/reference-corpus/cli.mjs capture-gtfs artifacts/capture-config.json artifacts/gtfs-raw artifacts/capture-manifest.json
   ```

2. Fahrten derselben `trip_id` normalisieren. Das Ergebnis ist ein Envelope mit
   den exakten Capture-Bindungen und dem Hash der Beobachtungsliste:

   ```bash
   node tools/reference-corpus/cli.mjs normalize-gtfs artifacts/capture-config.json artifacts/capture-manifest.json artifacts/gtfs-raw artifacts/normalized-observations.json
   ```

3. Den Referenzkorpus aus genau diesem normalisierten Artefakt bauen:

   ```bash
   node tools/reference-corpus/cli.mjs build-corpus artifacts/capture-config.json artifacts/normalized-observations.json artifacts/reference-corpus.json
   ```

4. Kalibrierungs- und Validierungsdatensatz sowie ihre getrennten
   Konfigurationen fachlich freigeben und unveränderlich ablegen. Ihre Pfade,
   Hashes, IDs, Stichproben-IDs, Mindestanzahlen und Einfrierzeitpunkte werden
   in `qualification-evidence.json` gebunden. Die Modellkonfiguration bindet
   diesen Nachweis und den Korpus; das Modellergebnis im Schema `v3` bindet die
   exakten Modellkonfigurationsbytes und verweist ausschließlich auf die
   Validierungsstichproben.

5. Report aus allen gebundenen Dateien reproduzieren. Die Datensatz- und
   Konfigurationsdateien aus dem Qualifikationsnachweis werden unter
   `artifacts/` erneut gehasht:

   ```bash
   node tools/reference-corpus/cli.mjs compare artifacts/capture-config.json artifacts/reference-corpus.json artifacts/model/model-results.json artifacts/qualification-evidence.json artifacts artifacts/deviation-report.json
   ```

6. Ein `finalize-config.json` mit `createdAt` und den relativen Pfaden
   `candidateManifest`, `referenceCorpus`, `qualificationEvidence`,
   `modelResults` und `report` erzeugt das exakte qualifizierte
   Release-Manifest. Dieser Schritt scheitert bei negativem oder
   unzureichendem Report:

   ```bash
   node tools/reference-corpus/cli.mjs finalize-release artifacts/finalize-config.json artifacts artifacts/release/qualified-release-manifest.json
   ```

7. Ein `artifact-paths.json` nennt die relativen Pfade aller Stufen und den
   Rohdatentabellenordner. Daraus wird die vollständige Kette erzeugt und noch
   vor dem Schreiben einmal vollständig geprüft:

   ```bash
   node tools/reference-corpus/cli.mjs chain artifacts/artifact-paths.json artifacts artifacts/release-chain.json
   ```

8. Erst die bestandene Kette darf mit explizitem Signaturzeitpunkt und dem
   nicht im Repository liegenden privaten Ed25519-Schlüssel signiert werden:

   ```bash
   node tools/reference-corpus/cli.mjs sign artifacts/release-chain.json artifacts release-private.pem 2026-08-10T00:00:00.000Z artifacts/pilot-release.bundle.json
   ```

9. Vor Veröffentlichung Signatur, exakte Kettendatei, jedes Artefakt und jede
   semantische Verbindung erneut prüfen:

   ```bash
   node tools/reference-corpus/cli.mjs verify artifacts/pilot-release.bundle.json release-public.pem artifacts
   ```

Der synthetische Positivtest in
[`synthetic-validation.mjs`](../tools/reference-corpus/fixtures/synthetic-validation.mjs)
materialisiert zwei getrennte eingefrorene Partitionen, erzeugt Report,
Release-Manifest und Kette und signiert ausschließlich mit einem kurzlebigen
Testschlüssel. Die Negativtests decken Überlappung, zu kleine Stichproben,
Toleranzverletzung, ein behauptetes `qualification`-Feld, jede semantische
Hashkante, jede veränderte Artefaktdatei, Bundle-Manipulation und einen falschen
Release-Schlüssel ab. Das ist ein Verfahrensnachweis, kein Pilot-Release.

Der zweite Verwendungszweck desselben gehashten Captures — Ableitung von
Fahrtenbildern, Linien, Losen und Ausschreibungsmengen — ist in
[`gtfs-angebotsplanung.md`](gtfs-angebotsplanung.md) dokumentiert.
