# Einwohnerbasierte Stationsnachfrage

Dieser Offlineadapter füllt den bestehenden `DemandReleaseV1` mit amtlichen
Einwohnern, eigenen Stationsklassen und ungefähren Wunschzielpräferenzen. Der
Rust-Kern erzeugt anschließend die Fahrgäste und verteilt sie auf Spielangebote.
Der Adapter berechnet keine Fahrgastverbindungen und führt keinen zweiten
Nachfragekern ein. Fachvertrag: [M10.5](../../docs/m10-populationsnachfrage.md).

Der Offlineimport ist die Erstbefüllung. Die laufende Datenpflege erfolgt über
normales Speichern in Odoo und den signierten Befehl `demand.data.update`.
Die Game-Seite prüft und speichert die Quellenrevision in ihrer Datenbank;
hierfür gibt es keinen zusätzlichen Freigabeantrag und keine neue Importdatei
pro Änderung. Die nachfolgend beschriebenen Dateien dokumentieren die
reproduzierbare Ausgangsbasis.

## Freie Quellen und unveränderte Fakten

| Bestand | Stand / Auswahl | Lizenz und Namensnennung |
|---|---|---|
| BKG VG250-EW | Einwohner am 31.12.2024; neun ausgewählte Gemeinden aus 10.956 Gemeinden/Gebieten | © BKG 2026 [dl-de/by-2-0](https://www.govdata.de/dl-de/by-2-0), [BKG](https://www.bkg.bund.de), [Datenquellen](https://sgx.geodatenzentrum.de/web_public/gdz/datenquellen/datenquellen_vg_nuts.pdf) |
| GTFS.DE Regionalverkehr | Abruf 06.09.2026; aktive Fahrten vom 07.–13.09.2026, zwölf explizite Haltkennungen | DELFI e.V. / GTFS.DE, [RV-Feed](https://gtfs.de/de/feeds/de_rv/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| GTFS.DE Fernverkehr | derselbe Abruf und dieselben sieben Verkehrstage | DELFI e.V. / GTFS.DE, [FV-Feed](https://gtfs.de/de/feeds/de_fv/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |

Änderungen durch Zugfolge: Auswahl, Normalisierung, Koordinaten in E7,
Kalenderauswertung, Zusammenfassung gerichteter Direktverbindungen und eigene
Modellableitung. Quellenrechte stehen im [Quellenregister](../guards/quellenregister.json)
und im [Quellenbericht](../../docs/m10-populationsquellen.md). Die Originalarchive
werden ausschließlich außerhalb des Repositorys gespeichert. Ihre SHA-256-Pins:

```text
BKG d5564af137d2dde65c23ceb8336f6c35fdf67260ba48058ced9004a2c5c000b3
RV  8ff77cb6bed7375d4cce5aa8f2027bfffe7e74bbc4bccd859237a96f2da24162
FV  5e3efe3b3be69fb4bbbed0efc3fd8c2d8a0481c6a102a901ab1dc68219e45d40
```

`sources/population.json` enthält die ausgewählten amtlichen Fakten.
`sources/reference-timetable.json` enthält die Original-Haltkennungen,
Koordinaten und ausgewählten Halte der 2.710 aktiven Quellfahrten. Weder
Population noch Quellzeiten werden auf ein gewünschtes Simulationsergebnis
angepasst. Eine geänderte Quelldatei muss erneut gegen ihr freigegebenes Original
erzeugt und geprüft werden; das bloße Ändern eines Konfigurationshashes ist kein
neuer Herkunftsbeleg. Neue Originalstände benötigen neue überprüfte Quellenpins.

Die Feedrolle ist ein Herkunftsmerkmal. `route_type=2` beweist keine individuelle
Verkehrskategorie; die Referenzgewichte benötigen diese Unterscheidung nicht.
Die ausgewählten Direktverbindungen umfassen 9.365 Belege aus dem RV-Feed und
886 aus dem FV-Feed. Eine Quellfahrt zählt je Verkehrstag und gerichtetem
Stationspaar höchstens einmal. Wiederholte Halte vervielfachen den Beleg nicht.
Die beiden Originalarchive besitzen disjunkte `trip_id`-Mengen. Künftige
Überlappungen werden zur ausdrücklichen Klärung abgewiesen.

Kalenderausnahmen bleiben wirksam. 309 ausgewählte Quellhalte liegen nach
24 Uhr und bleiben beim ursprünglichen Verkehrstag. Nur unbedingte Ein- und
Ausstiegsmöglichkeiten zählen als Direktverbindungsbeleg; GTFS-Typ 1, 2 und 3
geben an dieser Stelle kein unbedingtes Ein-/Ausstiegsrecht. Feeds mit
`frequencies.txt` werden bis zu einem ausdrücklichen Expansionsadapter abgewiesen.

## Einzugsgebiet, Klassen und Reiseannahmen

`config.json` pinnt die ausgewählten amtlichen Gemeindeschlüssel, ursprünglichen
GTFS-`stop_id`, sieben Verkehrstage, Quellen, 10-km-Einzugsradius und Reiseparameter.
`parent_station` bleibt ein Herkunftsfeld. Beispielsweise ist `85981` ein
tatsächlich bedienter Halt in Halle; andere Bahnsteigkennungen und der Parent
`719` werden nicht heimlich darauf umgeschrieben. Die Stationsauswahl begrenzt
folglich auch die erfassten Fahrten. Erfurt wird durch den originalen Stop
`542001` mit dem Quellnamen „Hauptbahnhof“ vertreten.

Für Deutschland wird ein ausdrücklich vereinfachtes ganzzahliges Distanzmaß
verwendet. Es ist keine territoriale Gemeindezuordnung, keine tatsächliche
Gehentfernung und kein feinräumiges Bevölkerungsraster:

```text
dx = abs(StationslängeE7 − OrtskernlängeE7) × 7000 // 1000 mm
dy = abs(StationsbreiteE7 − OrtskernbreiteE7) × 11132 // 1000 mm
Distanz = isqrt(dx² + dy²)
Gewicht einer erreichbaren Station = max(1, Radius − Distanz)
```

Jede Gemeinde verteilt ihre Einwohner nach diesen Gewichten per ganzzahliger
Größte-Reste-Methode. Bei gleichen Resten entscheidet die Stationskennung.
Ohne ausgewählten Zugang im Radius wird die Gemeinde vollständig als
unerschlossen ausgewiesen. Im Beispiel werden 1.245.193 Einwohner aus acht
Gemeinden genau einmal zugeteilt; Querfurt mit 10.007 Einwohnern liegt außerhalb
der Auswahlreichweite. Das ist keine deutschlandweite Abdeckung.

Leipzigs 611.850 Einwohner werden auf Hbf (256.596), Hbf tief (256.803) und Messe
(98.451) verteilt. Schkeuditz verteilt 18.905 Einwohner auf Schkeuditz (10.807)
und den Flughafen (8.098). Auch Erfurt besitzt zwei Zugänge. Die Klassen 0–10
werden exakt nach dem Fachvertrag aus der zugeteilten Bevölkerung bestimmt;
sie erhöhen die Nachfrage nicht ein zweites Mal. Flughafen-, Arbeitsplatz- und
Tourismussonderfaktoren werden mangels Quellen nicht als beobachtet behauptet.

Die Beispielpolitik ist eigenes Balancing: täglich 1 % Reisequote, ein allgemeines
Profil, 5 Minuten Zugang, keine behauptete Barrierefreiheit, Tagesanteile
5/30/20/30/15 % für Nacht/Morgen/Tag/Nachmittag/Abend, neutrale Saison.
Arbeitsplätze und POI-Gewichte sind Null, Zielattraktivität nutzt Bevölkerung.
Der Rust-Kern ergänzt den begrenzten Direktverbindungsbonus. Aktuelle
Spielerangebote verändern diese exogene Grundlage nicht.

## Reproduzieren und in ein Deployment übernehmen

Ohne Netzwerk und ohne Python-Zusatzpakete:

```sh
python tools/population-demand/build_population_demand.py \
  --config tools/population-demand/config.json \
  --population tools/population-demand/sources/population.json \
  --reference tools/population-demand/sources/reference-timetable.json \
  --output tools/population-demand/example
```

Zur Reproduktion aus den Originalen normalisiert `import_population.py` den
geprüften BKG-ZIP-Bestand. Der Builder akzeptiert dessen vollständiges JSON
ebenso wie den identischen ausgewählten Ausschnitt; der Auswahlhash bezieht
sich auf die in `settlementIds` benannten Gemeinden.

```sh
python tools/population-demand/import_population.py --input /cache/bkg.zip \
  --expected-sha256 d5564af137d2dde65c23ceb8336f6c35fdf67260ba48058ced9004a2c5c000b3 \
  --output /cache/population-2024.json

python tools/population-demand/build_population_demand.py \
  --config tools/population-demand/config.json --population /cache/population-2024.json \
  --reference tools/population-demand/sources/reference-timetable.json \
  --rv-gtfs /cache/gtfs-rv-2026-09-06.zip --fv-gtfs /cache/gtfs-fv-2026-09-06.zip \
  --output /cache/population-release
```

Ein bestehendes, geprüftes Spielangebot wird mit
`--deployment-template /path/demand-deployment-template.json` übernommen.
Der Adapter ersetzt ausschließlich den Nachfragerelease der ungestarteten
Fenster. Welt, InfraRelease-ID, Fahrten, Kapazitäten und Spielzeiten bleiben
aus der Vorlage erhalten. Auch gemeinsame `generationWindows` werden
unterstützt. Zusätzliche Fahrthalte ohne eigene Nachfragezone sind zulässig;
die exakte Infrastrukturbindung prüft wie bisher die Game-API. Die
Reiseprofil-/Tagesgangpolitik muss zu den Zeitfenstern der Vorlage passen.

`example/deployment.json` ist ein technisches Beispiel mit 18 **eigenen
synthetischen Spielzügen**, getrennt erzeugt durch `make_demo_deployment.py`.
Die ID `population-demo-infrastructure-unapproved` besitzt ausdrücklich keinen
signierten Betriebsbeleg. Der GTFS-Import aktiviert keine realen Referenzzüge
als Spielerangebot. Für eine echte Welt braucht die Vorlage deren tatsächliche
Welt-, Stations-, InfraRelease-, Halt- und Fahrtbindung; die vorhandenen
API-Gates gelten weiter. Die Serverkonfiguration übernimmt anschließend den
absoluten Deploymentpfad und dessen Dateihash über
`ZUGFOLGE_DEMAND_DEPLOYMENT_PATH` und `ZUGFOLGE_DEMAND_DEPLOYMENT_SHA256`.

Für den echten Kernlauf und dessen Replay:

```sh
cargo build --locked -p zugfolge-demand --example evaluate_json
python tools/population-demand/make_demo_deployment.py
python tools/population-demand/build_population_demand.py \
  --config tools/population-demand/config.json \
  --population tools/population-demand/sources/population.json \
  --reference tools/population-demand/sources/reference-timetable.json \
  --deployment-template tools/population-demand/demo-deployment-template.json \
  --binary /absolute/target/debug/examples/evaluate_json \
  --output tools/population-demand/example
```

Unter Windows endet der Binaryname auf `.exe`. Der gespeicherte Bericht weist
3.729 erzeugte Reisen, 2.562 bediente Bahnreisen und 1.167 unbediente Wünsche aus.
540 Reisen verwenden SPFV, 2.146 SPNV; Reisen mit beiden Verkehrsarten sind in
beiden Teilzahlen enthalten. `native-summary-0.json` aggregiert Wunschziele
ausschließlich aus tatsächlich erzeugten Rust-Kohorten und enthält keine
Fahrgastschlüssel oder privaten Tarifmerkmale. Das Ergebnis ist eine ungefähre
Modellrechnung, kein Nachweis tatsächlich beobachteter Fahrgastzahlen.

`report.json` bindet Konfiguration, ausgewählte Quellenfakten, Referenzfahrplan,
Originalarchive, Release, Deployment, native Binary und beide identischen
Ergebnisse per SHA-256. Der `referenceTimetable.artifactSha256` entspricht dem
kanonischen Hash des im Bericht gespeicherten `inputBinding`-Objekts.

```sh
ZUGFOLGE_DEMAND_TEST_BINARY=/absolute/target/debug/examples/evaluate_json \
  python -m unittest discover -s tools/population-demand -p 'test_*.py'
```

Die bestehenden vier CI-Jobs enthalten diesen Lauf einschließlich des echten
Rust-Beispielprogramms. Die Grenzen von 200 Zonen je Release, 100.000 erzeugten
Fahrgästen je Kernpool und 16 MB je Deployment bleiben erhalten. Ein nationaler
Quellenbestand kann offline verarbeitet werden; ein bundesweiter Betrieb
braucht passend begrenzte Pool-/Releaseausschnitte und eine übergreifende
Prüfung, dass sich deren Einwohnerbudgets nicht überschneiden.
