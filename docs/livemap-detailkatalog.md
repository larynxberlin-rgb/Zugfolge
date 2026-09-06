# Livemap-Detailkatalog

Die LiveMap ist das deutschlandweite Spielzentrum. Dieser Katalog beschreibt
ihre releasegebundenen Daten und Berechtigungen. Die aktuelle Navigation,
Spielertexte, Farben und kompakten Detailansichten stehen in
[Design](design.md) und [Spieleroberfläche](ux-spieler-shell.md); die
[Bildergalerie](ui-redesign/README.md) zeigt die Umsetzung mit Beispieldaten.

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
| `station_identifiers` | eindeutige EVA-, RIL-100- und Fahrplanhalt-Zuordnungen |
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

## Vollständiges Artefakt und Spielerprofil

Der Builder liest weiterhin alle zehn semantischen Ebenen des freigegebenen
A-/B-Deutschlandkorpus in das vollständige Artefakt. Ein ungelöster
Pflichtbefund bleibt ausschließlich in der internen Builddiagnose und
blockiert das gesamte Release; er darf nicht durch Weglassen eines Objekts
kaschiert werden.
`rail_corridors` und `tracks` werden beide als `track` aufgelöst; ihre stabilen
Feature-IDs überschneiden sich nicht. `conflict_resources` erscheinen als
`facility`. Auch `rail_context` besitzt als `rail-context` ein anklickbares,
ausdrücklich nicht bestellbares Kurzdetail. Damit bleibt jede Semantikebene für
Diagnose und releasegebundene Detailauflösung erreichbar, ohne Kartenkontext
zur Betriebswahrheit zu machen.

Das normale Spielerprofil ist eine davon getrennte Projektion. Es zeichnet nur
A-/B-Korridore beziehungsweise -Gleise, gruppierte Bahnhöfe, neutrale
Signalicons, betriebliche Overlays und Züge. Interaktiv sind Zug, gruppierter
Bahnhof und Strecke. `operating_points`, einzelne Bahnsteige, Weichen, Blöcke,
`conflict_resources`, Anlagen und `rail_context` werden trotz ihrer
A-/B-Qualifizierung dort nicht abgefragt und nicht gezeichnet. Der vollständige
Objektkatalog wird dadurch weder gekürzt noch in ein zweites Artefakt aufgeteilt.

Ein sichtbarer Bahnhof steht für eine releasegebundene Stationsgruppe, nicht
für einen Bahnsteig. Der Compiler liefert eine stabile Gruppenkennung und
einen Kartenanker; belegte RIL-100-, EVA/UIC- oder Quell-Gruppenreferenzen
begründen die Zusammenfassung. Der Client verwendet keine Namens- oder
Entfernungsheuristik. Bahnsteige werden erst innerhalb der Bahnhofstafel als
Fahrtinformation gezeigt.

Werkstätten sind ebenfalls markante Spielerorte, sobald ein eigener
autoritativ benannter Kartenvertrag vorliegt. Das aktuelle
`conflict_resources`-Tile enthält jedoch nur generische Ressourcentypen wie
Block, Weiche und Gleisabschnitt; es belegt weder einen Werkstatt-Subtyp noch
Namen oder Spielerrelevanz. Der Client darf diese Ressourcen deshalb nicht als
Werkstatt ausgeben. Ein künftiger `workshops`-Layer beziehungsweise ein
gleichwertiges Map-Readmodel muss mindestens stabile ID, Name, Koordinate,
Leistungsarten, Betreiber-/Zugangsstatus und Releasebindung tragen. Erst dann
erscheint eine Werkstatt als eigenes, markantes Symbol und öffnet ihre
Leistungs- und Verfügbarkeitsauskunft.

Die Fachfakten werden über eine feste Allowlist aus den Importfeldern
abgeleitet. Ausgeliefert werden beispielsweise VzG-Streckennummer,
Streckenkurzbezeichnung, Länge, Geschwindigkeit, Elektrifizierung, Neigung,
Blockgrenzen, Weichen- oder Signalbezeichnung und betriebliche Nutzbarkeit.
OSM-Roh-Tags, interne Evidenzkennungen, APN-Namen und Evidenzhashes gelangen
weder in Fakten noch in die API. Der gegenwärtige Release liefert keine
belastbare KBS-Bezeichnung. VzG-Nummer und Streckenkurzname werden nicht als
KBS umbenannt; eine spätere KBS-Angabe braucht Quelle, Gültigkeitszeitraum und
eine versionierte Segmentzuordnung.

