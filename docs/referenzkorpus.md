# GTFS-Fahrplan-Referenzkorpus für M1.13

Der Referenzkorpus vergleicht Zugfolges eigene Fahrzeitrechnung mit
dem veröffentlichten Regionalverkehrs-Sollfahrplan von GTFS.DE/DELFI. Er ist kein fremder
„Goldstandard“ und keine Laufzeitabhängigkeit: Das Projekt baut den Korpus
selbst, hält die Herleitung prüfbar fest und signiert das Ergebnis zusammen mit
dem geprüften `InfraRelease`.

Der vollständige Ablauf ist in
[`tools/reference-corpus`](../tools/reference-corpus) implementiert. Neben der
Vorlage liegt dort inzwischen ein realer Pilotcapture vom 9. August 2026. Er
enthält 195 S5-/S5X-Fahrten zwischen Leipzig Hbf (tief) und Halle Hbf an fünf
Verkehrstagen. Das unveränderte Feed-ZIP ist über
`0c30da4378f24e287df5cdda9fa1fc12e982318f9353dca3d114642777702650`
gebunden; die technische P20-Referenz beträgt 1.380 Sekunden, Median 1.500 und
Mittelwert 1.474 Sekunden. Capture-Manifest, Tabellenhashes, Konfiguration und
abgeleiteter Korpus liegen unter
[`pilot/2026-08`](../tools/reference-corpus/pilot/2026-08).

Der erste versionierte Modelllauf liegt nun ebenfalls unter
[`pilot/2026-08`](../tools/reference-corpus/pilot/2026-08). Er ist ein bewusst
nicht nachkalibrierter Sensitivitätslauf auf der bereits vorhandenen,
provisorischen Korridorbeschreibung und **scheitert** mit 1.014 statt 1.380
Sekunden an der festen Toleranz von 69 Sekunden. M1.13 bleibt daher `in Arbeit`:
Es fehlen weiterhin ein aus belastbaren Infrastrukturprofilen gebauter
`InfraRelease`, eine je Fahrt belegte oder enger getrennte Zugcharakteristik,
ein bestandener Abweichungsreport und das mit der realen Release-Identität
signierte Bundle. Der GTFS-Capture und der reproduzierbare negative
Modellvergleich sind nicht mehr die offene Arbeit.

## Was genau verglichen wird

Ein Fahrplan enthält neben der technisch nötigen Fahrzeit auch Fahrplanreserven,
Kreuzungs- und Überholungswartezeiten. Ein bloßer Mittelwert würde diese Anteile
in das Fahrzeugmodell hineinrechnen. Der Korpus hält daher drei Größen getrennt:

| Größe | Berechnung | Zweck |
|---|---|---|
| technische Referenz | P20 der Sollfahrzeiten | robuste Annäherung an eine weitgehend unbehinderte Fahrt, ohne einen einzelnen Minimalwert zur Wahrheit zu erklären |
| typische Fahrplanzeit | Median | stabiler Vergleich mit dem veröffentlichten Fahrplan |
| sichtbarer Warte-/Reserveeffekt | Mittelwert sowie `Median − Modellzeit` | macht längere planmäßige Aufenthalte und Ausreißer sichtbar, statt sie im technischen Modell zu verstecken |

Verglichen werden ausschließlich Fahrten mit identischer Strecke, Richtung,
Haltefolge und `TrainCharacteristics`. Die Zuordnung einer veröffentlichten
Fahrt auf `characteristicsId` steht explizit in der geprüften Konfiguration.
Die Software leitet sie **nicht** allein aus `RE`, `ICE` oder einer Zugnummer ab.
Damit liegt auf beiden Seiten dieselbe Masse-/Längen-/Vmax-/Antriebs- und
Bremscharakteristik zugrunde.

Die Standardtoleranz ist der größere Wert aus 30 Sekunden und fünf Prozent der
technischen Referenz. Sie ist in der Capture-Konfiguration versioniert und darf
nicht nachträglich anhand des Ergebnisses verschoben werden.

## Ergebnis des ersten Modellvergleichs

`zugfolge-reference-model` baut aus
[`model-config.json`](../tools/reference-corpus/pilot/2026-08/model-config.json)
einen echten `OperatingGraph`, friert ihn als `InfraRelease` ein und rechnet die
drei Abschnitte mit M1.10 jeweils von Halt zu Halt. Der Release-Checksum ist
`3b891ef47ac78615465d67f01eb24a0e161b781b4ea689a207b0741200563cdd`, der
SHA-256 der unveränderten Modelleingabe
`f1a3cdfc5296da4ae12bc7c85acc511d322bc258997fe3626c29d6f598f0821b`.

