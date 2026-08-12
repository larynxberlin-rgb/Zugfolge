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
das Infrastruktur-PMTiles separat aus `LivemapConfigV1` und registriert darauf
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
allgemeinen Kartenverzeichnis gleichgesetzt werden:

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
vorhandenes Ziel wird nur wiederverwendet, wenn Manifest, Bytezahl und SHA-256
aller installierten Dateien exakt stimmen. Abweichungen führen zum Abbruch;
beschädigte oder fremde Dateien werden weder überschrieben noch stillschweigend
akzeptiert.

Der Jahreskandidat 2026.1 bindet 11.545.162.669 Byte Welt-Basemap,
1.536.379.722 Byte Deutschland-Infrastruktur, 1.291.001.856 Byte ReadModel und
18.014.208 Byte Zugkartenprojektion. Die vollständige Artefakt- und
Qualitätsbilanz steht in
[`deutschland-infracorpus.md`](deutschland-infracorpus.md).

Der reale Transportlauf ist erfolgreich ausgeführt:

| Beleg | Ergebnis |
|---|---|
| Paket | 1.172 Teile mit zusammen 14.408.875.328 Byte; einschließlich `manifest.json` und `manifest.sha256` 14.409.482.278 Byte |
| Manifest | 606.870 Byte; SHA-256 `c14fbf8120b3ea033fc3428b9e2a0e306acc30c79dfd237bc13ae6d55e8ea9c2` |
| `pack-plan` | Exit 0 in 51,2 s |
| `verify` | Exit 0 in 18,1 s |
| Erstinstallation | 1.037 installierte Dateien mit 14.409.482.198 Byte; Exit 0 in 28,0 s |
| zweite Installation | unverändertes Ziel erkannt, Status `reused`; Exit 0 in 12,5 s |

Paket und Testinstallation liegen außerhalb der Git-Historie unter
`var/map-package/zugfolge-map-deutschland-2026.1/` beziehungsweise
`var/maps/releases/infra-deutschland-2026.1/`. Der Lauf beweist Transport,
vollständige Integritätsprüfung, atomare Installation und idempotente
Wiederverwendung. Er ist weder Signatur noch produktiver Odoo-Import.

## Alpha-Laufzeit an das installierte Paket binden

Die Alpha-Laufzeit erhält **nicht** mehrere frei kombinierbare
Kartenverzeichnisse. Alle Dateien eines Jahresstands stammen aus genau dem eben
installierten, unveränderlichen Releaseverzeichnis. Für 2026.1 enthält `.env`
deshalb gemeinsam:

```dotenv
MAP_RELEASE_ID=infra-deutschland-2026.1
MAP_RELEASE_HOST_DIR=./var/maps/releases/infra-deutschland-2026.1
MAP_BASEMAP_STYLE_URL=/artifacts/maps/infra-deutschland-2026.1/style.json
MAP_GERMANY_PMTILES_URL=/artifacts/maps/infra-deutschland-2026.1/infra-deutschland-2026.1.pmtiles
```

`compose.alpha.yml` bindet dieses eine Hostverzeichnis an zwei klar getrennte
Verbraucher, jeweils nur lesbar:

- Die Livemap sieht es unter
  `/map-artifacts/maps/infra-deutschland-2026.1`. Ihr statischer Server liefert
  damit mindestens `style.json`, `basemap.pmtiles`,
  `infra-deutschland-2026.1.pmtiles`, `read-model.sqlite` und
  `train-map-projection.sqlite` unter der
  gemeinsamen öffentlichen Wurzel
  `/artifacts/maps/infra-deutschland-2026.1/` aus. Alle statischen Dateien
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
installiert und geprüft. Erst danach werden `MAP_RELEASE_ID`,
`MAP_RELEASE_HOST_DIR`, `MAP_BASEMAP_STYLE_URL` und
`MAP_GERMANY_PMTILES_URL` gemeinsam umgestellt und Game-API sowie Livemap neu
erzeugt. Für den Rollback werden dieselben vier Werte wieder auf das zuvor
installierte Verzeichnis gesetzt; dessen Bytes bleiben unangetastet. Der
Katalogvertrag ist in [`livemap-detailkatalog.md`](livemap-detailkatalog.md)
beschrieben.

## Warum nicht in der Git-Historie?

Ein einzelner Git-Checkout wäre auf den ersten Blick bequem. Große, jährlich
ersetzte Binärdateien bleiben aber in jeder Git-Kopie dauerhaft in der
Historie, obwohl nur die aktuelle Version benötigt wird. Das vervielfacht
Klon-, Sicherungs- und CI-Datenmengen und macht eine beschädigte Übertragung
nicht automatisch sicherer. Das versionierte Datenpaket erhält den einfachen
Installationsweg, ohne Quellcode- und Datenhistorie zu koppeln: Code auschecken,
passendes Kartenpaket danebenlegen, verifizieren und atomar installieren.
