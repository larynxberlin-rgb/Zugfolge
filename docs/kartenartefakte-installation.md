# Kartenartefakte als versioniertes Datenpaket

Die weltweite Basiskarte und der vollständige Deutschland-Korpus sind große,
jährlich neu erzeugte **Laufzeitdaten**. Sie werden nicht als Git-Blob geführt.
Stattdessen erzeugt Zugfolge ein eigenständiges, transportneutrales
Kartenpaket. Dieses kann lokal kopiert, über den Chat übergeben, auf einen
Datenträger gelegt oder später über einen beliebigen Artefaktspeicher verteilt
werden. Der Prüfvertrag bleibt dabei identisch.

## Paketaufbau

```text
zugfolge-map-deutschland-2026.1/
  manifest.json
  manifest.sha256
  parts/
    welt-hybrid-basemap.pmtiles.part-00001
    deutschland-infrastruktur.pmtiles.part-00001
    style-dark.part-00001
    glyph-inter-0-255.part-00001
    sprite-png.part-00001
    release-manifest.part-00001
    ...
```

`manifest.json` ist kanonisch und enthält für jedes fertige PMTiles-Artefakt:

- Paket-ID und Version,
- sicheren relativen Installationspfad,
- gesamte Bytezahl und SHA-256,
- stabile Reihenfolge aller Teile sowie deren Bytezahl und SHA-256.

`sha256` bezeichnet dabei immer den Hash der tatsächlich ausgelieferten
Dateibytes einschließlich JSON-Formatierung und Abschlusszeilen. Ein eventuell
zusätzlich erzeugter kanonischer Objekt-Hash ist ein anderer Nachweis und darf
nicht als Paket-Dateihash eingesetzt werden.

Ein vollständiges Paket enthält genau zwei PMTiles-Dateien:

- eine Hybrid-Basemap mit Weltabdeckung in den niedrigen Zoomstufen und
  Deutschland-Detail in disjunkten höheren Zoomstufen,
- die separate semantische Deutschland-Infrastruktur mit anklickbaren
  Fachobjekten.

Der PMTiles-Inhalt wird nicht nur als Datei gehasht. Der Paketvertrag verlangt
für die Hybrid-Basemap exakt die neun Layer `boundaries`, `buildings`, `earth`,
`landcover`, `landuse`, `places`, `pois`, `roads` und `water`. Das getrennte
Infrastrukturartefakt muss exakt `blocks`, `conflict_resources`,
`operating_points`, `platforms`, `rail_context`, `rail_corridors`, `signals`,
`stations`, `switches` und `tracks` enthalten. Header, Zoombereich und diese
Layerliste werden aus der PMTiles-v3-Datei gelesen und in das kanonische
Manifest übernommen.

Der MapLibre-Runtime-Style bleibt absichtlich ein reiner Basemap-Style. Er darf
genau eine selbst gehostete Vektorquelle mit der ID `basemap` besitzen und
keinen der zehn semantischen Infrastruktur-Layer duplizieren. Der Client lädt
das Infrastruktur-PMTiles separat aus `LivemapConfigV2` und registriert darauf
Interaktions- und Zustandslayer. Der Paketvertrag bindet deshalb
`basemapStyleUrl` und `infrastructurePmtilesUrl` an dieselbe versionierte
`publicBasePath`. Er prüft zugleich, dass Style, Basemap, Infrastruktur,
Glyphen und Sprites tatsächlich unter dieser gemeinsamen Installationswurzel
liegen und keine externe Runtimequelle enthalten. Die Basemap-Attribution ist
exakt `© OpenStreetMap-Mitwirkende, ODbL 1.0; Basemap-Aufbereitung Protomaps;
weitere Bearbeitung durch Zugfolge`. Dadurch kann eine spätere Regeneration
nicht versehentlich eine der erforderlichen Nennungen entfernen.

Daneben stehen exakt inventarisierte `auxiliaryFiles`: ein MapLibre-Style,
lokale Glyphen, Sprite-PNG und Sprite-JSON, je ein öffentliches Release-,
Quellen- und Qualitätsmanifest, das ausschließlich öffentliche ReadModel sowie
die davon getrennte Zugpositionsprojektion. Für den Jahreslauf 2026 sind beide
SQLite-Artefakte verpflichtend: `read-model.sqlite` enthält die anklickbaren
Objekte, Bahnhofstafel- und FIS-Daten; `train-map-projection.sqlite` verbindet
releasegebunden die serverautoritäre Zugposition mit der Kartengeometrie. Jede
Hilfsdatei besitzt wie ein PMTiles-Artefakt einen sicheren
Installationspfad, eine Bytezahl, einen SHA-256 und eine geordnete Liste ihrer
Teile. Deshalb werden auch große Hilfsdateien gestreamt und an derselben
konfigurierbaren Bytegrenze geteilt.

Jeder Teil ist kleiner als 2 GiB. Das mitgelieferte Chat-Transportprofil nutzt
standardmäßig 100 MiB (`104857600` Byte). Dieser Wert ist eine konservative,
konfigurierbare Projektvorgabe und ausdrücklich **keine Behauptung über eine
bestimmte Plattformgrenze**. Ist der tatsächlich verwendete Transportweg
strenger, wird `partBytes` in der Paketspezifikation entsprechend verkleinert.
Das Paket enthält nur fertige PMTiles-Ausgaben und die ausdrücklich
inventarisierten öffentlichen Laufzeitdateien. Quellpfade,
Transport-URLs, Zugangsdaten, Token und APN-Rohdaten sind im Manifest verboten.
Auch zusätzliche, nicht im Manifest aufgeführte Dateien oder symbolische Links
lassen die Prüfung scheitern. Dadurch können keine ungeprüften Beigaben neben
den Kartenteilen mitreisen.
Die interne Herkunfts- und Rechteprüfung verbleibt in der Release-Pipeline und
wird nicht durch das Transportpaket ersetzt.

Die öffentlichen Dateien werden unter `manifests/release.json`,
`manifests/sources.json` und `manifests/quality.json` sowie als
`read-model.sqlite` und `train-map-projection.sqlite` in derselben Releasewurzel
installiert. Diese Dateien dürfen weder APN- noch andere
interne Evidenznamen (einschließlich des internen Kalibrierwerkzeugs) oder
Hashes interner Evidenz enthalten. Ein rein
öffentlicher Qualitäts- oder Artefakthash bleibt zulässig.

JSON-Hilfsdateien werden beim Packen und Prüfen als UTF-8 gelesen. Für normale
Dateigrößen erfolgt zusätzlich eine vollständige JSON- und Feldprüfung; sehr
große öffentliche JSON-Dateien werden speicherschonend gestreamt und dürfen
keine Unicode-Verschleierung verwenden. APN-Referenzen, bekannte Tokenmuster,
Zugangsdaten und private ReadModel-Felder blockieren das Paket. Glyphen und
Sprites müssen lokale PBF-, PNG- beziehungsweise JSON-Dateien sein; die
PNG-Signatur wird geprüft.

Die beiden SQLite-Artefakte werden nie als Bytefolge in den Arbeitsspeicher
geladen. Hashbildung, Multipart-Transport und Installation erfolgen gestreamt.
Vor dem Packen sowie nach Zusammensetzen prüft der Vertrag für jede Datei mit
ihrem eigenen Schemavertrag SQLite-Header, `application_id`, `user_version`,
die exakte Allowlist öffentlicher Tabellen
und Spalten, fehlende Views/Trigger, Fremdschlüssel, Stationsbezüge und
`quick_check`. Eine bloß gleich benannte SQLite-Datei genügt damit nicht.

## Paket bauen

Als Vorlage dient
`tools/tiles/map-package.spec.example.json`. `sourceFile` wird relativ zum
Verzeichnis der Spezifikation aufgelöst. Der Ausgabepfad darf noch nicht
existieren:

```powershell
node tools/tiles/map-package-cli.mjs pack `
  var/map-package/map-package.spec.json `
  var/map-package/zugfolge-map-deutschland-2026.1
```

