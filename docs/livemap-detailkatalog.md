# Livemap-Detailkatalog

## Zweck und Bindung

Die Vektorkacheln tragen nur die Eigenschaften, die MapLibre zum Zeichnen und
Auswählen braucht. Die vollständigen deutschen Detailtexte liegen im
öffentlichen, unveränderlichen SQLite-Artefakt `read-model.sqlite`. Jede
Abfrage enthält `world_id`; jedes Objektdetail trägt zusätzlich den exakt
gepinnten `infrastructureReleaseId`. Eine Welt darf deshalb niemals Details
eines anderen Jahresrelease mit ihren Kacheln mischen.

Der Produktivadapter `SQLiteLivemapReadModel` öffnet die Datei ausschließlich
read-only, deaktiviert Erweiterungen und vertraute Schemas und bereitet nur
indizierte Einzelabfragen vor. Er liest den Deutschlandbestand weder beim
Start noch bei einer Kartenbewegung vollständig in den Arbeitsspeicher. Der
bisherige `PinnedLivemapReadModel` bleibt als bewusst begrenzter JSON-Adapter
für Tests und kleine lokale Fixtures erhalten. Die Dateiendung in
`LIVEMAP_READ_MODEL_PATH` wählt den Adapter fail-closed aus.

## Öffentliches Schema

Das Artefakt besitzt die SQLite-`application_id` `0x5a554746` und
`user_version=3`. Zulässig sind genau diese Tabellen:

| Tabelle | Inhalt |
|---|---|
| `metadata` | Schema-, Welt-, Release- und Verkehrstagskennung |
| `world_config` | selbst gehostete Karten-URLs und getrennte Spielbarkeitsmaske |
| `object_details` | deutsche Fachbezeichnung, Qualitätsklasse und freigegebene Fakten |
| `station_identifiers` | eindeutige EVA-, RL100- und Fahrplanhalt-Zuordnungen |
| `station_schedule_calls` | statische Ankunfts- und Abfahrtsplanwerte |
| `passenger_information` | Ziel und Folgehalte eines öffentlichen Zuglaufs |

Eigentümer-, Konto-, Fahrzeug-, Personal-, Kosten- und Geheimnisfelder sind
nicht Teil dieses Schemas. Die EVU-Zusatzsicht bleibt eine getrennt
autorisierte serverseitige Projektion. Der Paketprüfer prüft SQLite-Header,
`application_id`, `user_version`, die exakte Tabellen- und Spalten-Allowlist,
Fremdschlüssel und Stationsbezüge. Eine Textsuche nach vermeintlich privaten
Schlüsselwörtern ist kein Sicherheitsvertrag.

Die Metadaten enthalten genau den normalisierten Zeitvertrag
`world_epoch`, `time_zone`, `service_start_offset_s` und `repeat_every_s`
zusammen mit Welt, InfraRelease und GTFS-Verkehrstag. Für die öffentliche
Alpha-Welt gilt `Europe/Berlin`, Weltsekunde `0` als Servicebeginn und eine
tägliche Wiederholung von `86400` Sekunden. Fehlende, zusätzliche oder vom
signierten Runtime-Deployment abweichende Werte blockieren den Start.

## Interaktive Objekte

Der Builder liest alle sichtbaren interaktiven Ebenen des Deutschlandkorpus.
`rail_corridors` und `tracks` werden beide als `track` aufgelöst; ihre stabilen
Feature-IDs überschneiden sich nicht. `conflict_resources` erscheinen als
`facility`. Auch `rail_context` besitzt als `rail-context` ein anklickbares,
ausdrücklich nicht bestellbares Kurzdetail. Damit ist jede der zehn sichtbaren
Semantikebenen erreichbar, ohne Kartenkontext zur Betriebswahrheit zu machen.

Die Fachfakten werden über eine feste Allowlist aus den Importfeldern
abgeleitet. Ausgeliefert werden beispielsweise Streckennummer, Länge,
Geschwindigkeit, Elektrifizierung, Neigung, Blockgrenzen, Weichen- oder
Signalbezeichnung und betriebliche Nutzbarkeit. OSM-Roh-Tags, interne
Evidenzkennungen, APN-Namen und Evidenzhashes gelangen weder in Fakten noch in
die API.

## Bahnhofstafel und FIS

Der Fahrplangrundbestand stammt aus dem im Jahreslauf gepinnten
Regionalverkehrs-GTFS. Eine Fahrplanhaltestelle wird nur zugeordnet, wenn

