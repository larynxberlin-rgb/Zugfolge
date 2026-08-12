# Deutschland-Semantikexport

`run-germany-import.mjs` filtert den gepinnten Deutschland-PBF auf das
Regelspurnetz und die benoetigten Kartenobjekte. Danach schreibt das
Rust-Beispiel `pbf_semantic_export` diese sieben GeoJSON-Sequenzlayer:

- `tracks.geojsonseq`
- `switches.geojsonseq`
- `signals.geojsonseq`
- `platforms.geojsonseq`
- `blocks.geojsonseq`
- `conflict-resources.geojsonseq`
- `rail-context.geojsonseq`

Jede Datei ist streng nach `properties.feature_id` sortiert. Die IDs binden
OSM-Elementkennung und, bei geteilten Gleiswegen, den stabilen Segmentbezug.
Der Bericht `semantic-export-report.json` pinnt Graph-, Layer- und Korpushashes.
Ungepruefte OSM-Daten erreichen nie Klasse A. Fehlende Hauptsignalgrenzen
vergroessern den konservativen Block bis zur naechsten belegten Grenze.
Richtungsbezogene `maxspeed:forward`-/`maxspeed:backward`-Werte haben Vorrang
vor `maxspeed`; nicht numerische Angaben fuehren zum sicheren B-Ersatzwert von
20 km/h auf Haupt- beziehungsweise 10 km/h auf Servicegleisen.

Signalbloecke liegen nicht allein: Eine zusaetzliche exklusive
`track_section`-Konfliktressource fasst jeden physischen Gleisarm zwischen
Weichen zusammen. Sie serialisiert bei unvollstaendiger Richtungsinformation
auch Gegenzuege, die sonst in benachbarten Signalbloecken aufeinander zufahren
koennten. Das kostet im Zweifel Kapazitaet, erfindet aber keine sichere
Begegnung.

Der Ausgabepfad darf vor dem Lauf nicht existieren. Der Exporter reserviert
`<ziel>.building`, schreibt und hasht dort alle Dateien und benennt das
Verzeichnis erst nach dem vollstaendigen Bericht zum Ziel um. Vorhandene Ziele
und parallele Bauverzeichnisse werden niemals ueberschrieben.

Direkter Lauf aus der Repositorywurzel:

```text
cargo run --locked --release -p zugfolge-infra --example pbf_semantic_export -- \
  data/infra/deutschland/2026/germany-ebo.osm.pbf \
  osm-pbf-deutschland \
  data/infra/deutschland/2026/semantic
```

Der Leser exportiert OSM-Knoten und -Wege. Multipolygon-Relationen werden in
dieser Stufe nicht rekonstruiert und muessen vor einer Vollabnahme als eigener
Coverage-Befund ausgewiesen werden.

## OpenStation-NeTEx

`run-openstation-netex-adapter.mjs` liest den vollständigen NeTEx-Snapshot
blockweise. Im Speicher liegt jeweils höchstens ein `StopPlace`; die stabile
Sortierung geschieht über eine temporäre SQLite-Tabelle. Der Zielpfad darf
nicht existieren und wird erst nach Hashprüfung und vollständig geschriebenem
Bericht atomar aus `<ziel>.building` umbenannt.

```text
node tools/region-import/germany/run-openstation-netex-adapter.mjs \
  sources/openstation-netex.xml \
  derived/openstation \
  EXPECTED_SOURCE_SHA256
```

Die Stufe schreibt normalisierte Stationsevidenz, einen Betriebsstellen- und
einen Bahnsteig-Punktlayer sowie einen Qualitätsbericht. Direkte Koordinaten
haben Vorrang. Fehlen sie, darf ausschließlich eine tatsächlich in NeTEx
enthaltene Koordinate eines untergeordneten Bahnsteig- oder Standortobjekts als
repräsentativer Punkt verwendet werden; der konkrete Quellbezug bleibt im
Evidenzobjekt erhalten. Ohne solchen Punkt bleibt die Koordinate unbekannt.
OpenStation-Evidenz allein hebt deshalb weder Station noch Bahnsteig über
Qualitätsklasse C an. Temporäre Quellkennungen werden ausdrücklich nicht als
jahresübergreifend stabil ausgegeben.
