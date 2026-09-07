# Reproduzierbarer M15.5-Quellencompiler

Der Offline-Compiler verbindet reale InfraGO-Betriebsstellen, OpenStation-
Stationsdaten und BKG-Ortskerne/Einwohner. Er schreibt keine Infrastruktur,
keine Signalstellungen und keine Zugbewegungen. Fachvertrag:
[conductor-scenes.md](../../docs/conductor-scenes.md).

Die eingecheckte Auswahl unter `sources` stammt aus den unveränderten,
per SHA-256 geprüften Originalen. Sie enthält neun reale Stationen zwischen
Leipzig Hbf und Wurzen sowie sämtliche 112 Gemeinden im ausgewiesenen
geografischen Auswahlfenster. Alle drei Grafikgrößen sind durch beobachtete
OpenStation-Kategorien vertreten. Tagesbedienungen bleiben unbekannt (`null`).
Die Urbanität ist ausdrücklich die grobe eigene Einwohner-/Ortskernpolicy,
keine beobachtete Bebauungsgrenze.

```sh
node --test tools/conductor-scenes/source-compiler.test.mjs
cargo test -p zugfolge-conductor-scenes --all-targets
cargo clippy -p zugfolge-conductor-scenes --all-targets -- -D warnings
cargo build -p zugfolge-conductor-scenes --example scene_json
```

Der erste Test baut aus `sources/selection.json` den gesamten Katalog erneut
und vergleicht jedes Byte mit dem eingecheckten Katalog und seinem Nachweis.
Weitere Tests sperren unbekannte Routen, fehlende tatsächliche Plattformen,
abweichende Infra-Bytes und unvollständige räumliche Abdeckung. Der echte
Rust-OperationalWorld-Test fährt drei Halte mit zwischenzeitlichem Signalhalt,
prüft Restore und unveränderten Betriebszustand sowie alle 10.001 möglichen
Urbanitätswerte. Seine Infrastruktur ist ausdrücklich eine fiktive
Kern-Teststrecke; sie wird nicht in den realen Quellenkatalog umetikettiert.

## Auswahl erneut aus Originalbytes erzeugen

`capture-sources.mjs` liest ausschließlich bereits heruntergeladene Originale.
Der große Cache liegt außerhalb Git. Seine Originalpins sind absichtlich
fest; geänderte Live-Downloads verlangen einen neuen dokumentierten Capture.