1. ihre EVA-/UIC-Kennung genau und eindeutig passt, oder
2. der normalisierte Stationsname übereinstimmt, die Koordinate höchstens
   750 Meter entfernt liegt und kein fast gleich guter zweiter Kandidat
   existiert.

Nicht belegbare oder mehrdeutige Zuordnungen bleiben draußen. Es gibt keinen
Namens-Fuzzy-Match und keine erfundene RL100-Zuordnung. Der aktuelle
Jahreslauf bindet den Verkehrstag `20260810` und dieselbe Fahrtkettenkennung,
die der Alpha-Weltcompiler aus Welt, Region, GTFS-Release und Quellfahrt bildet.

Die SQLite-Datei speichert nur die Planwerte des Basistags. Beim API-Aufruf
projiziert sie diese deterministisch auf den aktuellen Servicetag und liefert
ab Tag 1 die konkrete Runtime-ID `basis:day-N`. Die API übernimmt Livezustand
und FIS-Basisplan nur, wenn `baseTrainRunId` diese Bindung kanonisch bestätigt;
die sichtbare FIS-ID bleibt stets die konkrete Runtime-ID. Anschließend wählt
sie die Ankünfte und Abfahrten im Zeitfenster des aktuellen Livemap-Cursors aus.
Die API legt anschließend den vorhandenen serverautoritativen Zugzustand
darüber: `expectedTimeS = scheduledTimeS + delaySeconds`; explizite Zustände
wie `cancelled`, `completed` und `at_platform` werden in Ausfall, angekommen,
abgefahren oder Einstieg projiziert. Ohne sichtbaren Livezug bleibt der
Planwert unverändert. Das FIS verwendet denselben Live-Cursor, entfernt schon
passierte Folgehalte und ergänzt die aktuelle Verspätungs- oder
Ausfallmeldung. Browserwerte beeinflussen keine dieser Projektionen.

## Clientdarstellung

Die Livemap bindet die selbst gehostete Basemap und das semantische
Deutschland-PMTiles über MapLibre/PMTiles. Alle zehn sichtbaren Fachlayer
besitzen anklickbare Trefferflächen und releasegebundene Deep Links; bei
Überlagerung entscheidet die in `design.md` festgelegte Fachpriorität. Das
Detailpanel erklärt Bezeichnung, Qualitätsklasse, Modellzustand und die für den
Objekttyp freigegebenen Fakten.

Ein Bahnhof öffnet zusätzlich eine generische Fallblattanzeige mit aktuellen
Ankünften und Abfahrten. Ein Zug öffnet die öffentliche Betriebssicht und den
aus Fahrgastsicht aufgebauten FIS-Monitor; nur beim eigenen Zug ergänzt eine
separate autorisierte Route interne EVU-Daten. Einschränkungen, Sperrungen und
explizit klassifizierte Baustellen werden als zustandsabhängige, auch ohne
Farbe unterscheidbare Gleisüberlagerungen gezeichnet. Keine dieser
Darstellungen ist eine zweite Datenwahrheit: Sie verwenden denselben
serverautoritativen Cursor und denselben gepinnten Infrastrukturrelease.

## Reproduzierbarer Jahreslauf

Die gepinnte Spezifikation liegt in
`tools/tiles/livemap-read-model.annual-2026.2.json`. Der reale Lauf lautet:

```bash
node tools/tiles/build-livemap-read-model.mjs \
  tools/tiles/livemap-read-model.annual-2026.2.json \
  var/derived/germany-2026.2/map-release/public/read-model.sqlite
```

Der Builder verarbeitet GeoJSON-Sequenzen und `stop_times.txt` streamend,
schreibt in stabiler Feature- und Fahrtreihenfolge, entfernt seine
GTFS-Arbeitstabelle vor `VACUUM` und erzeugt daneben
`read-model.sqlite.report.json`. Der Prüflauf ist:

```bash
node tools/tiles/inspect-livemap-read-model.mjs \
  var/derived/germany-2026.2/map-release/public/read-model.sqlite
```

Der reale Deutschlandlauf 2026 umfasst 1.600.662 Objektdetails, 189.097
Stationsaufrufe, 42.567 FIS-Zugläufe und 679 Stationen mit belastbar
zugeordnetem Fahrplan. Die Datei hat 1.291.001.856 Byte und den SHA-256
`c7e56cecb3db9aaae7994877894312ade91c536e7c5027e10e63045d7303ad21`.
Ein zweiter Vollauf mit denselben Eingaben erzeugte bytegleich denselben Hash.
Die Datei und der Bericht bleiben als Releaseartefakte außerhalb von Git.