## Bahnhofstafel und FIS

Der Fahrplangrundbestand stammt aus dem im Jahreslauf gepinnten
Regionalverkehrs-GTFS. Eine Fahrplanhaltestelle wird nur zugeordnet, wenn

1. ihre EVA-/UIC-Kennung genau und eindeutig passt, oder
2. der normalisierte Stationsname übereinstimmt, die Koordinate höchstens
   750 Meter entfernt liegt und kein fast gleich guter zweiter Kandidat
   existiert.

Nicht belegbare oder mehrdeutige Zuordnungen bleiben draußen. Es gibt keinen
Namens-Fuzzy-Match und keine erfundene RIL-100-Zuordnung. Der aktuelle
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
Deutschland-PMTiles über MapLibre/PMTiles. Das normale Spielerprofil erzeugt
nur für Zug, gruppierten Bahnhof und Strecke anklickbare Trefferflächen; bei
Überlagerung öffnet sich eine Auswahl der getroffenen Objekte. Die
erste Detailebene verwendet verständliche Spielertexte und wenige
handlungsrelevante Fakten. Qualitätsklasse, Modellzustand, Releasekennung,
technische ID und übrige freigegebene Fakten liegen standardmäßig geschlossen
unter „Technische Details“. Das technische Diagnoseprofil darf weiterhin alle
zehn Artefaktlayer per releasegebundenem Deep Link auflösen.

Die Karte startet mit ganz Deutschland. „Gesamtes Spielnetz“ zentriert die
serverseitig freigegebenen Netzgrenzen; diese Aktion erzeugt keine neue
Spielbarkeit. „Meine Züge“ filtert nach der tatsächlichen Unternehmenskennung.
Die Suche nach Zugnummer, Unternehmen oder nächstem Halt und die ausklappbare
Zugübersicht bieten einen zweiten Weg zu denselben Zugdetails. Auf Desktop
bleibt die Karte im Bildschirmrahmen, lange Detailinhalte scrollen innerhalb
ihres Panels. Auf kleinen Geräten lässt sich der Überblick gezielt einblenden.
Escape schließt ein Detail und stellt den Fokus am Ausgangspunkt wieder her.

Ein Bahnhof öffnet zusätzlich eine generische Fallblattanzeige mit aktuellen
Ankünften und Abfahrten sowie eine kompakte Grundauskunft aus Name, RIL 100,
EVA/UIC und Betriebsstellenart. Ein versioniertes
`StationSummaryReadModel` ergänzt später belastbare Kennzahlen wie
Fahrgastaufkommen, Zugfahrten, Pünktlichkeit und EVU-Anteile für einen
ausgewählten Zeitraum. Bis dieses Readmodel aus serverautoritativen Ereignissen
gebildet wird, zeigt die Oberfläche keine hochgerechneten
Langzeitstatistiken. Ein Zug öffnet die öffentliche Betriebssicht und den aus
Fahrgastsicht aufgebauten FIS-Monitor; nur beim eigenen Zug ergänzt eine
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

Der historische Deutschlandlauf 2026 umfasst 1.600.662 Objektdetails, 189.097
Stationsaufrufe, 42.567 FIS-Zugläufe und 679 Stationen mit belastbar
zugeordnetem Fahrplan. Die Datei hat 1.291.001.856 Byte und den SHA-256
`c7e56cecb3db9aaae7994877894312ade91c536e7c5027e10e63045d7303ad21`.
Ein zweiter Vollauf mit denselben Eingaben erzeugte bytegleich denselben Hash.
Die Datei und der Bericht bleiben als historische Buildartefakte außerhalb von
Git, sind nach dem heutigen A-/B-only-Vertrag aber nicht aktivierbar. Der
freigabefähige Neubau braucht `unresolvedRequired=0` und erzeugt neue Hashes.