Für den realen Jahreslauf ist
`tools/tiles/map-package.annual-2026.plan.json` maßgeblich. Der Plan nennt die
beiden PMTiles-Dateien, die beiden getrennten SQLite-Artefakte und die vier
weiteren öffentlichen Laufzeitdateien einzeln. Die
1.024 lokalen Glyphen und alle Sprite-Auflösungen werden aus zwei ausdrücklich
benannten Verzeichnissen deterministisch in einzelne `auxiliaryFiles`
expandiert. `expectedInventory` schreibt zusätzlich die vier Fontstacks mit je
256 Ranges sowie die vier Sprite-Dateien exakt vor. Unterverzeichnisse,
Erweiterungen und symbolische Links werden fail-closed geprüft. Zur prüfbaren
Vorschau kann daraus eine konkrete
Spezifikation erzeugt werden, ohne die großen Dateien zu kopieren:

```powershell
node tools/tiles/map-package-cli.mjs expand `
  tools/tiles/map-package.annual-2026.plan.json `
  . `
  var/derived/germany-2026/map-release/map-package.spec.json
```

Das reale Paket wird erst nach erfolgreicher PMTiles-Verifikation, öffentlichem
Sanitizer und APN-internem Review gebaut. Danach kann der Plan ohne eine große,
manuell gepflegte Zwischenliste direkt gepackt werden:

```powershell
node tools/tiles/map-package-cli.mjs pack-plan `
  tools/tiles/map-package.annual-2026.plan.json `
  . `
  var/map-package/zugfolge-map-deutschland-2026.1
```

