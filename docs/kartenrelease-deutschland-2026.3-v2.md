# Deutschland-Kartenrelease 2026.3 v2 (historisch, abgelöst)

Diese Anleitung erhält ausschließlich die reproduzierbare Buildreihenfolge des
historischen Kandidaten `infra-deutschland-2026.3`. Der Kandidat ist
unveränderlich verworfen, wurde nie als vertrauenswürdig registriert, in Odoo
importiert oder produktiv aktiviert und darf nicht mehr signiert, registriert
oder installiert werden.

Der aktuelle V2-Lauf ist
[`Deutschland-Kartenrelease 2026.4 v2`](kartenrelease-deutschland-2026.4-v2.md).
Nur dessen create-new Artefakte und Freigabegates sind für eine Installation
maßgeblich. Die folgenden Befehle dienen der historischen Reproduktion und dem
Robustheitsvergleich, nicht als Aktivierungsanleitung.

## Voraussetzungen

Alle Befehle laufen von der Repositorywurzel in einer isolierten
Archiv-Arbeitskopie mit den exakt gepinnten Eingaben. Die Generatoren schreiben
create-new. Bereits vorhandene Archivbelege dürfen deshalb nicht gelöscht oder
überschrieben werden, um den Lauf zu erzwingen; für eine Reproduktion sind neue
Ausgabeziele in einer separaten Arbeitskopie bereitzustellen.

Der Dateiname `static-map-sources-v2.json` ist ein historischer Paketpfad. Sein
Inhalt hat trotzdem das aktuelle Schema `zugfolge-static-map-sources/v3`.

## Bindende Buildreihenfolge

Die Reihenfolge lautet ausdrücklich:

1. `InfraRelease-v2` materialisieren;
2. daraus und aus den fertigen Kartenbytes das
   `zugfolge-map-source-capture/v2` erzeugen;
3. aus genau diesem v2-Capture das öffentliche
   `zugfolge-static-map-sources/v3` erzeugen;
4. erst danach den `MapRelease-v1` materialisieren.

Die statische Quality-Materialisierung ist eine Voraussetzung des
InfraRelease-Schritts:

```powershell
node tools/tiles/static-map-quality-cli.mjs materialize tools/tiles/static-map-quality.annual-2026.3.json var/derived/germany-2026.3/map-release-free-v2/public/quality.json var/derived/germany-2026.3/map-release-free-v2/public/static-map-quality-v2.json
```

### 1. InfraRelease-v2

```powershell
node tools/region-import/germany/build-germany-release.mjs manifest tools/region-import/germany/release.annual-2026.3.config.json tools/region-import/germany/source-catalog.json tools/guards/quellenregister.json var/derived/germany-2026.3/source-capture.2026.3.json var/derived/germany-2026.3/release-artifacts.v2.json var/derived/germany-2026.3/map-release-free-v2/public/static-map-quality-v2.json var/derived/germany-2026.3/operational-infrastructure-quality.json var/derived/germany-2026.3/map-release-free-v2/public/infra-release.json
```

### 2. Map-Source-Capture v2

Der Capture-Aufruf übergibt neben Style, Metadaten, Basemap, Infrastruktur und
dem soeben erzeugten InfraRelease auch den Asset-Notice-Vertrag, die
Repositorywurzel, den Cache-Inventarplan und die Artefaktwurzel. Eine alte
`basemap-source-capture-2026-08-12.json` mit v1-Schema ist hier unzulässig.

```powershell
node tools/tiles/build-map-source-capture.mjs var/source-cache/annual-2026-pinned/protomaps-dark-upstream-2026-08-12-08a5067f9cc54b1068e0e3cb830d9c51a6c8375be03ebea6acc7108d8d61d2df.json var/source-cache/annual-2026-pinned/welt-mit-deutschland-detail-2026-08-12-8a5a34b8586ef55313370a8dfc7143f80e9c5e85fb1af5c5dfc2eb68e22c658b.metadata.json var/source-cache/annual-2026-pinned/welt-mit-deutschland-detail-2026-08-12-c766073e55b99b213276328e504cbb7a69b0b65db0546adf484539c3bd319aed.pmtiles var/derived/germany-2026.3/map-release-free-v2/infra-deutschland-2026.3.pmtiles var/derived/germany-2026.3/map-release-free-v2/public/infra-release.json tools/tiles/map-asset-notices.annual-2026.3.json . tools/tiles/map-build-cache-inventory.annual-2026.3.plan.json . var/derived/germany-2026.3/map-release-free-v2/public/map-source-capture.json
```

### 3. Static Sources v3

Dies ist der vollständige Sources-v3-Aufruf. Insbesondere sind das echte
v2-Map-Capture, `ASSET-NOTICES` und `REPOSITORYWURZEL` Pflichtargumente.

```powershell
node tools/tiles/static-map-sources-cli.mjs materialize tools/tiles/static-map-sources.annual-2026.3.json tools/region-import/germany/source-catalog.json var/derived/germany-2026.3/source-capture.2026.3.json tools/tiles/map-source-catalog.json var/derived/germany-2026.3/map-release-free-v2/public/map-source-capture.json tools/guards/quellenregister.json tools/tiles/map-asset-notices.annual-2026.3.json . var/derived/germany-2026.3/map-release-free-v2/public/static-map-sources-v2.json
```

### 4. MapRelease-v1

```powershell
node tools/tiles/build-map-release.mjs tools/tiles/map-release.annual-2026.3.spec.json . tools/tiles/map-source-catalog.json var/derived/germany-2026.3/map-release-free-v2/public/map-source-capture.json tools/guards/quellenregister.json var/derived/germany-2026.3/map-release-free-v2/public/map-release.json
```

Damit endet die historische Reproduktion. Signatur, Trust-Registrierung,
Paketinstallation, Odoo-Import und Produktionsaktivierung sind für `.3`
ausdrücklich ausgeschlossen; dafür gilt ausschließlich der aktuelle `.4`-V2-
Lauf.
