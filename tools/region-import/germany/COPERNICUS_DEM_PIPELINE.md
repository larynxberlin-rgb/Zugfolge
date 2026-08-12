# Copernicus-GLO-30-Neigungsanreicherung

Diese Importstufe leitet die Qualitaetsdimension `gradient` fuer den
Deutschland-Korpus aus dem freigegebenen Copernicus DEM GLO-30 ab. Sie ist
bewusst keine Vermessung: GLO-30 ist ein digitales Oberflaechenmodell und kann
Vegetation, Bauwerke und andere Oberflaechen enthalten. Das Ergebnis ist daher
`derived`, besitzt immer ein Unsicherheitsintervall und ist allein nie
Klasse-A-faehig.

## Rechte und feste Quelle

- Rechtekennung: `dem-hoehenmodell`, Status `freigegeben`
- Produkt: `COP-DEM-GLO-30-DGED`
- AWS-Bestand: Copernicus DEM 2021 release, COG-Kacheln im oeffentlichen Bucket
  `copernicus-dem-30m`
- Verbindliche Auslieferungsattribution:

  `produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus
  Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European
  Union and ESA; all rights reserved`

`capture` liest zuerst nur die Koordinaten der fertigen semantischen
`tracks.geojsonseq`. Damit werden genau die benoetigten 1-Grad-Geozellen
ermittelt. Jede Kachel wird atomar gespeichert; Groesse, SHA-256, ETag,
Last-Modified, Objektpfad und der Gesamt-Hash des sortierten Kachelsatzes werden
im Capture-Manifest gepinnt. Existiert das Manifest bereits, arbeitet der
Befehl vollstaendig offline und akzeptiert weder eine andere Gleisdatei noch
eine veraenderte Kachel.

## Ableitung

Der Geo-Worker prueft fuer jede Kachel vor dem Sampling SHA-256, COG-Layout,
Float32, EPSG:4326, Rasterausdehnung und Aufloesung. Er erzeugt Stichproben im
Abstand von 30 m sowie an allen semantischen Segmentgrenzen. Die Abfragen werden
nach Rasterkachel gebuendelt, sodass jede COG-Datei nur einmal voll gelesen
wird.

Je OSM-Weg wird fuer ein 400-m-Fenster eine ganzzahlig gerundete lineare
Korridorneigung berechnet. Mindestens 200 m Stuetzwirkung und fuenf gueltige
Stichproben sind Pflicht. Das ausgegebene Minimum/Maximum umfasst mindestens
die konservative Annahme von 4 m vertikaler Quellunsicherheit je Endseite und
den groessten Rasterresiduenfehler. Diese 4 m sind kein Versprechen fuer einen
einzelnen Pixel, sondern eine bewusst vorsichtige Modellannahme fuer die
Qualitaetsgrenze.

Ein betrieblicher Ableitungswert darf hoechstens 70 Promille betragen und die
Halbbreite seines Unsicherheitsintervalls hoechstens 50 Promille. Hoehere Werte werden
nicht abgeschnitten: Sie werden als `surface_model_gradient_outlier`
beziehungsweise `surface_model_uncertainty_too_wide` sichtbar protokolliert und
bleiben ungelöst. So kann eine Baumkrone oder Brueckenkante keine erfundene
Steilstrecke erzeugen.

Folgende Faelle bleiben ausdruecklich `unresolved`: weniger als 200 m
Weglaenge, lueckenhafte oder getrennte OSM-Weggeometrie, NoData im
Analysefenster oder eine nicht identifizierbare Regression. Der
Deutschland-Compiler darf dann nur den dokumentierten konservativen
Neigungskorridor verwenden; der DEM-Import erfindet keinen Ersatzwert.

## Aufruf

```text
node tools/region-import/germany/run-copernicus-dem.mjs all \
  data/infra/deutschland/2026/semantic/tracks.geojsonseq \
  data/dem/copernicus-glo30-2021 \
  data/dem/copernicus-glo30-2021-capture.json \
  data/infra/deutschland/2026/copernicus-dem \
  /absoluter/pfad/zum/gdal-python 2
```

Die Release-Ausgabe besteht aus:

- `copernicus-dem-track-enrichment.geojsonseq`: per `feature_id` bindbare
  Hoehen-/Neigungsfakten mit Unsicherheit,
- `copernicus-dem-quality-report.json`: Counts und Laengen fuer abgeleitete
  beziehungsweise ungeloeste Gleise,
- `copernicus-dem-evidence-report.json`: gepinnte Quelle, Algorithmus,
  Sampling-Coverage und Ausgabepruefsummen.

Anschliessend verbindet `run-merge-track-enrichment.mjs` die Anreicherung mit
dem vollstaendigen amtlich angereicherten Tracklayer. Der Streaming-Join
akzeptiert nur dieselbe Featurezahl, Reihenfolge, `properties.feature_id` und
bytegleich serialisierte Geometrie. Er erhaelt alle vorhandenen Properties,
ergaenzt nur eindeutig benannte Gradient-Felder und schreibt atomar den finalen
`official-enriched-dem/tracks.geojsonseq` samt Byte-/Count-/SHA-256-Report. Ein
ungeloester Gradient bleibt explizit und der Join setzt niemals Klasse A.

Tests:

```text
node --test tools/region-import/germany/copernicus-dem.test.mjs
GDAL_PYTHON tools/region-import/germany/copernicus_dem_sample_test.py
```
