# Spiel-Fahrplan v1

Der Fünf-Argumente-Aufruf von `build-gtfs-region.mjs` erzeugt ausschließlich
eine Referenzvorstufe. Vor dem finalen Snapshot, Routecompiler und Weltdeployment
wird **verbindlich** eine reale Netzbindung übergeben, auch wenn GTFS Shapes
vorhanden sind:

```sh
node tools/region-import/build-gtfs-region.mjs WORLD-IDENTITY.json \
  GTFS-DIRECTORY YYYYMMDD ARCHIVE-SHA256 game-timetable.json NETWORK-BINDING.json
```

Die Netzbindung besitzt diese Form; Pfade beziehen sich auf ihr Verzeichnis:

```json
{
  "schemaVersion": "zugfolge-game-timetable-network-binding/v1",
  "tracksPath": "tracks.jsonseq",
  "corridorsPath": "official-corridors.jsonseq",
  "terminalCatalogPath": "operational-terminals.json",
  "permittedProtectionModes": ["pzb"]
}
```

Der Import nutzt denselben beobachteten Gleisgraphen wie der Routecompiler,
entfernt sämtliche Gleisgeometrien außerhalb der Karte und berücksichtigt
freigegebene Zugsicherungssysteme sowie explizite Richtungsbindungen. Fehlende
Gleisanker und nicht verbundene Nachbarhalte trennen Referenzlinien **vor** der
erneuten Fahrplangenerierung. Die abgelegten SHA-256-, Größen- und Dateibelege
unter `timetableGeneration.networkReference` binden den verwendeten Gleisbestand,
die Korridore und den Endpunktkatalog an den finalen Snapshot. Genau diese
Gleis- und Korridordateien sowie Zugsicherungssysteme sind anschließend für
den Routecompiler zu verwenden. Auch Leerfahrten bleiben auf diesem Graphen.

Der Endpunktkatalog hat einen eigenen Quellenbeleg. Folgendes Beispiel ist
**fiktiv** und kein freigegebener Betriebspunktbestand:

```json
{
  "schemaVersion": "zugfolge-game-timetable-terminals/v1",
  "sourceId": "fictional-operating-point-release/v1",
  "terminals": [
    {"stopId":"station-a","kind":"station","canTurn":true,"evidenceId":"fictional-reviewed-turnaround-a"},
    {"stopId":"halt-b","kind":"halt","canTurn":false,"evidenceId":"fictional-operating-point-b"},
    {"stopId":"station-c","kind":"station","canTurn":true,"evidenceId":"fictional-reviewed-turnaround-c"}
  ]
}
```

`stopId` ist eine exakte, geprüfte Zuordnung des Betriebspunktes zu einem
GTFS-Halt oder seiner `parent_station`; eine konkrete Plattformzuordnung hat
Vorrang. Die Bahnhofseigenschaft darf beispielsweise aus dem bestehenden
`operational-network.mjs`-Betriebspunktbestand (`raw.bahnhof === true`) und
der amtlichen `tf_station`-Korroboration des `operating-point-merge.mjs` stammen.
`canTurn` braucht zusätzlich einen nachvollziehbar geprüften betrieblichen
Wendebeleg. Bahnhofseigenschaft allein belegt keine Wendefähigkeit.
GTFS-`location_type`, Stationsnamen oder Zeichenfolgen wie „Hbf“ liefern
**keinen** solchen Nachweis. Fehlende Zuordnungen gelten als unbekannt.

Jeder zusammenhängende Binnenabschnitt wird auf das längste zusammenhängende
Intervall zwischen zwei nachweislich geeigneten, unterschiedlichen
Betriebspunkten gekürzt. Maß ist die Anzahl enthaltener Halte; bei Gleichstand
gewinnt der frühere Startindex der GTFS-Haltreihenfolge. Dadurch bleibt bei
einem Ring A–B–C–A das Intervall A–B–C erhalten. Haltepunkte dürfen Zwischenhalte
sein, niemals Endpunkte.
Fehlt ein geeignetes Paar, entfällt der Abschnitt. Dies gilt auch für bereits
innerhalb der Karte liegende ursprüngliche Anfangs- und Endhalte.

Erst danach entstehen neue Fahrten. Der Median positiver Referenzabstände
bestimmt den Takt, der Seed die Sekundenlage innerhalb des 60-Sekunden-Rasters.
Jeder Fahrtabschnitt und Zwischenhalt erhält seinen ganzzahligen Zeitmedian;
Wartezeiten an den weggefallenen Außenabschnitten und neuen Endpunkten entfallen.
Eine einzelne Referenzfahrt ergibt eine neue Fahrt. Maximal 100.000 Fahrten je
Linie beziehungsweise Frequenzreferenz und sichere ganzzahlige Sekunden sind
harte Eingabegrenzen. Tageszeiten über 24 Uhr bleiben ihrem Verkehrstag zugeordnet.

`lines[].adjustment` nennt ursprüngliche und tatsächliche Endpunkte samt
Wendebelegen. `timetableGeneration.adjustments` dokumentiert zusätzlich
verworfene Abschnitte. Gründe unterscheiden beibehaltene geeignete Endpunkte,
Kürzung auf geeignete Bahnhöfe und fehlende geeignete Endpunktpaare.