1. InfraGO-GeoPackage unter `CACHE/infrago-2026-05.gpkg` bereitstellen:
   [offizieller Download](https://mobilithek.info/mdp-api/files/aux/922109165921083392/Infrastrukturdaten.gpkg).
   54.587.392 Bytes, SHA-256
   `79f8227e889769d87dcc77301f58adbc93a31839febb0cd1bdb16679e25453fe`.
2. [OpenStation-NeTEx](https://bahnhof.de/daten/netex) unter
   `CACHE/openstation-2026-09-06.xml` bereitstellen. Der tatsächlich geladene
   Publikationsstand `2026-09-06T02:21:12.756Z` hat 304.632.283 Bytes und SHA-256
   `f1df5067758e9c25d0129b033ec963012fbb2aaffca3abf4b61cfeba534a35cb`.
3. Den vollständigen [BKG-Einwohnerimport](../../docs/m10-populationsquellen.md)
   als `POPULATION/population-2024.json` und dessen unverändertes Original
   `POPULATION/vg250-ew-2024-excel.zip` bereitstellen. JSON-SHA-256
   `46388da8822295a15df02c9fc11f04c54f15bbf4c4be5cc3879925b63c030fa6`;
   ZIP-SHA-256 `d5564af137d2dde65c23ceb8336f6c35fdf67260ba48058ced9004a2c5c000b3`.

```sh
node tools/region-import/germany/run-infrago-gpkg-adapter.mjs \
  CACHE/infrago-2026-05.gpkg CACHE/normalized \
  79f8227e889769d87dcc77301f58adbc93a31839febb0cd1bdb16679e25453fe
node tools/region-import/germany/run-openstation-netex-adapter.mjs \
  CACHE/openstation-2026-09-06.xml CACHE/openstation \
  f1df5067758e9c25d0129b033ec963012fbb2aaffca3abf4b61cfeba534a35cb
node tools/conductor-scenes/capture-sources.mjs \
  CACHE POPULATION/population-2024.json OUTPUT
```

Die vorhandenen Adapter prüfen ihre Quellstrukturen; der Capture prüft die
Originalhashes und dokumentiert zusätzlich alle normalisierten Hashes.
`sources/evidence.json` enthält die gemessenen Gesamt-/Auswahlmengen.

## Releasebindung

`compileSceneRelease` verlangt die Originalbytes des tatsächlichen
`OperationalInfraRelease`, dessen unabhängig erwarteten Hash, vorhandene
Laufwegkennungen, explizit geprüfte Station-/Plattformbindungen und den
Weltkalender. Seine Ausgabe muss vor Deployment zusätzlich durch
`validate_scene_release_infrastructure` und `hash_scene_release` laufen.
Die lokale CLI nimmt hierzu eine JSON-Zeile entgegen:

- `scene_json hash-release`: vollständiger `ConductorSceneReleaseV1`.
- `scene_json validate-infrastructure`: JSON-Tupel `[sceneRelease, infrastructure]`.
- `scene_json project`: vollständiger `ProjectConductorSceneInputV1` aus
  autorisierten, committed Betriebsdaten.

Der Quellenbeleg trägt derzeit `operationalReleaseAttached: false`: Die
tatsächlichen großen Deutschland-Operational-Artefakte lagen lokal nicht vor.
Der Compiler ersetzt sie nicht durch die fiktive Kern-Teststrecke.
Vollständige Deutschlandabdeckung und produktive Aktivierung bleiben an
[M14.2](https://github.com/larynxberlin-rgb/Zugfolge/issues/193) gebunden.

## Attribution und Lizenz der Daten

Die abgeleiteten Daten bleiben von der Projektquelltextlizenz getrennt:

- DB InfraGO, Infrastrukturdaten Mai 2026, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/);
  Auswahl/Normalisierung durch Zugfolge. [Offizielle Quellen- und Lizenzseite](https://www.govdata.de/suche/daten/infrastrukturdaten-der-db-infrago?ids=b88d0ec0-dbab-4990-8539-6461f32df53b).
- OpenStation / DB InfraGO, [CC0](https://github.com/dbinfrago/openstation-docs);
  Auswahl, RL100-Verknüpfung und Plattform-Deduplizierung durch Zugfolge.
- © [BKG](https://www.bkg.bund.de) 2026,
  [dl-de/by-2-0](https://www.govdata.de/dl-de/by-2-0),
  [Datenquellen](https://sgx.geodatenzentrum.de/web_public/gdz/datenquellen/datenquellen_vg_nuts.pdf);
  Auswahl, Normalisierung und einwohnerbasierte visuelle Modellableitung
  durch Zugfolge. Keine Änderung der ursprünglichen Einwohnerfakten.

Die genaue, bereits im Projekt entschiedene Rechtekette ist in der
Quellenauswahl als Registerauszug gehasht. Dies ist weder eine neue
Produktionsfreigabe noch eine persönliche Sichtabnahme aller Grafikmotive.

## Native Transportdaten reproduzieren

Die zusätzliche Transportdatei unter
`packages/runtime-native/src/fixtures/conductor-scenes-v1.json` stammt aus
dem tatsächlichen Rust-Betriebskern auf ausdrücklich fiktiver Infrastruktur.
Die Originalquellenauswahl dieses Verzeichnisses bleibt davon getrennt.

```sh
cargo build -p zugfolge-conductor-scenes --examples
node tools/conductor-scenes/capture-native-fixture.mjs
```

Ein abweichendes `CARGO_TARGET_DIR` wird berücksichtigt. Einzelne Programme
lassen sich über `ZUGFOLGE_SCENE_FIXTURE_BINARY` und
`ZUGFOLGE_CONDUCTOR_SCENE_TEST_BINARY` explizit festlegen. Die Erzeugung
umfasst Stillstand, Bewegung und Restore; Positionen und Haltbelege werden
dabei nicht in JavaScript konstruiert.
