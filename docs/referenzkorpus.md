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

M1.13 bleibt dennoch `in Arbeit`: Es fehlen der Modelllauf des exakt
zugehörigen `InfraRelease`, ein daraus bestandener Abweichungsreport und das
mit der realen Release-Identität signierte Bundle. Der GTFS-Capture selbst ist
nicht mehr die offene Arbeit.

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
   `model-results.json` ausgeben. Jeder Eintrag nennt `groupId`, dieselbe
   `characteristicsId` und `calculatedSeconds`; `releaseChecksum` bindet die
   Liste an den Release. Dann Korpus und Report erzeugen:

   ```bash
   node tools/reference-corpus/cli.mjs build \
     pilot.json artifacts/observations.json artifacts/model-results.json \
     artifacts/reference-corpus.json artifacts/deviation-report.json
   ```

   Ein fehlender Modelllauf, eine abweichende Charakteristik, zu wenige
   Vergleichsfahrten oder eine Toleranzüberschreitung beendet den Lauf mit
   Fehlerstatus.

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