Das Packen prüft PMTiles v3 einschließlich Headerbereichen,
Verzeichnisstruktur, MVT-Kacheltyp und JSON-Metadaten. Unbekannte Kompression,
ungültige Offsets, fehlende Vektorlayer sowie APN- oder Geheimnisreferenzen in
den Metadaten führen zum Abbruch. Maßgeblich ist die
[PMTiles-v3-Spezifikation](https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
Anschließend sortiert es alle Artefakte
stabil, teilt sie an festen Bytegrenzen und schreibt zunächst in
ein temporäres Nachbarverzeichnis. Erst das vollständige Paket wird mit einer
Umbenennung sichtbar. Gleiche Eingaben und dieselbe Spezifikation ergeben
dasselbe Manifest, dieselben Teile und dieselben Hashes. Die ausgegebene
`manifestSha256` ist zusammen mit dem Paket zu übergeben.

Die Prüfsummendatei schützt gegen beschädigte oder vertauschte Übertragungen.
Für den Nachweis der Herkunft muss die von der Paket-CLI ausgegebene
`manifestSha256` über einen unabhängigen vertrauenswürdigen Weg verglichen oder
das Manifest durch den vorgesehenen Release-Prozess signiert werden. Eine im
selben Verzeichnis mitgelieferte Prüfsumme allein ist keine Signatur.

## Prüfen und installieren

Vor Nutzung wird das vollständige Paket geprüft:

```powershell
node tools/tiles/map-package-cli.mjs verify `
  var/map-package/zugfolge-map-deutschland-2026.1
```

Die lokale Installation setzt alle Teile wieder zusammen. Das Ziel ist immer
ein eigenes, versioniertes Releaseverzeichnis und darf nicht mit einem
allgemeinen Kartenverzeichnis gleichgesetzt werden. Es muss vor dem Aufruf
vollstaendig fehlen:

```powershell
node tools/tiles/map-package-cli.mjs install `
  var/map-package/zugfolge-map-deutschland-2026.1 `
  var/maps/releases/infra-deutschland-2026.1
```

Vor dem ersten sichtbaren Ziel werden Manifest, PMTiles-Struktur und der exakt
vorgeschriebene Hilfsdateisatz geprüft.
Beim einmaligen Lesen der Paketteile werden Teil- und Gesamtprüfsummen gebildet,
während zugleich die installierten PMTiles-Dateien entstehen. Es gibt keinen
anschließenden dritten Vollscan. Dasselbe gilt für große Hilfsdateien. Die
Installation entsteht vollständig in einem temporären
Nachbarverzeichnis und wird anschließend atomar umbenannt. Ein bereits
vorhandenes Ziel bricht die Erstinstallation auch bei identischen Bytes mit
`EEXIST` ab; vorhandene, beschädigte oder fremde Dateien werden weder
überschrieben noch als erfolgreicher Installationslauf akzeptiert. Eine bereits
installierte Version wird ausschließlich mit der read-only-Operation geprüft:

```powershell
node tools/tiles/map-package-cli.mjs verify-installed `
  var/map-package/zugfolge-map-deutschland-2026.1 `
  var/maps/releases/infra-deutschland-2026.1
```

Der Jahreskandidat 2026.1 bindet 11.545.162.669 Byte Welt-Basemap,
1.536.379.722 Byte Deutschland-Infrastruktur, 1.291.001.856 Byte ReadModel und
29.003.776 Byte Exact-/Estimate-Zugkartenprojektion. Die vollständige Artefakt- und
Qualitätsbilanz steht in
[`deutschland-infracorpus.md`](deutschland-infracorpus.md).

Der reale Transportlauf ist erfolgreich ausgeführt:

| Beleg | Ergebnis |
|---|---|
| Paket | 1.172 Teile mit zusammen 14.419.864.896 Byte; einschließlich `manifest.json` und `manifest.sha256` 14.420.471.846 Byte |
| Manifest | 606.870 Byte; SHA-256 `b12f607c959992d29ea9e7dcc2e963b01717b117d8614b5938fcc437dece8e9c` |
| `pack-plan` | Exit 0 in 52,3 s |
| `verify` | Exit 0; auch nach dem atomaren Austausch am kanonischen Pfad erneut Exit 0 |
| Erstinstallation | 1.037 installierte Dateien mit 14.420.471.766 Byte; Exit 0 in 28,8 s |
| historischer zweiter Installationslauf (damaliger Vertrag) | unverändertes Ziel erkannt, Status `reused`; Exit 0 |

Paket und Testinstallation liegen außerhalb der Git-Historie unter
`var/map-package/zugfolge-map-deutschland-2026.1/` beziehungsweise
`var/maps/releases/infra-deutschland-2026.1/`. Der Lauf beweist Transport,
vollständige Integritätsprüfung, atomare Installation und idempotente
Wiederverwendung nach dem damaligen Vertrag. Aktuelle Jahresläufe verwenden
dafür `verify-installed`; `install` bleibt strikt create-new. Der historische
Lauf ist weder Signatur noch produktiver Odoo-Import.

## Alpha-Laufzeit an das installierte Paket binden

Die Alpha-Laufzeit erhält **nicht** mehrere frei kombinierbare
Kartenverzeichnisse. Alle Dateien eines Jahresstands stammen aus genau dem eben
installierten, unveränderlichen Releaseverzeichnis. Für 2026.4 enthält `.env`
deshalb gemeinsam:

Die statische `.env` enthält nur die gemeinsame Hostwurzel:

```dotenv
MAP_RELEASE_DEPLOYMENT_HOST_ROOT=./var/maps
```

Die übrigen vier Werte stehen ausschließlich im zuletzt geladenen,
Evidence-geprüften `var/maps/active/map-release.env`:

```dotenv
MAP_RELEASE_ID=infra-deutschland-2026.4
MAP_RELEASE_HOST_DIR=releases/infra-deutschland-2026.4
MAP_BASEMAP_STYLE_URL=/artifacts/maps/infra-deutschland-2026.4/style.json
MAP_GERMANY_PMTILES_URL=/artifacts/maps/infra-deutschland-2026.4/infra-deutschland-2026.4.pmtiles
```

`compose.alpha.yml` leitet ohne verschachtelte Variablenexpansion aus der
gemeinsamen Hostwurzel und `MAP_RELEASE_ID` exakt
`./var/maps/releases/infra-deutschland-2026.4` ab. Dieses eine Verzeichnis wird
an zwei klar getrennte Verbraucher gebunden, jeweils nur lesbar:

- Die Livemap sieht es unter
  `/map-artifacts/maps/infra-deutschland-2026.4`. Ihr statischer Server liefert
  damit mindestens `style.json`, `basemap.pmtiles`,
  `infra-deutschland-2026.4.pmtiles`, `read-model.sqlite` und
  `train-map-projection.sqlite` unter der
  gemeinsamen öffentlichen Wurzel
  `/artifacts/maps/infra-deutschland-2026.4/` aus. Alle statischen Dateien
  unterstützen Einzelbereichsanfragen; erfolgreiche PMTiles-Anfragen mit
  `Range` antworten mit HTTP 206.
- Die Game-API sieht dasselbe Hostverzeichnis als `/map-release` und öffnet
  `/map-release/read-model.sqlite` über `LIVEMAP_READ_MODEL_PATH` read-only.
  Die Zugpositionsauflösung öffnet daneben
  `/map-release/train-map-projection.sqlite` über
  `LIVEMAP_TRAIN_PROJECTION_PATH`, ebenfalls read-only und an denselben
  Infrastrukturrelease gebunden.
  Browserdetails, Bahnhofstafel und FIS laufen weiterhin über die
  serverautorisierten API-Routen; die öffentliche SQLite-Datei enthält nur die
  vom Paketvertrag erlaubten Tabellen und Spalten.

Der Livemap-Build kopiert auch den MapLibre-ESM-Worker und dessen Shared-Modul
in die eigenen statischen Assets. Style, Glyphen-, Sprite-, Worker- und
PMTiles-URLs werden auf denselben Ursprung normalisiert; es gibt auch für
fehlende Basemap-Symbole keinen CDN- oder öffentlichen Kartenfallback.

Der `.4`-Block oben dokumentiert den unveränderlichen Vorgängerstand. Der
aktuelle Deutschland-V2-Patch ist ausschließlich
`infra-deutschland-2026.5` mit Paketversion `2026.5`, Delivery-Key-ID
`zugfolge-map-deutschland-2026.5` und `zugfolge-map-runtime/v2`. Er erhält ein
neues `releases/infra-deutschland-2026.5` und vier gemeinsam auf `.5` zeigende
Pointerwerte. `.4`-Verzeichnisse, -Spezifikationen, -Manifeste, -Signaturen und
Public-Key-Bytes bleiben unverändert. Auch bytegleiche wiederverwendete Daten
werden ausschließlich create-new in den neuen `.5`-Zielbaum materialisiert;
ein vorhandenes Ziel blockiert den Lauf.

## Öffentlicher Deliveryvertrag und Odoo-Jahresimport

`public/release.json` ist der vollständige öffentliche Delivery-Release
`zugfolge-map-delivery-release/v1`, kein loses Karten- oder
Infrastrukturteilmanifest. Er verwendet dieselbe `releaseId` wie der gebundene
InfraRelease, nennt Paket-ID und Paketversion und inventarisiert alle
ausgelieferten Dateien außer `release.json` und `sources.json` selbst mit
tatsächlicher Bytezahl und Byte-SHA-256. Diese beiden Ausnahmen vermeiden einen
zirkulären Selbsthash; stattdessen bindet `release.json` den Byte-SHA-256 von
`sources.json` und `quality.json`. `sources.json` vereinigt ausschließlich die
öffentlichen, freigegebenen Infrastruktur- und Basemapquellen und muss die
Attributionen von OpenStreetMap und Protomaps enthalten. Interne Capture-,
Ledger- oder Stationplan-Evidenzkennungen dürfen in keiner der Dateien stehen.

Der Generator ist fail-closed: Vor ihm muss ein reales
`zugfolge-map-source-capture/v1` den finalen Hybrid-Basemap-Build mit der aus
PMTiles-Metadaten oder dem echten Downloadbeleg abgeleiteten Protomaps-Version,
Bytezahl und Prüfsumme sowie den tatsächlich gebundenen InfraRelease belegen.
Eine geschätzte Tagesversion ist unzulässig. Erst daraus wird mit
`materializeMapRelease` der öffentliche `zugfolge-map-release/v1` erzeugt; der
Deliverygenerator akzeptiert keine bloße Katalogbehauptung.

Der reale Jahresvertrag steht in
`tools/tiles/map-release.annual-2026.spec.json`. Seine Artefaktwurzel ist die
Repositorywurzel (`.`); die beiden `file`-Einträge zeigen direkt auf die finale
Hybrid-Basemap unter `var/source-cache/annual-2026/` und die finale semantische
Infrastruktur unter `var/derived/germany-2026/map-release/`. Damit ist keine
zusätzliche 13-GB-Kopie oder ein nur für den Release angelegter Hardlink nötig.
Der öffentliche InfraRelease-v2-Beleg wird dabei bewusst separat als
`public/infra-release.json` vorgehalten; `public/release.json` bleibt für den
späteren kombinierten Delivery-Release reserviert. Zuerst entsteht der echte
Source-Capture:

```powershell
node tools/tiles/build-map-source-capture.mjs var/source-cache/annual-2026/protomaps-dark-upstream.json var/source-cache/annual-2026/welt-mit-deutschland-detail.metadata.json var/source-cache/annual-2026/welt-mit-deutschland-detail.pmtiles var/derived/germany-2026/map-release/infra-deutschland-2026.1.pmtiles var/derived/germany-2026/map-release/public/infra-release.json var/derived/germany-2026/map-release/public/map-source-capture.json
```

Danach materialisiert folgender Aufruf den gebundenen Kartenrelease:

```powershell
node tools/tiles/build-map-release.mjs tools/tiles/map-release.annual-2026.spec.json . tools/tiles/map-source-catalog.json var/derived/germany-2026/map-release/public/map-source-capture.json tools/guards/quellenregister.json var/derived/germany-2026/map-release/public/map-release.json
```

Der kombinierte Delivery-Release bindet anschließend beide getrennten
SQLite-Prüfberichte, ohne die großen Dateien ein weiteres Mal in den
Arbeitsspeicher zu laden:

```powershell
node tools/tiles/build-map-delivery-release.mjs tools/tiles/map-package.annual-2026.plan.json . var/derived/germany-2026/map-release/public/infra-release.json var/derived/germany-2026/map-release/public/map-release.json var/derived/germany-2026/map-release/public/read-model.sqlite.report.json var/derived/germany-2026/map-release/public/train-map-projection-report.json var/derived/germany-2026/map-release/public
```

Solange kein produktiver privater Signaturschlüssel vorhanden ist, enthält der
Delivery-Release `signature: null` und das Signaturgate den Zustand `missing`.
Das ist kein Fehler in der Paketbildung, aber ein hartes Aktivierungshindernis.
Beim Odoo- und Game-Qualifizierungsvertrag wird dieser Zustand ausdrücklich als
`activationEligible=false` materialisiert. Weder Odoo-Upload noch Game-Staging
aktivieren einen Release.

Der öffentliche Deliveryvertrag 2026.1 inventarisiert 1.034 Artefakte und acht
freigegebene Quellen. `release.json` hat 268.160 Byte und den SHA-256
`1d65f1fc18d8a954165a71b6ac253946bb1529927c7ea971588f6d3d05382f05`;
Qualitäts- und Rechtegate stehen auf `passed`, das Signaturgate auf `missing`.

Odoo führt jeden Jahresimport als eigenen Datensatz
`zugfolge.infra.release.import`. Nur `InfraReviewer` dürfen Manifest und alle
Teile als Anhänge hochladen. Die Hintergrundprüfung liest Dateien aus dem
Filestore gestreamt, verlangt ein exaktes Inventar und speichert unveränderliche
Auditfelder. Der Zustand läuft `draft → verifying → verified → staged`; jeder
Prüf- oder Übertragungsfehler führt mit Code und Detail nach `failed`. Beim
Staging sendet Odoo das Manifest und jeden 100-MiB-Teil einzeln. HMAC bindet
Methode, Pfad, tatsächliche Bytezahl und SHA-256, und das Game vergleicht diese
Werte vor dem Lesen nochmals mit seinem eigenen Manifestinventar. Das Game
prüft anschließend den vollständigen Paketvertrag einschließlich PMTiles,
Style, lokaler Assets, ReadModel, Zugpositionsprojektion, Rechte- und
Qualitätsdateien erneut und macht
erst das vollständig geprüfte Verzeichnis atomar sichtbar.

Zwei Betriebsgrenzen bleiben bis zur produktiven Signaturstufe ausdrücklich
offen: Vorübergehende Netz- oder Timeoutfehler werden derzeit als `failed`
protokolliert und brauchen einen neuen Import statt eines automatischen
Queue-Retry. Außerdem ist die Game-HTTP-Antwort noch nicht eigenständig
authentifiziert. Odoo akzeptiert deshalb fail-closed ausschließlich
`signatureStatus=missing` zusammen mit `activationEligible=false`; eine
behauptete Kombination `verified/true` wird verworfen und kann das
Vier-Augen-Gate nicht erreichen. Eine aktivierbare Antwort setzt später eine
an Import-ID, Manifest-SHA und Release-ID gebundene Antwortsignatur oder mTLS
voraus.

Ein später signierter und vom Game erneut qualifizierter Import kann lediglich
einen bestehenden hochriskanten `infra_release_adoption`-Antrag erzeugen. Der
Uploader ist nicht automatisch Freigeber; `InfraReviewer` impliziert deshalb
bewusst nicht die Approver-Rolle. Die dort bereits durchgesetzte zweite Person
bleibt zwingend. Odoo bleibt gemäß E23 Kontrollpunkt, das Game die Source of
Truth.

Die Repositorytests decken Paketprüfung, HMAC-Transport, exaktes Inventar,
atomaren Game-Stagingabschluss und das Signaturgate ab. Ein echter Lauf des
Add-ons in Odoo 19 sowie ein produktiver Periodenwechsel sind davon getrennte
Betriebsbelege und für den unsignierten Kandidaten 2026.1 noch nicht erbracht.

Die Livemap-Readiness prüft neben Seite und Laufzeitkonfiguration auch je eine
echte Byte-Range aus Style und Infrastruktur-PMTiles. Ein fehlendes, falsch
montiertes oder nicht rangefähig ausgeliefertes Paket bleibt dadurch sichtbar
unbereit. Die Game-API lädt den Detailkatalog vor dem Start und scheitert bei
fehlendem oder ungültigem SQLite-Artefakt geschlossen.

Ein Jahreswechsel wird zuerst vollständig in ein neues Releaseverzeichnis
installiert und geprüft. Die gemeinsame `MAP_RELEASE_DEPLOYMENT_HOST_ROOT`
bleibt unverändert; erst danach werden `MAP_RELEASE_ID`, `MAP_RELEASE_HOST_DIR`,
`MAP_BASEMAP_STYLE_URL` und `MAP_GERMANY_PMTILES_URL` gemeinsam durch atomaren
Austausch genau dieser Pointerdatei umgestellt und Game-API sowie Livemap neu
erzeugt. Für den
Rollback werden ID, URLs und Zeiger wieder auf das zuvor installierte
Verzeichnis gesetzt; dessen Bytes bleiben unangetastet. Der
Katalogvertrag ist in [`livemap-detailkatalog.md`](livemap-detailkatalog.md)
beschrieben.

## Reproduzierbarer Buildbeleg und Patchrelease-Preflight

Das installierte Laufzeitpaket ist kein Buildcache. Jeder neue Deutschland-
Patchrelease benötigt deshalb zusätzlich ein internes, unveränderliches
`zugfolge-map-release-build-evidence`. Dieser Beleg wird nicht öffentlich
ausgeliefert. Er bindet bytegenau:

- den vollständigen Git-Commit des Semantikexports und den vollständigen
  Git-Commit des Kartenbuilds,
- mindestens ein externes Quellarchiv, das Source-Capture, alle verwendeten
  Spezifikationsdateien und das vollständige Buildcache-Inventar,
- jedes lokale Werkzeug mit Version, Bytezahl und SHA-256 oder jedes
  Containerwerkzeug mit einer Referenz der Form
  `registry/repository@sha256:<64 hex>`,
- Welt-Basemap-PMTiles, Semantik-PMTiles, ReadModel, den autoritativen
  Betriebsgraphen, MapLibre-Style, Deliverymanifest und öffentlichen
  Qualitätsbericht; ab Evidence-v3 zusätzlich zwingend die installierbaren
  `movement-route-templates-v2` und `timetable-transfer-demands-v2`,
- alle zehn Semantik-Zwischenlayer als Regressionsbeleg.

`latest`, `main`, `master`, `HEAD`, `unversioned`, verkürzte Git-Commits,
fehlende Dateien und jede Byte- oder Digestabweichung brechen den Lauf ab. Ein
neuer Stand überschreibt niemals eine bestehende Jahreskonfiguration. Auf
`infra-deutschland-2026.2` folgt beispielsweise ein eigener
`infra-deutschland-2026.4`-Spezifikationssatz, ein eigener Buildcache und ein
eigenes Installationsverzeichnis. Release-ID, Paketversion, Welt-/GTFS-
ServiceDate und alle davon abgeleiteten Spezifikationen müssen innerhalb des
Patchsatzes übereinstimmen. Für den August-2026-Patch ist der Montag
`20260810` maßgeblich; die unveränderlichen `.2`-Dateien bleiben unangetastet.
Der bereits signierte Kandidat `infra-deutschland-2026.3` ist verworfen und
nicht vertrauenswürdig; er darf weder Preflight- noch Aktivierungsquelle sein.
Die folgenden konkreten `.4`-Beispiele sind historische, unveränderliche
Vorjahresbelege. Für den aktuellen `.5`-Lauf dürfen sie ausschließlich als
explizit byte- und hashgebundene Vorjahreseingaben oder als beibehaltener
Vertrauensanker dienen; kein `.4`-Ziel wird erneut erzeugt oder verändert.

Die interne Build-Evidence-Spezifikation liegt selbst versioniert unter
`tools/tiles/` im belegten Kartenbuild-Commit. Die historischen Schemas v1 und
v2 bleiben verifizierbar. Neue vollständige Operational-v2-Lieferungen verwenden
`zugfolge-map-release-build-evidence-spec/v3` und erzeugen
`zugfolge-map-release-build-evidence/v3`; dieses Schema verlangt alle neun
aktivierungsrelevanten Ausgaben einschließlich beider Sidecars und bindet sie
zusätzlich an InfraRelease-Inventar, Delivery-v2-Inventar und signierten
Paketplan. Eingaben besitzen die jeweils schemageforderten Byte-/SHA-256-Belege.
Externe Archive, Capture-Manifeste und Derived-Eingaben nennen zusätzlich ihren
`cacheFile` im verschlüsselten Buildcache.

Für `infra-deutschland-2026.5` ist der Timetable-Upstream ein harter V2-Schnitt:
Compiler v5 erzeugt den Bericht v4, `zugfolge-daily-circulation-plan/v2` und die
installierbare Datei `timetable-routes-v2.transfer-demands-v2.json` mit
`kind=timetable-transfer-demands-v2`. Der gemessene Sidecar umfasst 6.697.294
Byte mit SHA-256
`2c8c688a9ce963afbdca75fee526b581bc21be402aabcbaf1abd09ea65418cdf`.
Seine vollständige Partition enthält 1.677 geplante Übergänge, davon 1.595
Turnarounds und 82 real geroutete Transfers in 39 Losen bei 197 Umläufen. Die
historische `.4`-V1-Datei bleibt unverändert verifizierbar, darf aber weder in
das `.5`-Paket aufgenommen noch vom aktuellen Validator als Fallback akzeptiert
werden; es gibt keinen V1-Fallback. Dieser Upstream-Beleg allein beweist noch
keine Paketsignatur, Installation oder Aktivierung.

Das Inventar wird nicht von Hand geschrieben. Ein releasegebundener Plan mit
dem Schema `zugfolge-map-build-cache-inventory-plan/v1` ordnet jede reguläre
Datei unter einer gemeinsamen `ARTIFACT_ROOT` explizit ihrem unveränderlichen
Cachepfad zu:

```json
{
  "schema": "zugfolge-map-build-cache-inventory-plan/v1",
  "releaseId": "infra-deutschland-2026.4",
  "files": [
    {
      "sourceFile": "var/source-cache/annual-2026/deutschland-2026-08-12.osm.pbf",
      "cacheFile": "sources/deutschland-2026-08-12.osm.pbf"
    }
  ]
}
```

Für den realen `.4`-Build wird der vollständige Plan vor dem Lauf unter
`var/build-cache/infra-deutschland-2026.4.plan.json` angelegt und dort
unverändert aufbewahrt. Von der Repositorywurzel aus lautet der exakte
Builder-Aufruf:

```powershell
node tools/tiles/map-build-cache-inventory-cli.mjs build `
  infra-deutschland-2026.4 `
  . `
  var/build-cache/infra-deutschland-2026.4.plan.json `
  var/build-cache/infra-deutschland-2026.4.inventory.json
```

Die Ausgabe wird create-new und atomar angelegt; ein vorhandenes Inventar wird
niemals ersetzt. Der Builder lehnt absolute oder nicht normalisierte Pfade,
Pfadausbruch, symbolische Links in jeder Quellpfadkomponente, leere oder nicht
reguläre Dateien sowie doppelte Quell- und Cachepfade ab. Dateiinhalt und
SHA-256 werden gestreamt, damit auch die großen `.4`-Quellarchive nicht in den
Arbeitsspeicher geladen werden.

Das kanonische Inventar hat diese Form:

```json
{
  "schema": "zugfolge-map-build-cache-inventory/v1",
  "releaseId": "infra-deutschland-2026.4",
  "files": [
    {
      "path": "sources/deutschland-2026-08-12.osm.pbf",
      "bytes": 123,
      "sha256": "<64 hex>"
    }
  ]
}
```

Die Dateiliste ist nach `path` sortiert und vollständig. Symbolische Links,
zusätzliche Dateien, unsichere relative Pfade oder nicht releasegebundene
Objektschlüssel sind unzulässig. Der Evidence-Vertrag verlangt
`backupRequired: true`, `encrypted: true` und
`restoreVerification: "empty-path-full-inventory"`. Zugangsdaten und
Schlüssel stehen weder im Inventar noch im Evidence-Manifest. `objectKey`
bezeichnet nur das unveränderliche, zugriffsgeschützte Backupobjekt; dessen
Verschlüsselungsschlüssel verbleibt im Secret-Management.

Nachdem alle Ausgaben mit den gepinnten Werkzeugen gebaut wurden, entsteht der
Beleg aus den tatsächlichen Bytes. `BUILD_ROOT` ist dabei die gemeinsame
Wurzel der in der Spezifikation genannten relativen Pfade. Dieser Builder-Lauf
und das anschließende `verify` sind der vollständige Reproduzierbarkeitsnachweis;
sie laufen vor dem Transfer auf den Deploymenthost:

```powershell
node tools/tiles/map-release-build-evidence-cli.mjs build `
  tools/tiles/map-release-build-evidence.annual-2026.4.spec.json `
  . `
  var/build-evidence/infra-deutschland-2026.4.json

node tools/tiles/map-release-build-evidence-cli.mjs verify `
  var/build-evidence/infra-deutschland-2026.4.json `
  .
```

Der Build prüft zugleich die fachliche Regression aus #272. Die Spezifikation
nennt alle zehn finalen GeoJSONSeq-Semantiklayer, mindestens eine bekannte
positive EBO-Signal-ID und die verbotenen öffentlichen Tokens einschließlich
`12472736971`. Der Beleg scheitert, wenn dieses BOStrab-Objekt in irgendeinem
Layer oder im öffentlichen ReadModel vorkommt oder wenn das positive
EBO-Signal fehlt. Der historische v2-Beleg prüft sieben
aktivierungsrelevante Ausgaben; die Basemap ist dabei eine zwingende eigene
Ausgabe. Evidence-v3 prüft dagegen exakt neun Ausgaben einschließlich
`movement-route-templates-v2` und `timetable-transfer-demands-v2` und schließt
deren Operational-State- und Transfer-Set-Bindungen. Das Evidence-Manifest
übernimmt darüber hinaus das
vollständige Artefaktinventar des bytegenau gebundenen Deliverymanifests. Jede
Kernausgabe außer dem zirkulär ausgeschlossenen Deliverymanifest muss darin
mit identischem Installationspfad, Artefakttyp, Bytezahl und SHA-256 vorkommen.
Das Deliverymanifest muss bereits eine bestandene Ed25519-Freigabe mit
kanonischem `releaseHash`, stabiler Schlüssel-ID und 64 Signaturbytes besitzen.
Ein unsigned Vertrag mit `approvalGates.signature.status: "missing"` kann kein
Build-Evidence erzeugen.
Große PMTiles- und SQLite-Dateien werden gestreamt gehasht und nicht in den
Arbeitsspeicher geladen. Der Evidence-Lauf akzeptiert die SQLite-Dateien nicht
aufgrund ihres Headers allein: Das ReadModel muss seine Zugfolge-`application_id`,
`user_version=3`, die vollständige Schedule-Metadatenmenge und die exakte
öffentliche Tabellen-/Spalten-Allowlist bestehen. Die Zugkartenprojektion muss
ihren eigenen Header-, Schema-SQL- und Metadatenvertrag erfüllen und exakt an
den Infrastrukturrelease des Builds gebunden sein.

Das Evidence-Manifest wird über eine vollständig synchronisierte eindeutige
Nachbardatei und einen atomaren create-new-Link publiziert. Ein bereits
vorhandenes Ziel wird auch bei identischen Bytes niemals wiederverwendet oder
überschrieben; konkurrierende Erzeuger können deshalb höchstens genau einen
vollständigen Sieger erzeugen.

### Verschlüsselten Buildcache auf leerem Pfad wiederherstellen

Vor jeder Aktivierung wird das verschlüsselte Backup unabhängig auf einem
frischen Pfad wiederhergestellt. Das Vorbereitungskommando verweigert ein
bereits vorhandenes Ziel und legt einen eindeutigen Leerpfadmarker an:

```powershell
node tools/tiles/map-release-build-evidence-cli.mjs prepare-restore `
  var/restore-check/infra-deutschland-2026.4
```

Danach stellt das freigegebene Backupwerkzeug genau den im Evidence-Manifest
genannten `objectKey` in dieses Verzeichnis wieder her. Der Marker darf dabei
nicht entfernt werden. Die anschließende Prüfung akzeptiert ausschließlich das
vollständige Inventar mit identischen Bytezahlen und SHA-256; zusätzliche
Dateien und symbolische Links führen zum Abbruch:

```powershell
node tools/tiles/map-release-build-evidence-cli.mjs prove-restore `
  var/build-evidence/infra-deutschland-2026.4.json `
  var/restore-check/infra-deutschland-2026.4 `
  var/build-evidence/infra-deutschland-2026.4.restore-proof.json
```

Der kanonisch serialisierte Restore-Beleg bindet Evidence-SHA,
verschlüsselten Objektschlüssel, Verschlüsselungsverfahren, Byte-SHA des
Leerpfadmarkers, einen SHA des realen Restorepfads und das vollständig geprüfte
Cacheinventar zu einem gemeinsamen Artefakt-SHA. Er wird zusammen mit
Evidence-Manifest und Buildprotokoll aufbewahrt. Der Aktivierungs-Preflight
vertraut nicht einem daraus geparsten beliebigen JSON-Objekt: Er liest die
unveränderten Proof-Bytes und prüft den angegebenen tatsächlichen Restorepfad,
den Marker sowie jede Inventardatei erneut. Die vollständige erneute
Builder-Wurzelprüfung bleibt davon getrennt: Der Deployment-Gate benötigt nur
das kanonische Evidence-Artefakt, den Restore-Beleg samt realem Restorepfad,
die installierten Pakete und den separat administrierten öffentlichen
Delivery-Keyring. Damit kann ein frischer Builder
nach Checkout der beiden belegten Commits ausschließlich aus Repository,
Evidence und wiederhergestelltem Cache denselben Kandidaten bauen und gegen die
festgehaltenen Ergebnis-Hashes prüfen.

### Parallele Installation, Aktivierung und Rückweg

Kandidat und Vorgänger bleiben als getrennte, unveränderliche Verzeichnisse
installiert. Für `.4` müssen also vor der Umschaltung sowohl
`releases/infra-deutschland-2026.4` als auch
`releases/infra-deutschland-2026.2` vorhanden sein. Beide Verzeichnisse müssen
ein kanonisches `.zugfolge-map-package.json` besitzen; dessen vollständiges
Dateiinventar wird bytegenau geprüft. Leere Rollbackverzeichnisse,
Zusatzdateien, manipulierte Vorgänger oder ein fehlender Quellenbeleg sperren
die Aktivierung. Das unveränderliche `.2`-Paket bleibt dabei bewusst
byteidentisch zu seiner bereits installierten, intern noch unsignierten
Ausgabe; es wird niemals unter derselben Versionskennung neu gepackt. Stattdessen
bindet eine externe Ed25519-signierte Bestandsattestation im v1-Schema mindestens
an `previousReleaseId`, Bytezahl und SHA-256 der kanonischen
`.zugfolge-map-package.json` sowie Installationspfad, Bytezahl und SHA-256 des
enthaltenen Deliverymanifests. Ihr externer Pfad steht als
`deployment.rollbackAttestationPath` im Evidence-Vertrag und muss außerhalb
beider unveränderlicher Releaseverzeichnisse liegen. Ein lediglich
selbstkonsistenter, nachträglich veränderter oder fremd attestierter Vorgänger
ist kein sicheres Rollbackziel. Insbesondere belegt v1 nur Kartenbytes und wird
deshalb immer als `rollbackEligible: false` mit
`runtime-tuple-unbound-v1` ausgewiesen. Es reicht nicht, eine aktuelle Runtime
mit altem ReadModel oder alter Zugprojektion zu starten. Der `.4`-Kandidat
benötigt weiterhin zwingend sein intern signiertes Deliverymanifest. Die in Evidence genannten
`installFile`-Pfade des Kandidaten müssen den gebauten Ausgaben bytegenau
entsprechen. Zusätzlich prüft der Betriebs-Preflight jede Datei des
Delivery-Manifestinventars am installierten Kandidaten. Das schließt Basemap,
Semantik-PMTiles, Style, SQLite-Modelle, Qualitätsbericht, Glyphen, Sprites und
alle weiteren inventarisierten Dateien ein. Eine fehlende oder manipulierte
Basemap sowie jede Abweichung eines anderen Delivery-Artefakts verhindert
`activationEligible: true`.

Für einen Kandidaten mit `zugfolge-map-package/v2` ist außerdem ausschließlich
`zugfolge-map-runtime/v2` zulässig. Die v2-Bezeichnung des Paketmarkers allein
reicht nicht: Ein Kandidat mit dem Legacy-Runtimepfadvertrag v1 wird bereits
bei der Paketprüfung und damit erneut im Aktivierungs-Preflight abgelehnt. Der
unveränderte Rollbackbestand mit `zugfolge-map-package/v1` behält dagegen
seinen historischen `zugfolge-map-runtime/v1`-Vertrag.
Dieser Karten-Runtimevertrag ist eine andere, ebenfalls verpflichtende Grenze
als das signierte Full-Stack-Rollback-Tuple
`zugfolge-runtime-rollback-tuple/v3`; ein gültiger Beleg ersetzt den jeweils
anderen nicht.

Der in Evidence gebundene `activationPointer` ist eine kanonische LF-env-Datei
mit genau vier Werten. Der Aufrufer nennt bei jedem Preflight explizit das
erwartete aktive Release. Vor der `.4`-Aktivierung muss der Pointer damit
vollständig auf `.2` zeigen; nach der atomaren Umschaltung und bei jedem
wiederholten Start muss derselbe Gate im Zustand `active-candidate`
vollständig die vier `.4`-Werte sehen. Ein stilles Akzeptieren beider Zustände
ist unzulässig. `MAP_RELEASE_HOST_DIR` ist dabei der zum Deploymentroot
relative, Evidence-gebundene Installationspfad:

```dotenv
MAP_RELEASE_ID=infra-deutschland-2026.2
MAP_RELEASE_HOST_DIR=releases/infra-deutschland-2026.2
MAP_BASEMAP_STYLE_URL=/artifacts/maps/infra-deutschland-2026.2/style.json
MAP_GERMANY_PMTILES_URL=/artifacts/maps/infra-deutschland-2026.2/infra-deutschland-2026.2.pmtiles
```

Der öffentliche Keyring ist ein JSON-Objekt von stabiler `keyId` auf einen
Ed25519-SPKI-Public-Key im PEM-Format. Private Schlüssel gehören niemals auf
den Deploymenthost, in das Repository, einen Worktree, Buildcache,
Transportpaket, Evidence oder Laufprotokoll. Die Rollback-Attestation wird
deshalb auf einem getrennten Signierhost gegen ein byteidentisches Abbild des
installierten `.2`-Pakets erzeugt. Der nur dort aufgelöste externe Pfad steht
im Aufruf als `$ROLLBACK_PRIVATE_KEY`; allein die fertige öffentliche
Attestation wird danach an den Evidence-gebundenen externen Pfad übertragen:

```powershell
node tools/tiles/map-release-build-evidence-cli.mjs attest-rollback `
  var/maps `
  releases/infra-deutschland-2026.2 `
  infra-deutschland-2026.2 `
  $ROLLBACK_PRIVATE_KEY `
  map-rollback-2026 `
  var/maps/attestations/infra-deutschland-2026.2.rollback.json
```

Ein tatsächlich ausführbares Rollback braucht dagegen zwingend das
`zugfolge-runtime-rollback-tuple/v3`.
Die Signatur bindet zusätzlich ein einziges kompatibles Runtime-Tuple aus
40-stelligem Source-Commit, getrennten OCI-Digests für Game und Odoo,
signiertem Weltdeployment samt
Byte-SHA, Welt-ID, Epoch und Wiederholungsperiode, ReadModel-v2 samt
`application_id`, `user_version` und normalisiertem Zeitvertrag sowie
Zugprojektion-v2 samt Schema-SQL-Hash und Deployment-Hash. ReadModel,
Zugprojektion und Weltdeployment müssen dieselbe Welt nennen; Projektions- und
Weltdeployment-Hash sowie Epoch und Wiederholungsperiode müssen exakt
übereinstimmen. Zusätzlich bindet das Tuple den kanonischen
`zugfolge-database-rollback-proof/v3`. Dieser bindet die mit dem Backup
restaurierbare, unveränderliche DB-UUID, das bis Schema 32 exakte
Migrationsledger, den vollständigen Cutover-Constraint-/Guardvertrag und einen
kanonischen Gesamtreihenhash jeder Zeile des exakt eingecheckten Satzes aus 51
autoritativen Schema-32-Tabellen. Dadurch ändern auch innere Domain-Events sowie
Konten-, Ledger-, Fahrzeug-, Fleet- und Planungszeilen den Kopf. Dazu kommen der
vollständige `keycloak-identity-head/v1` mit den Reihenfingerprints aller 100
Keycloak-Tabellen, der quieszierte Schreibzustand, das eingebettete semantische
Backup-Manifest, der
eingebettete semantische Restore-Beleg und deren Byte-SHAs. Eine strukturgleiche
andere Datenbank wird auch bei identischen Zählern abgewiesen. Die Erstellung
verweigert daher auch ein unter `.2` abgelegtes
ReadModel oder eine Projektion, die tatsächlich noch an `.4` gebunden ist:

Der attestierte nackte Image-Digest in
`MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST` muss zugleich exakt der Digest der
`MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE` im versionierten
`compose.alpha.rollback.yml` sein. Zulässig sind eine lokale
`sha256:…`-Image-ID oder eine kleingeschriebene
`registry/repository@sha256:…`-Referenz. Der Wrapper rechnet diese Bindung vor
jedem Compose-Aufruf nach und verweigert mutable Tags, Platzhalter, doppelte
Einträge sowie einen geerbten Shell-Override. Der aktuelle v3-Prüfer läuft
dagegen über die getrennte unveränderliche
`ZUGFOLGE_GAME_API_IMAGE_REFERENCE`; sein Digest muss vom Legacy-Digest
verschieden sein. So kann das prüfende aktuelle Image niemals durch bloßes
Retagging mit der attestierten alten Runtime gleichgesetzt werden.
Entsprechend muss `PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST` exakt den ebenfalls
signierten Odoo-Digest des Tuples und den Digest der unveränderlichen
`PRODUCTION_RECOVERY_ODOO_IMAGE_REFERENCE` treffen. Ein nur lokal
selbstdeklarierter Odoo-Tag ist kein freigegebener Rückweg.

Der DB-Beleg entsteht erst nach dem nachweislichen Stop aller Writer, der
vorwärtskompatiblen Migration auf Schema 32 sowie einem echten Test-Restore.
Quell- und Restore-Datenbank müssen gleichzeitig erreichbar sein und sowohl
verschiedene normalisierte Endpunkte als auch verschiedene physische
PostgreSQL-Backends besitzen. Andere Zugangsdaten, ein anderer Datenbankname auf
demselben Backend oder dieselbe URL reichen nicht. Backup-Manifest und
Restore-Beleg müssen kanonische JSON-Artefakte der Schemas
`zugfolge-database-backup-manifest/v1` und
`zugfolge-database-restore-proof/v1` sein. Sie binden DB-UUID, autoritativen
Quell-/Restore-Kopf, Endpunkt-/Backend-SHAs, Backup-ID, vorwärts laufende
WAL-Spanne, Quiescence und die vollständige Reihenfingerprint-Verifikation.
Beliebige nichtleere Dateien werden verweigert. `backup-game.sh` erfasst im
explizit quieszierten Modus zusätzlich die reale WAL-Spanne in einem
create-new-Operationsbeleg; `restore-game.sh` schreibt sein Receipt optional
selbst create-new. Der Qualifizierungsschritt bindet diese beiden Receipts
bytegenau an den Dump, liest den vollständigen Schema-32-Kopf aus Quelle und
isoliertem Restore und publiziert das kanonische v1-Paar gemeinsam. Scheitert
die zweite Pfadbelegung, wird nur die eindeutig selbst angelegte erste Datei
zurückgenommen; eine fremde Datei wird nie überschrieben oder gelöscht:

```bash
DATABASE_ROLLBACK_WRITERS_QUIESCED=true \
sh ops/alpha/backup-game.sh \
  "$QUIESCED_SOURCE_DATABASE_URL" \
  /evidence/game.dump \
  /evidence/game.manifest.json \
  /evidence/game.operation.json

sh ops/alpha/restore-game.sh \
  "$ISOLATED_RESTORE_ADMIN_DATABASE_URL" \
  zugfolge_restore_infra_2026_4 \
  /evidence/game.dump \
  /evidence/game.manifest.json \
  /evidence/game.restore.json

DATABASE_ROLLBACK_WRITERS_QUIESCED=true \
DATABASE_URL="$QUIESCED_SOURCE_DATABASE_URL" \
DATABASE_ROLLBACK_RESTORED_DATABASE_URL="$RESTORE_TEST_DATABASE_URL" \
KEYCLOAK_SCHEMA_CATALOG_PATH=ops/alpha/keycloak/keycloak-pg16-object-catalog.26.7.0.json \
DATABASE_ROLLBACK_GAME_BACKUP_DUMP_PATH=/evidence/game.dump \
DATABASE_ROLLBACK_GAME_BACKUP_MANIFEST_PATH=/evidence/game.manifest.json \
DATABASE_ROLLBACK_GAME_BACKUP_OPERATION_PATH=/evidence/game.operation.json \
DATABASE_ROLLBACK_GAME_RESTORE_RECEIPT_PATH=/evidence/game.restore.json \
DATABASE_ROLLBACK_BACKUP_MANIFEST_PATH=/evidence/database-backup-manifest.json \
DATABASE_ROLLBACK_RESTORE_PROOF_PATH=/evidence/database-restore-proof.json \
node tools/alpha-ops/create-database-backup-restore-evidence.mjs
```

Erst danach entsteht ebenfalls ausschließlich create-new der eingebettete
v3-Beleg:

```bash
DATABASE_ROLLBACK_WRITERS_QUIESCED=true \
DATABASE_URL="$QUIESCED_SOURCE_DATABASE_URL" \
DATABASE_ROLLBACK_RESTORED_DATABASE_URL="$RESTORE_TEST_DATABASE_URL" \
KEYCLOAK_SCHEMA_CATALOG_PATH=ops/alpha/keycloak/keycloak-pg16-object-catalog.26.7.0.json \
DATABASE_ROLLBACK_RELEASE_ID=infra-deutschland-2026.4 \
DATABASE_ROLLBACK_PREVIOUS_RELEASE_ID=infra-deutschland-2026.2 \
DATABASE_ROLLBACK_BACKUP_MANIFEST_PATH=/evidence/database-backup-manifest.json \
DATABASE_ROLLBACK_RESTORE_PROOF_PATH=/evidence/database-restore-proof.json \
DATABASE_ROLLBACK_PROOF_OUTPUT_PATH=/evidence/database-rollback-proof.json \
node tools/alpha-ops/create-database-rollback-proof.mjs
```

Der spätere gesperrte `game-bootstrap` liest dieselben Bytes erneut und vergleicht
`source` nach exklusiver Sperre der lexikographisch geordneten Candidate- und
Predecessor-Welt mit der tatsächlichen Live-Datenbank, bevor er eine Weltzeile
ändert. Alle 50 weltgebundenen Tabellen besitzen dafür dauerhafte
INSERT-/UPDATE-/DELETE-Trigger auf demselben Shared-Xact-World-Lock. Der
`READ COMMITTED`-Snapshot nach dem Lock-Warten enthält einen bereits laufenden
Writer-Commit; ein später fortgesetzter Writer liest den Lifecycle erneut mit
`FOR KEY SHARE` und scheitert an `archived` beziehungsweise am persistenten
Fence. Beim V1-V2-Wechsel versiegelt der Bootstrap
zudem in `alpha_world_profiles.final_state_hash` alle im eingecheckten
Schema-33-Vertrag weltgebundenen Zeilen (einschließlich
`regional_simulation_command_receipts`, dessen unveränderlicher
`initialization_hash` jedes Kommando an die konkrete V2-Initialisierung bindet,
und indirekter
`public_world_id`-/`target_world_id`-Bezüge) und persistiert einen
unveränderlichen, DB-gebundenen `world_cutover_receipts`-Beleg.
Im selben Commit setzt er auf jedem V1-Regionalhead
`legacy_writer_fenced=true`. Der DB-Trigger verweigert danach auch einer schon
vor dem Cutover geöffneten oder später neu verbundenen alten V1-Runtime jeden
weiteren Update- oder Löschversuch; das Compose-`down` ist damit nicht die einzige
Grenze. Bei einem idempotenten Retry wird der Receipt-Hash aus sämtlichen
persistierten Receipt-Spalten neu aufgebaut; ein vorbefüllter oder nachträglich
inkonsistenter Hash wird nicht akzeptiert.

```powershell
node tools/tiles/map-release-build-evidence-cli.mjs attest-runtime-rollback `
  var/maps `
  releases/infra-deutschland-2026.2 `
  infra-deutschland-2026.2 `
  0123456789abcdef0123456789abcdef01234567 `
  sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef `
  sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789 `
  var/legacy-runtime/alpha-world-deployment.json `
  var/legacy-runtime/database-rollback-proof.json `
  $ROLLBACK_PRIVATE_KEY `
  map-rollback-2026 `
  var/maps/attestations/infra-deutschland-2026.2.rollback.json
```

Der Preflight liest den Pointer selbst, verifiziert das intern signierte
`.4`-Deliverymanifest und die externe `.2`-Rollback-Attestation gegen den
unabhängigen, rotierbaren Keyring und dessen verpflichtenden, disjunkten
Alpha-Welt- beziehungsweise Map-/Infra-Scopevertrag. Delivery und
Rollback-Attestation dürfen nur Map-/Infra-Schlüssel verwenden; das gebundene
Weltdeployment nur Alpha-Schlüssel. Anschließend prüft der Preflight beide
installierten Pakete und den Cache-Restore. Das siebte Argument legt den erwarteten
Pointerzustand explizit fest; die fünf folgenden Werte belegen beim
Rollback-Check die tatsächlich zu startende Runtime-Identität:

`var/trust/release-key-scopes.json` enthält ausschließlich die Rollenlisten und
muss jede ID des daneben übergebenen Public-Keyrings genau einmal enthalten:

```json
{
  "alphaWorldDeployments": [
    "zugfolge-alpha-2026",
    "zugfolge-alpha-2026.3"
  ],
  "mapInfraDeliveries": [
    "zugfolge-map-deutschland-2026.4",
    "zugfolge-map-deutschland-2026.5"
  ]
}
```

Fehlt die Datei, eine Rolle oder eine Key-ID, überlappen die Listen oder weicht
ein zugeordneter Public Key vom Evidence-gebundenen Keyring ab, endet der
Operational-v2-Preflight vor der Autorisierung fail-closed.

```powershell
node tools/tiles/map-release-build-evidence-cli.mjs preflight `
  var/build-evidence/infra-deutschland-2026.4.json `
  var/maps `
  var/build-evidence/infra-deutschland-2026.4.restore-proof.json `
  var/restore-check/infra-deutschland-2026.4 `
  var/trust/release-public-keys.json `
  var/trust/release-key-scopes.json `
  infra-deutschland-2026.2 `
  0123456789abcdef0123456789abcdef01234567 `
  sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef `
  sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789 `
  var/legacy-runtime/alpha-world-deployment.json `
  var/legacy-runtime/database-rollback-proof.json
```

Nur `activationEligible: true` erlaubt die Umschaltung. Anschließend werden
die vier Kartenwerte in einer vollständig geschriebenen Nachbardatei geändert
und diese Konfiguration atomar an die Stelle des in Evidence gebundenen
`activationPointer` gesetzt. Niemals wird ein Releaseverzeichnis umbenannt,
überschrieben oder teilweise aktualisiert. Nach Neustart müssen Readiness,
Range-Requests, Release-ID, die Abwesenheit von `12472736971` und mindestens
ein positives EBO-Signal erneut live geprüft werden.

Unmittelbar nach der Umschaltung wird derselbe Preflight mit
`infra-deutschland-2026.4` als siebtem Argument wiederholt. Er meldet nur dann
`activationState: "active-candidate"`, wenn alle vier Pointerwerte bereits
exakt auf `.4` stehen. Ein intaktes v1-`.2`-Paket wird weiterhin geprüft, aber
ehrlich nur als nicht ausführbarer forensischer Bestand gemeldet; es blockiert
die `.4`-Evaluation nicht.

Der Rückweg verwendet denselben atomaren Konfigurationswechsel auf die vier
unveränderten `.2`-Werte. `rollbackEligible: true` bestätigt vorab nicht nur
Kartenbytes, sondern das vollständig signierte
Source-/Legacy-Image-/Welt-/Map-/Datenbank-Tuple. Eine v1-Attestation, ein fehlender
`MAP_RELEASE_PREFLIGHT_RUNTIME_*`-Wert oder ein fehlender kanonischer
Datenbank-Rollbackbeleg sperrt `pre-activation` geschlossen.
Der normale Startmodus bleibt auch nach Reboot strikt `active-candidate` und
darf `.2` nicht still akzeptieren. Der explizite Betriebsrückweg erfolgt
ausschließlich über die konfliktierende systemd-Unit
`ops/alpha/zugfolge-alpha-rollback.service`: Sie ruft den Compose-Wrapper mit
`--attested-rollback` auf. Der Wrapper beendet zuerst den Stack und qualifiziert
den v3-Beleg mit `map-release-preflight` im **aktuellen**, separat
digestgebundenen Prüfer-Image. Danach lädt er den bytegleich installierten
Legacy-Compose-Override und startet mit `--no-deps --no-build --force-recreate`
nur PostgreSQL, Keycloak im alten Schema `public`, die alte Game API sowie altes
Game Web und alte Livemap. Der Override bindet ausschließlich diese drei
Game-Image-Dienste an die attestierte Legacy-Referenz. V2-Weltpreflight,
Migration, Bootstrap, Keycloak-Schema-Gates und Reconciliation werden gegen den
zuvor separat restaurierten V1-Datenbankstand nicht ausgeführt. Damit bleibt
der manuell gewählte Rückweg auch nach Host-Reboot eindeutig; ein geerbter
Envwert, Retagging oder ein Container-`restart` kann ihn nicht einschalten.

Solange für das reale `.2` nur v1 vorliegt, ist kein laufender `.2`-Rückweg
freigegeben. Altes DB-Volume, alte Images und Artefakte werden stattdessen
forensisch und vom neuen Evaluationsvolume getrennt aufbewahrt. Der Rückweg gilt
erst als getestet, wenn die gleichen Readiness- und
Range-Prüfungen wieder die Vorgänger-ID melden. Die aktiven signierten
Weltprofile müssen dabei weiterhin zum zurückgesetzten Infrastrukturrelease
passen; andernfalls sperrt der Serverstart geschlossen. Evidence-, Restore-
und Umschaltprotokolle gehören in die
verschlüsselte Betriebssicherung; eine erfolgreiche Laufzeitprüfung ersetzt
keinen reproduzierbaren Buildcache-Restore.

### Freigabegrenzen für `infra-deutschland-2026.5` auf STRATO

Für `.5` bleiben vier Nachweise getrennt. `pack`/`verify` und die Prüfung des
frisch installierten Manifests beweisen die Byteintegrität. Die Ed25519-Prüfung
von Delivery-v2 gegen `zugfolge-map-deutschland-2026.5` im additiven
Map-/Infra-Scope beweist das Signervertrauen; dabei müssen
`zugfolge-map-deutschland-2026.4` und alle übrigen bestehenden Public-Key-Bytes
und Scopes unverändert erhalten sein. Weder Integrität noch Vertrauen beweisen
Odoo-Import, Game-Staging oder Produktionsaktivierung.

Vor einer STRATO-Mutation wird lesend der tatsächlich aktive Pointer und das
tatsächlich installierte, ausführbare Vorgänger-Tuple festgestellt. `.4` ist
als Trustanker und Buildvorgänger beibehalten, aber allein deshalb weder als
installiert noch als Rollbackziel anzunehmen. Kandidat und Vorgänger liegen in
getrennten unveränderlichen Verzeichnissen; `.5` muss vor der Installation
fehlen. Der Aktivierungs-Preflight bindet den vollständigen 40-stelligen
Source-Commit, die gepinnten Game-/Odoo-Image-Digests, Release-ID
`infra-deutschland-2026.5`, Paketmanifest-SHA, den erwarteten alten Pointer und
das signierte Runtime-Rollback-Tuple samt Datenbank- und
Keycloak-Restore-Belegen. Jede Abweichung blockiert Installation oder
Umschaltung.

Unmittelbar vor jeder zustandsändernden Installation oder Aktivierung ist eine
neue ausdrückliche Freigabe für genau `h3076743.stratoserver.net`, Commit,
Release-ID, Paketmanifest und Aktion einzuholen; zuvor wird der bestätigte
Hostschlüssel über den vorgesehenen sicheren Inventarweg geprüft. Ohne diese
Freigabe bleibt der Status `nicht installiert/aktiviert`. Eine Signatur- oder
Releasefreigabe, ein Draft-PR oder eine frühere Serverfreigabe ersetzt diese
unmittelbare Produktionsfreigabe nicht. Nach der Umschaltung werden derselbe
Preflight im Zustand `active-candidate`, Readiness, Release-ID, Range-Requests
und die vollständigen V2-Laufzeitbindungen erneut geprüft. Rollback ist nur auf
das vorher verifizierte vollständige Runtime-Tuple zulässig, nie allein auf
einen beibehaltenen Kartenstand oder Trustanker.

## Warum nicht in der Git-Historie?

Ein einzelner Git-Checkout wäre auf den ersten Blick bequem. Große, jährlich
ersetzte Binärdateien bleiben aber in jeder Git-Kopie dauerhaft in der
Historie, obwohl nur die aktuelle Version benötigt wird. Das vervielfacht
Klon-, Sicherungs- und CI-Datenmengen und macht eine beschädigte Übertragung
nicht automatisch sicherer. Das versionierte Datenpaket erhält den einfachen
Installationsweg, ohne Quellcode- und Datenhistorie zu koppeln: Code auschecken,
passendes Kartenpaket danebenlegen, verifizieren und atomar installieren.