Die Zwischenhalte werden nicht in die Fahrdynamik hineingerechnet. Aus
denselben 195 Fahrten des gehashten Captures ergibt sich je Komponente der P20:
0 Sekunden Aufenthalt in Leipzig Messe und 60 Sekunden am Flughafen. Diese 60
Sekunden werden nach der reinen M1.10-Fahrzeit addiert.

| Komponente | M1.10-Modell | GTFS-P20 | Abweichung |
|---|---:|---:|---:|
| Leipzig Hbf (tief) → Leipzig Messe | 178 s | 300 s | −122 s |
| Aufenthalt Leipzig Messe | 0 s | 0 s | 0 s |
| Leipzig Messe → Leipzig/Halle Flughafen | 324 s | 420 s | −96 s |
| Aufenthalt Leipzig/Halle Flughafen | 60 s | 60 s | 0 s |
| Leipzig/Halle Flughafen → Halle(Saale)Hbf | 452 s | 600 s | −148 s |
| **Gesamt** | **1.014 s** | **1.380 s** | **−366 s** |

Das Ergebnis liegt außerhalb der zulässigen ±69 Sekunden. Es wurde nicht durch
Herabsetzen von Vmax oder Beschleunigung passend gemacht. Die aktuelle
Korridorbeschreibung kennt nur drei angenommene Distanzen, durchgehend 160
km/h und ebene Gradiente; reale Geschwindigkeitswechsel, Neigungen und
Langsamfahranteile fehlen. Auch GTFS benennt keine konkrete Fahrzeugformation.
Die Characteristic `mdsb-talent2-v1` weist deshalb Masse, Länge sowie Anfahr-
und Bremsvermögen ausdrücklich als Annahmen aus. Die einzige externe
Flottenaussage ist, dass für die S-Bahn Mitteldeutschland 51 Talent-2-Züge
beschafft wurden ([DB Regio Geschäftsbericht 2013](https://ir.deutschebahn.com/fileadmin/Deutsch/2013/Berichte/2013_gb_dbregio_de-data.pdf)).

Damit beantwortet der Lauf eine wichtige Frage: Der Vergleichsweg funktioniert,
aber die heutige Pilotinfrastruktur ist für den M1-Abschluss noch nicht
ausreichend. Der fehlgeschlagene
[`deviation-report.json`](../tools/reference-corpus/pilot/2026-08/deviation-report.json)
ist ein versionierter Befund und darf nicht signiert werden; das Signatur-Gate
weist nicht bestandene Reports zurück.

## Quelle, Lizenz und Nachvollziehbarkeit

Die Quelle `gtfs-de-rv` ist im
[`Quellenregister`](../tools/guards/quellenregister.json) freigegeben. GTFS.DE
veröffentlicht den tagesaktuell aus DELFI-NeTEx-Daten erzeugten Feed
„Schienenregionalverkehr Deutschland“ unter **CC BY 4.0**. Jeder Pilotlauf
führt deshalb mindestens mit:

- „Datenquelle: DELFI e.V. / GTFS.DE; bearbeitet durch Zugfolge; CC BY 4.0“;
- Feed-URL, Abrufzeit und Fahrplanperiode;
- die vollständige Abruf- und Zuordnungskonfiguration;
- SHA-256 für das ZIP, jede verwendete GTFS-Tabelle und das Capture-Manifest;
- den Hinweis, dass P20, Median und Mittelwert eigene statistische Ableitungen
  des Projekts sind.

Der kostenfreie statische Feed braucht keinen API-Schlüssel. `feed.zip`, die
entpackten Tabellen und Release-Artefakte gehören in den getrennten,
versionierten Daten-/Release-Speicher; ins Quellrepository kommen Konfiguration,
Manifest, Report und Signaturnachweis, soweit der konkrete Release-Prozess dies
vorsieht. Vor dem Entpacken weist das Werkzeug absolute und aufwärts gerichtete
ZIP-Pfade zurück.

## Reproduzierbarer Ablauf

1. Die Beispielkonfiguration kopieren. Reale Verkehrstage, exakte Stationsnamen,
   Linienfilter, Haltefolgen und die fachlich passende `characteristicsId` prüfen. `retrievedAt`
   auf den tatsächlichen Abrufzeitpunkt setzen.
2. Den kostenfreien Regionalverkehrsfeed herunterladen, sicher entpacken und
   ZIP sowie alle verwendeten Tabellen hashen:

   ```bash
   node tools/reference-corpus/cli.mjs capture-gtfs \
     pilot.json artifacts/gtfs-raw artifacts/capture-manifest.json
   ```

3. `stops.txt`, `routes.txt`, `trips.txt`, `stop_times.txt` und Kalenderdaten
   zu Beobachtungen normalisieren. Start und Ziel müssen innerhalb derselben
   GTFS-`trip_id` in der richtigen Reihenfolge liegen:

   ```bash
   node tools/reference-corpus/cli.mjs normalize-gtfs \
     pilot.json artifacts/capture-manifest.json artifacts/gtfs-raw \
     artifacts/observations.json
   ```

4. Die Fahrzeitrechnung des exakt dazugehörigen `InfraRelease` als
   `model-results.json` ausgeben. Das versionierte Ergebnisobjekt nennt
   `releaseChecksum`, den Hash der Modelleingabe und eine `results`-Liste; jeder
   Eintrag enthält `groupId`, dieselbe `characteristicsId` und
   `calculatedSeconds`. Für den Pilotlauf:

   ```bash
   cargo run --locked -p zugfolge-reference-model -- \
     tools/reference-corpus/pilot/2026-08/model-config.json \
     tools/reference-corpus/pilot/2026-08/model-results.json \
     tools/reference-corpus/pilot/2026-08/pilot.infrarelease.json
   ```

   Danach Korpus und Report gemeinsam prüfen:

   ```bash
   node tools/reference-corpus/cli.mjs compare \
     tools/reference-corpus/pilot/2026-08/config.json \
     tools/reference-corpus/pilot/2026-08/reference-corpus.json \
     tools/reference-corpus/pilot/2026-08/model-results.json \
     tools/reference-corpus/pilot/2026-08/deviation-report.json
   ```

   Ein fehlender Modelllauf, eine abweichende Charakteristik, zu wenige
   Vergleichsfahrten oder eine Toleranzüberschreitung beendet den Lauf mit
   Fehlerstatus. Der derzeit eingecheckte Pilotlauf endet deshalb absichtlich
   mit Fehlerstatus, schreibt den negativen Report aber vorher vollständig.

5. Den bestandenen Report und den tatsächlichen `InfraRelease` mit dem
   Ed25519-Release-Schlüssel signieren:

   ```bash
   node tools/reference-corpus/cli.mjs sign \
     artifacts/reference-corpus.json artifacts/deviation-report.json \
     artifacts/pilot.infrarelease release-private.pem \
     artifacts/pilot-release.bundle.json
   ```

6. Vor Veröffentlichung und in CI mit dem bekannten öffentlichen Schlüssel
   Signatur und Artefakt-Hash prüfen:

   ```bash
   node tools/reference-corpus/cli.mjs verify \
     artifacts/pilot-release.bundle.json release-public.pem artifacts
   ```

Der private Schlüssel liegt niemals im Repository. „Signiert“ bedeutet hier
nicht „von einer fremden Organisation beglaubigt“, sondern: Eine benannte,
kontrollierte Release-Identität bindet unveränderlich Korpus, Report,
Release-Prüfsumme und Binärartefakt. Damit ist jede spätere Änderung erkennbar.

## Abnahmekriterien

M1.13 darf erst auf `erledigt` wechseln, wenn alle folgenden Nachweise zu
derselben Pilotperiode vorliegen:

- ein reales GTFS.DE-Capture mit gültiger Attribution und vollständigem Hash-Manifest;
- mindestens fünf gleichartige Fahrten je Referenzgruppe;
- dokumentierte, identische `TrainCharacteristics` je Gruppe;
- ein vollständig bestandener Abweichungsreport;
- ein signiertes Bundle und eine erfolgreiche unabhängige Verifikation mit dem
  veröffentlichten Release-Schlüssel.

Die Unit-Tests prüfen bereits Gruppierung, P20/Median/Mittelwert, exakte
Charakteristikbindung, Capture-Hashes und Manipulationserkennung der Signatur.
Sie ersetzen den echten Pilotlauf ausdrücklich nicht.

Der zweite Verwendungszweck desselben gehashten Captures — Ableitung von
Fahrtenbildern, Linien, Losen und Ausschreibungsmengen — ist in
[`gtfs-angebotsplanung.md`](gtfs-angebotsplanung.md) dokumentiert. Beide Pfade
verwenden denselben GTFS-Parser und dieselbe Verkehrstagslogik.
