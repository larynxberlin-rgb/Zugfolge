# Fester Arbeits-Prompt: Deutschland-InfraRelease zum Fahrplanwechsel

Diesen Prompt einmal jährlich in einem neuen, protokollierten Codex-Task
verwenden. Vor dem Start müssen folgende Pflichtplatzhalter aus dem
eingecheckten Jahresvertrag und seinen dort gebundenen Spezifikationen konkret
aufgelöst werden; kein Platzhalter darf in einem Kandidaten verbleiben:

- `<FAHRPLANJAHR>`, `<STICHTAG_UTC>`, `<QUELLWURZEL>`,
  `<ARTEFAKTWURZEL>` und `<INFRARELEASE_ID>`;
- `<ANNUAL_RELEASE_CONFIG>`, `<ANNUAL_ARTIFACT_SPEC>`,
  `<BUILD_EVIDENCE_SPEC>`, `<MAP_PACKAGE_PLAN>`,
  `<MAP_ASSET_NOTICES_SPEC>`, `<SOURCE_CAPTURE_MANIFEST>`,
  `<TIMETABLE_ROUTE_SPEC>`, `<SYNTHETIC_CLOSURE_SPEC>` und
  `<OPERATIONAL_QUALITY_SPEC>`;
- `<OPERATIONAL_ARTIFACT_ID>`, `<RELEASE_ARTIFACT_INVENTORY>`,
  `<OPERATIONAL_CANDIDATE>`, `<OPERATIONAL_CANDIDATE_SIDECAR>`,
  `<OPERATIONAL_DERIVER_SPECIFICATION>`, `<OPERATIONAL_DERIVER_REPORT>`,
  `<OPERATIONAL_DERIVER_OUTPUT>`,
  `<OPERATIONAL_EXECUTION_PINS>`,
  `<OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT>`,
  `<OPERATIONAL_LAUNCH_CONTEXT>`, `<OPERATIONAL_ANNUAL_PLAN>`,
  `<OPERATIONAL_ANNUAL_START_EVIDENCE>`,
  `<OPERATIONAL_NATIVE_RECEIPT>`, `<OPERATIONAL_OUTER_EXECUTION_RECEIPT>` und
  `<OPERATIONAL_PUBLICATION_RECEIPT>`;
- `<OPERATIONAL_VALIDATOR_PATH>`,
  `<PINNED_ZUGFOLGE_INFRA_RELEASE>`, `<SOURCE_CATALOG>`, `<RIGHTS_LEDGER>`,
  `<OPERATIONAL_VALIDATOR_BUILD_COMMIT>`,
  `<OPERATIONAL_VALIDATOR_REBUILD_SPEC>` und
  `<OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE>`;
- `<OPERATIONAL_REBUILD_ATTESTATION_BUNDLE>`,
  `<OPERATIONAL_EXECUTION_AUTHORITY_BUNDLE>`,
  `<OPERATIONAL_ATTESTATION_VERIFIER>` und
  `<OPERATIONAL_ATTESTATION_TRUSTED_ROOT>`;
- `<SEMANTIC_TILE_INPUTS>`, `<SEMANTIC_TILE_INPUT_ROOT>`,
  `<SEMANTIC_PMTILES_OUTPUT>`, `<GDAL_RUNTIME_MANIFEST>` und
  `<DELIVERY_KEY_ID>`.

`<OPERATIONAL_CANDIDATE>` ist der Pfad zu einem fachlich aus den gepinnten
Deutschlanddaten abgeleiteten, weltfreien `OperationalInfraRelease`, nicht zu
einer Deploymenthülle. `<OPERATIONAL_CANDIDATE_SIDECAR>` ist ausschließlich
der vom nativen Ableiter aus diesem Candidate-Dateinamen erzeugte
`.movement-route-templates-v2.json`-Pfad. `<ANNUAL_RELEASE_CONFIG>` ist der
eingecheckte Jahresvertrag für genau `<INFRARELEASE_ID>` und
`<FAHRPLANJAHR>`; eine generische Beispielkonfiguration darf ihn nicht
ersetzen. Führe alle Befehle aus dem Repository-Wurzelverzeichnis aus;
`<ARTEFAKTWURZEL>` und die `sourceFile`-Pfade der Jahresspezifikationen müssen
darunter liegen.

Löse Release-ID, Fahrplanjahr, Paketversion, Delivery-Key, Validator,
Execution-Pins, Rebuild-Verträge, Receipts, Asset-Notices, semantische
Eingaben und alle Ausgabeziele ausschließlich aus dem aktuellen
Jahresvertrag, `<BUILD_EVIDENCE_SPEC>` und `<MAP_PACKAGE_PLAN>` auf. Kopiere
keine Pfade, Bytezahlen oder SHA-256-Werte aus einem früheren Lauf in den
aktiven Vertrag. Ein Vorgängerstand bleibt nur dort zulässig, wo der aktuelle
Build-Evidence-Vertrag ihn ausdrücklich als historischen oder bytegleichen
Cross-Release-Input mit Quell- und Zielrelease bindet. Kein Vorgängerartefakt,
-schlüssel oder -scope darf als aktuelles Ausgabeziel überschrieben,
umbenannt, neu gepackt oder stillschweigend ersetzt werden. Jede aktuelle
Ausgabe entsteht create-new.

Validiere vor dem ersten Build alle aktiven Jahresbindungen gemeinsam und
brich bei jeder Abweichung ab:

- `<TIMETABLE_ROUTE_SPEC>` hat das Schema
  `zugfolge-germany-timetable-route-compiler/v5`, bindet
  `infraReleaseId=<INFRARELEASE_ID>` und nennt mit `output`, `transferOutput`
  und `report` drei verschiedene create-new-Ziele unter
  `<ARTEFAKTWURZEL>`. Binde diese Werte unverändert an
  `$TIMETABLE_ROUTE_OUTPUT`, `$TIMETABLE_TRANSFER_OUTPUT` und
  `$TIMETABLE_ROUTE_REPORT`.
- `<SYNTHETIC_CLOSURE_SPEC>` hat das Schema
  `zugfolge-synthetic-operational-closure-inputs/v2`,
  `releaseId=<INFRARELEASE_ID>` und `artifactRoot=<ARTEFAKTWURZEL>`.
  `<OPERATIONAL_QUALITY_SPEC>` hat das Schema
  `zugfolge-operational-quality-inputs/v1`, dieselbe Release-ID, dasselbe
  Fahrplanjahr und dieselbe Artefaktwurzel.
- `<SOURCE_CAPTURE_MANIFEST>` ist das aus dem aktuellen Jahresplan erzeugte,
  kanonische `zugfolge-source-capture/v2` mit derselben Release-ID und demselben
  Fahrplanjahr; sein Pfad liegt unter `<ARTEFAKTWURZEL>`.
- `<MAP_PACKAGE_PLAN>` hat das Schema `zugfolge-map-package-plan/v2`, die aus
  `<INFRARELEASE_ID>` abgeleitete exakte Paketversion und ausschließlich
  `zugfolge-map-runtime/v2`. Paket-ID, Runtimepfade, Release-Descriptor und
  alle aktuellen Ausgabeziele müssen zu demselben Jahreskandidaten gehören.
- `<MAP_ASSET_NOTICES_SPEC>` ist exakt die Eingabe
  `map-asset-notices-spec` aus `<BUILD_EVIDENCE_SPEC>`; Karten-Capture und
  Static-Sources-Builder erhalten denselben Pfad. `<GDAL_RUNTIME_MANIFEST>`
  ist exakt das Manifest des dort gebundenen PMTiles-Runtime-Bundles.
  `<SEMANTIC_TILE_INPUTS>` ist das aktuelle, create-new materialisierte
  `inputs.json` der dort gebundenen semantischen Assembly,
  `<SEMANTIC_TILE_INPUT_ROOT>` sein Elternverzeichnis und
  `<SEMANTIC_PMTILES_OUTPUT>` exakt die Ausgabe `semantic-pmtiles`. Alle vier
  Werte müssen zu `<INFRARELEASE_ID>` gehören; ein Quellpfad aus einer
  deklarierten Cross-Release-Wiederverwendung ist nicht selbst das aktuelle
  Eingabe- oder Ausgabeziel.
- Binde `<BUILD_EVIDENCE_SPEC>` unverändert an `$BUILD_EVIDENCE_SPEC`. Neue vollständige
  Operational-v2-Lieferungen verlangen
  `schema=zugfolge-map-release-build-evidence-spec/v3`; v1 und v2 sind nur
  historische Verifikationsverträge. Der v3-Vertrag muss genau neun
  aktivierungsrelevante Ausgaben führen: Basemap-PMTiles, Semantik-PMTiles,
  ReadModel, `operational-infrastructure-v2`,
  `movement-route-templates-v2`, `timetable-transfer-demands-v2`, Style,
  signiertes Deliverymanifest und Operational-Qualitätsbericht. Die beiden
  Sidecars besitzen die kanonischen Installationspfade
  `operational-infrastructure-v2.movement-route-templates-v2.json` und
  `timetable-routes-v2.transfer-demands-v2.json`. Binde das neue, vor dem Lauf
  nicht vorhandene Evidence-Ziel
  `<ARTEFAKTWURZEL>/map-release-build-evidence.json` an
  `$BUILD_EVIDENCE_OUTPUT`.

Prüfe Cross-Release-Wiederverwendung, bevor irgendein davon abhängiger
Jahresbuild startet. Eine Vorjahresdatei darf nur wiederverwendet werden, wenn
sie in `$BUILD_EVIDENCE_SPEC` unter einer `specification`-Eingabe mit
`mode=byte-identical-cross-release`, Quell- und Zielrelease sowie Quellpfad,
kanonischem Zielpfad, Bytezahl und SHA-256 einzeln gebunden ist. Manuelles
Kopieren, Umbenennen oder Verlinken ist unzulässig. Wenn der v3-Vertrag solche
Einträge enthält, müssen alle Quellen existieren und alle Ziele fehlen; führe
dann ausschließlich den sicheren Materialisierer aus:

```sh
node tools/tiles/materialize-cross-release-reuse.mjs "$BUILD_EVIDENCE_SPEC" .
```

Der Materialisierer muss vor der ersten Veröffentlichung alle Ziele auf
Abwesenheit prüfen, Quellbytes und SHA-256 streamend verifizieren, sämtliche
Dateien zunächst getrennt stagen, atomar create-new veröffentlichen und bei
einem Teilfehler ausschließlich die von diesem Lauf erzeugten Ziele
zurücknehmen. Sichere das ausgegebene
`zugfolge-cross-release-reuse-materialization/v1`-Receipt im Laufprotokoll;
der spätere Evidence-v3-Build prüft Spezifikation, Quell- und Zielbytes erneut.
Ohne deklarierte Wiederverwendung wird dieser Aufruf ausgelassen und jede
aktuelle Ausgabe regulär neu gebaut.

Ersetze Jahreszahlen nicht pauschal in gepinnten Quellen. Ein datierter
Vorjahresname ist nur innerhalb eines aktuellen Jahresvertrags zulässig, wenn
er dort ausdrücklich als unveränderter historischer oder
Cross-Release-Reuse-Input mit Bytezahl und SHA-256 gebunden ist. Er darf nie
als aktuelle Release-ID, aktives Ausgabeverzeichnis oder ausführbarer
Jahresvertrag verwendet werden.

---

Du baust den vollständigen Deutschland-`InfraCorpus` für das Fahrplanjahr
`<FAHRPLANJAHR>` und daraus zunächst einen reproduzierbaren, unsigned
`InfraRelease`-Kandidaten. Eine Signatur ist ein späterer, ausdrücklich
freizugebender Schritt. Lies zuerst
`AGENTS.md`, `docs/daten.md`, `docs/rechte.md`,
`docs/deutschland-infracorpus.md`, `docs/infrastruktur.md`,
`docs/betriebsgraph.md`, `docs/betriebsengine.md`, ADR-0014, ADR-0022,
ADR-0025 und ADR-0032, `docs/betriebsengine-lastnachweis.md` sowie
`<ANNUAL_RELEASE_CONFIG>` und
`tools/region-import/germany/source-catalog.json`. Ändere keine
Rechteentscheidung stillschweigend.

Ziel und Grenzen:

- Importiere das deutschlandweite EBO-Regelspurnetz vollständig. Lade den
  gesamten Korpus in den Serverrelease; die aktuell spielbare Region bleibt
  eine separate `WorldRelease`-Maske.
- Stelle Klasse A her, wo jede Pflichtdimension belastbar validiert ist.
  Schließe jede verbleibende Lücke als vollständiges, konservatives
  Klasse-B-Modell. Jeder EBO-Abschnitt des Release muss A oder B sein; eine
  ungelöste Pflichtdimension blockiert den Kandidaten. Außerhalb des
  EBO-Regelspurnetzes liegende Infrastruktur darf nur als unklassifizierter,
  nicht interaktiver Basiskartenkontext erscheinen.
- Reale Genauigkeit ist wünschenswert, aber die intern widerspruchsfreie,
  regelkonforme Betriebswahrheit ist zwingend. Erfinde keine vermeintlich
  beobachteten Fakten. Jede Annahme nennt eine versionierte Regel.
- Erzeuge genau ein unveränderliches, weltübergreifend wiederverwendbares
  `operational-infrastructure-v2.json`. Es enthält ausschließlich das statische
  `OperationalInfraRelease`: Kanten, Geometrien, Laufwege, Stellwerksobjekte,
  Konfliktressourcen, Bahnsteige, Regionsgrenzen und RZÜ-Layout. Weltkennung,
  Weltepoche, Fahrzeuge, Formationen, Züge, Befehle, Ereignisse und dynamischer
  Betriebszustand gehören ausdrücklich nicht in den `InfraRelease`.
- E31/ADR-0032 ist ein harter Cutover: keine Waypoint-/v1-Initialisierung,
  kein Dual-Write, kein JavaScript-Fallback, kein `AddDelay` oder
  `delay_seconds`, keine TypeScript-Positionswahrheit und kein Rückfall auf
  `mapEstimate`. LiveMap und RZÜ projizieren ausschließlich denselben
  committed v2-Zustand mit exakter releasegebundener Geometrie. Diese Ablösung
  betrifft den operativen Laufzeit- und Positionspfad; bestehende unabhängige
  statische oder administrative `/v1`-Verträge werden nicht ohne eigene
  Schemaentscheidung umbenannt.
- Kein externer Dienst liegt im heißen Pfad. Alle Quellen werden einmalig
  erfasst, gehasht und offline verarbeitet.

Quellenlauf:

1. Prüfe jede Quelle gegen `tools/guards/quellenregister.json`. Stoppe vor dem
   Import, wenn Kennung, Lizenz, Bereitstellungsweg oder datierte Freigabe fehlt.
   Verwende auch für den autoritativen Vorabplan ausschließlich den
   Jahresvertrag:

   ```sh
   node tools/region-import/germany/build-germany-release.mjs plan <ANNUAL_RELEASE_CONFIG> tools/region-import/germany/source-catalog.json tools/guards/quellenregister.json
   ```
2. Erfasse die im Quellkatalog als `release-input` freigegebenen Jahresstände:
   Deutschland-OSM-PBF, den offiziellen DB-InfraGO-Open-Data-Stand,
   GTFS-Schienenregionalverkehr, Copernicus-DEM und OpenStation-NeTEx.
   OpenStation ist die verpflichtende Stations- und Bahnsteigquelle; bevorzuge
   den offiziellen, zugangsdatenfreien Mobilithek-Bulkpfad über
   `https://bahnhof.de/daten/netex` und pinne dessen tatsächlich empfangene
   Bytes. `annual-infrastructure-master` bleibt mangels veröffentlichter
   Nutzungsbedingungen `internal-validation` und darf weder Capture- noch
   Releasequelle sein. StaDa beziehungsweise `station-enrichment` wird in
   diesem kostenlosen Clean-v2-Lauf nicht erfasst und ist keine Releasequelle.
   Keine kostenpflichtige, zugangsbeschränkte oder kontingentierte Quelle ist
   Voraussetzung für Klasse B.
   Erfasse außerdem genau eine freigegebene, vollständig gepinnte Basemap aus
   `osm-planet-basemap` oder `protomaps-daily-basemap`; eine Live- oder
   `latest`-Referenz ist unzulässig. Schreibe für jede Eingabe einschließlich
   der Basemap Version, Abrufzeit `<STICHTAG_UTC>`, Bytezahl und SHA-256 in das
   Capture-Manifest.
3. APN-Skizzen werden in diesem kostenlosen Clean-v2-Lauf nicht erfasst und
   sind weder Releaseinput noch Releasequelle. Ihr Fehlen blockiert die
   synthetische Klasse-B-Schließung nicht. Ein gesonderter zukünftiger
   Validierungslauf dürfte APN nur nach erneuter Rechteprüfung als interne,
   nicht ausgelieferte Evidenz behandeln.

Ausgeschlossene interne Stationsplanevidenz:

- Erzeuge für diesen Lauf keine APN-RL100-Liste und lade keine APN-PDFs,
  Seitenbilder, OCR- oder Layoutdaten herunter.
- In Capture, Source-Manifesten, Releasewrappern und Paket dürfen weder APN,
  StaDa noch Trassenfinder-/Legacy-Operational-Netzdaten als Quelle,
  Attribution oder Hash auftreten.
- Behandle OSM, den offiziellen InfraGO-Datensatz, OpenStation, DEM und GTFS
  als getrennte reale Evidenzen. Bei Widersprüchen gewinnt keine Quelle allein
  aufgrund ihres Namens; erzeuge einen Reviewfall mit Feld, Abschnitt und
  beiden Belegständen.
- OpenRailwayMap dient nur als Interpretationsdokumentation für Railway-Tags;
  importiere keine ORM-Daten, ORM-Tiles oder ORM-Liveabfragen.

Deterministischer Build und Prüfung:

1. Filtere EBO-Regelspur. Behalte außerhalb liegende Infrastruktur allenfalls
   als unklassifizierten, gedimmten Basiskartenkontext; sie wird weder Teil des
   operativen Release noch bestellbar oder interaktiv.
2. Erzeuge stabile IDs, Graph, einzelne Gleise, Betriebsstellen, Weichen,
   Signale, Blöcke, Fahrstraßen- und Konfliktmodelle. Der operative Anteil
   enthält insbesondere gerichtete Gleiskanten mit ganzzahliger Länge und
   exakter E7-Polylinie, Freimelde-/Freigabegrenzen, Fahrstraßenvorlagen samt
   Fahrweg, Durchrutschweg, Flankenschutz und zugschlussbezogener Auflösung,
   Profile, Bahnsteigintervalle, sichere Übergabepunkte, Regionsgrenzen und das
   statische RZÜ-Layout aus `docs/betriebsengine.md`. Sortiere alle Eingaben vor
   dem Hashen stabil; Zeiten und Längen bleiben ganzzahlig. Fehlende
   betriebliche Elemente dürfen nur durch den Offline-Releasecompiler mit
   versionierter deterministischer Regel konservativ erzeugt werden; es gibt
   keinen Laufzeit-Fallback.
3. Kennzeichne diesen reinen Build-Zwischenschritt mit
   `ZUGFOLGE_NON_AUTHORITATIVE_CORPUS_BUILD=1` und führe den Compiler
   ausschließlich mit dem Jahresvertrag aus:

   ```sh
   ZUGFOLGE_NON_AUTHORITATIVE_CORPUS_BUILD=1 node tools/region-import/germany/build-germany-release.mjs compile <ANNUAL_RELEASE_CONFIG> <ARTEFAKTWURZEL>/pbf-report.json <ARTEFAKTWURZEL>/way-features.geojsonseq <ARTEFAKTWURZEL>/validation.jsonseq <ARTEFAKTWURZEL>/corpus.jsonseq <ARTEFAKTWURZEL>/map-release-free-v2/public/quality.json <QUELLWURZEL>/internal-evidence/accepted-evidence.json
   ```

   Erzeuge den Qualitätsbericht je Dimension, Ursache und Länge. Prüfe
   ausdrücklich, dass jeder operative Abschnitt A oder konservativ
   geschlossenes B ist. Eine ungelöste Pflichtdimension muss den Kandidaten
   blockieren. Dieser Schritt darf selbst keinen Release freigeben.
4. Erzeuge getrennte, selbst gehostete PMTiles für weltweite Dark-Basemap und
   semantische Deutschland-Infrastruktur. Prüfe stabile Feature-IDs, Zoomvertrag,
   Attribution, Dateihash und HTTP-Range-Auslieferung.
5. Qualifiziere nach ADR-0025 jeden gebietsüberschreitenden GTFS-Zuglauf
   offline als zusammenhängende `JourneyChain` aus bestellbaren `PlayableLeg`,
   benannten `BoundaryPortal` und nicht disponierbaren `ExternalLeg`.
   Grenzfenster sind unveränderliche serverseitige Randbedingungen;
   `ExternalLeg` bindet Fahrt, Fahrzeug und gegebenenfalls Personaldienst bis
   zur Rückkehr oder zum echten Außenende. Ein lediglich als `first-outside`
   erkannter Schnitt bleibt interne Builddiagnose und blockiert den Kandidaten,
   wenn er zu einer erforderlichen Fahrtkette des Korpusscopes gehört. Erzeuge
   und prüfe dafür Portalkatalog, Außenzeitprüfung,
   Umlauf-/Fahrzeug-/Personalbindungsnachweis und einen eigenen
   Journey-Chain-Qualifizierungsbericht; unqualifizierte Ketten dürfen weder
   ausgeliefert noch bestellbar werden.

   Erzeuge danach die gepinnten Fahrwege ausschließlich aus dem freien
   GTFS-Snapshot und den realen OSM-Gleiskanten der
   `semantic-tile-inputs-free-v2`. Der Compiler darf weder einen
   Trassenfinder-Export noch ein Legacy-`operational-network.json` lesen; diese
   Daten sind keine Releasequelle. Verwende den eingecheckten v2-Vertrag:

   ```sh
   node tools/region-import/germany/run-timetable-route-compiler.mjs <TIMETABLE_ROUTE_SPEC> .
   ```

   Der create-new-Lauf muss `$TIMETABLE_ROUTE_OUTPUT`,
   `$TIMETABLE_TRANSFER_OUTPUT` und `$TIMETABLE_ROUTE_REPORT` gemeinsam
   erzeugen. Der Bericht muss Policy
   `synthetic-operational-b/v2`,
   den Snapshot-Dateihash und internen `snapshotHash`, Archiv-SHA,
   `sourceLicense=CC-BY-4.0`, alle ausgewählten Segmente 1:1 und eine bytegleiche
   `routeSetSha256` binden. Er muss `realGeometry=true`,
   `simulatedOperationalAssignment=true`, `realInterlockingFactsClaimed=false`,
   `operationalNetworkUsed=false`, `gtfsShapeGeometryUsed=false` und
   `inventedGeometryUsed=false` ausweisen. Same-Stop-Übergänge sind nur als
   explizite Nullbewegung zulässig; sie dürfen weder eine erfundene Geometrie
   noch einen unvollständigen Fahrweg erzeugen. Der Transferbeleg muss den
   reproduzierbaren DailyPlan, seine vollständige Rollover-Permutation, alle
   erforderlichen Überführungswege und deren `transferSetSha256` binden. Der
   aktuelle Vertrag ist ohne Fallback
   `zugfolge-germany-timetable-route-report/v4` mit
   `zugfolge-daily-circulation-plan/v2` und
   `zugfolge-timetable-transfer-demands/v2`. Jede geplante Fortsetzung muss
   genau einmal partitioniert sein: nur identische `locationId` **und**
   `physicalStopId` sind Turnaround; jede andere interne Verkettung und jeder
   entsprechende Rollover ist ein real gerouteter Zugtransfer. Unbekannte
   Felder, fehlende Routenbindungen oder ein unvollständiges Cover blockieren
   den Kandidaten.

   Übernimm die erwarteten Mengen, Bytezahlen und SHA-256-Werte ausschließlich
   aus `<TIMETABLE_ROUTE_SPEC>` und den darin gebundenen aktuellen Inputs.
   Prüfe sie gegen die tatsächlich neu erzeugten Ausgaben. Ein Messwert aus
   einem früheren Jahreslauf ist weder ein Default noch ein zulässiger
   Ersatz-Pin. Abweichungen blockieren den Kandidaten oder verlangen eine
   fachlich geprüfte Änderung des eingecheckten Jahresvertrags; sie werden nie
   nur in diesem Prompt aktualisiert.

   Lies anschließend den strikt validierten Subvertrag
   `pipeline.operationalDeriver` aus `<ANNUAL_RELEASE_CONFIG>`. Sein
   `primaryRunner` muss exakt
   `tools/region-import/germany/run-capture-operational-infrastructure-v2.anchored-bundle.mjs`
   und `primaryRunnerMode` muss exakt
   `system-launcher-held-bundle-stdin-v1` sein. Das `primaryRunner`-File ist
   dabei ausschließlich gepinntes Bundle-Datenmaterial und niemals selbst
   ein ausführbarer Entrypoint. `systemCommandBuilder` muss
   exakt
   `tools/region-import/germany/print-operational-infrastructure-v2-system-launch-command.mjs`
   und `systemCommandBuilderMode` muss exakt
   `source-only-print-direct-command-v1` sein. Dieser Builder ist ausdrücklich
   kausal und releasebeweisfähig, mit seinem exakten File-Proof in
   `runner.roots` und `runner.importClosure` gebunden, aber selbst kein
   mutierender Jahreslauf-Entrypoint. Der direkte Aufruf
   der gleichnamigen Runner-`.mjs`-Quelle ist ebenfalls nicht releasefähig und
   muss vor jeder Artefakterzeugung abbrechen. Der Wert
   `executionPins` muss exakt `<OPERATIONAL_EXECUTION_PINS>` bezeichnen; seine
   `specification` muss
   `schema=zugfolge-germany-operational-infrastructure-derivation/v2`,
   `mode=deterministic-conservative-v1`, denselben `<INFRARELEASE_ID>` und die
   Policy `synthetic-operational-b/v2` binden. Die sechs normalisierten
   Kartenlayer `tracks`, `platforms`, `switches`, `signals`, `blocks` und
   `conflictResources` müssen aus demselben Jahresstand stammen. Zusätzlich
   muss `layers.timetableRoutes` exakt den aus `<TIMETABLE_ROUTE_SPEC>`
   validierten, gepinnten Pfad `$TIMETABLE_ROUTE_OUTPUT` bezeichnen;
   `layers.transferDemands.path` muss ebenso exakt
   `$TIMETABLE_TRANSFER_OUTPUT` bezeichnen und dessen Bytezahl und SHA-256
   binden;
   `null`, ein fehlender oder ein leerer Pfad ist für einen aktivierbaren
   Jahresrelease unzulässig. `candidate` muss exakt
   `<OPERATIONAL_CANDIDATE>` entsprechen und `output` muss exakt
   `<ARTEFAKTWURZEL>/operational-infrastructure-v2.json` bezeichnen.
   `candidateMovementRouteTemplates` muss exakt
   `<OPERATIONAL_CANDIDATE_SIDECAR>` entsprechen. Der getrennte
   `recoveryPublisher` muss die eingecheckten Capture-/Publisher-EntryPoints
   sowie `<OPERATIONAL_VALIDATOR_PATH>`,
   `<OPERATIONAL_VALIDATOR_BUILD_COMMIT>`,
   `<OPERATIONAL_VALIDATOR_REBUILD_SPEC>`,
   `<OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE>`,
   `<OPERATIONAL_NATIVE_RECEIPT>` und
   `<OPERATIONAL_PUBLICATION_RECEIPT>` exakt binden. Seine lokale
   Ausführungsinventur umfasst Publisher-Wrapper, Publisher-Implementierung,
   Deriver, Materializer, Create-new-Vertrag,
   `operational-infrastructure-binding.mjs`, Execution-Pins-Implementierung
   sowie den typisierten Validator-Rebuild-Bootstrap und -Verifier. Der
   Binding-Vertrag darf keine ignorierte `packages/*/dist`-Laufzeitdatei
   laden. Binde `specification`, `report` und `output` unverändert aus diesem
   Subvertrag an `<OPERATIONAL_DERIVER_SPECIFICATION>`,
   `<OPERATIONAL_DERIVER_REPORT>` und `<OPERATIONAL_DERIVER_OUTPUT>`.

   `<OPERATIONAL_EXECUTION_PINS>` muss das Schema
   `zugfolge-germany-operational-v2-execution-pins/v1` und dieselbe Release-ID
   tragen. `runner.bundle`, `runner.entrypoint`, jedes Element aus `runner.roots` und jedes
   Element aus `runner.importClosure` ist ein vollständiger File-Proof aus
   `file`, `bytes` und `sha256`. Roots und Importclosure sind sortiert und
   eindeutig; der EntryPoint und jeder Root müssen mit denselben Byte-Pins in
   der vollständigen statischen ESM-Closure vorkommen. Nur `node:`- und
   relative statische Imports sind zulässig; Dynamic Imports, CommonJS,
   Bare-/`file:`-Loader sowie Symlink-/Junction-Ahnen blockieren den Lauf.
   Runner und Importclosure werden vor und nach dem Kindprozess gegen dieselben
   unveränderlichen Pins geprüft. `runner.invocation` muss exakt
   `mode=system-launcher-held-bundle-stdin-v1`,
   `nodeArguments=["--input-type=module","-"]` und `nodeOptions=null`
   binden. `runner.launcher` bindet Modus, Bytezahl und SHA-256 des kanonischen
   inline System-Bootstraps; `runner.runtime` bindet ausschließlich logische
   Node-24-ID, Zielplattform, Bytezahl und SHA-256, niemals einen lokalen
   absoluten Pfad. Der Systembootstrap hält und hasht Bundle und Runtime vor
   dem Start, prüft Node 24 kausal aus denselben gehaltenen beziehungsweise
   versiegelten Bytes und startet das Bundle nur über stdin bei vollständig
   bereinigter Umgebung.

   Der Validatorblock der Execution-Pins muss Pfad, Bytezahl, SHA-256,
   `<OPERATIONAL_VALIDATOR_BUILD_COMMIT>`,
   `<OPERATIONAL_VALIDATOR_REBUILD_SPEC>` und
   `<OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE>` exakt mit dem Jahresvertrag und
   dem Build-Evidence-Vertrag abgleichen. Nur das dort bytegebundene,
   commit- und hashbenannte Release-Binary ist zulässig. Ein veränderlicher
   `target/release`-Pfad, `cargo run` oder ein nachträglich umetikettiertes
   Binary ist kein Releasebeleg. Preserved Binary, offizieller Rebuild und
   deren Belege dürfen bis zur Buildcache-Inventarisierung weder überschrieben
   noch unter einem anderen Commit geführt werden.
   Der offizielle Rebuild wird an dem in
   `<OPERATIONAL_VALIDATOR_REBUILD_SPEC>` gebundenen create-new-Ziel erzeugt.
   Sein Raw-SHA-256 wird nicht vor dem Build behauptet, sondern erst aus den
   tatsächlich publizierten Bytes in das portable Rebuild-Receipt
   `<OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE>` übernommen. Vor Capture und
   Publikation muss der typisierte Rebuild-Vertrag gegen das lokale
   Quellrepository materialisiert und danach unabhängig verifiziert sein. Der
   minimale Bootstrap wird durch den aufrufenden,
   eingecheckten EntryPoint gegen die externen Spec-Pins geprüft, bevor seine
   lokale Importclosure aus gehaltenen Bytes geladen wird; ein direkt
   aufgerufener Bootstrap kann seine eigenen bereits laufenden Bytes nicht
   selbst beglaubigen und ist deshalb kein Releasebeleg. Der Materialisierer
   erzeugt über `git archive` aus exakt
   `<OPERATIONAL_VALIDATOR_BUILD_COMMIT>` einen privaten sauberen
   Quellbaum und baut mit leerem externen Target-Verzeichnis und dem exakt
   spezifizierten `cargo build --locked --release` unter kontrollierter
   Umgebung. Sein create-new Receipt bindet Source-Archiv und -Baum,
   `Cargo.lock`, Cargo/Rustc/Target/Profile, Buildumgebung und -logs, beide
   Raw-Binaries, die PE-Sections und die ausschließlich erlaubten
   COFF-TimeDateStamp- und OptionalHeader-CheckSum-Normalisierungen. Beide
   normalisierten Binaries müssen den in
   `<OPERATIONAL_VALIDATOR_REBUILD_SPEC>` gebundenen normalisierten SHA-256
   besitzen:

   ```sh
   node tools/region-import/germany/operational-validator-rebuild-evidence-cli.mjs materialize <OPERATIONAL_VALIDATOR_REBUILD_SPEC> "$OPERATIONAL_VALIDATOR_SOURCE_REPOSITORY" <OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE> .
   node tools/region-import/germany/operational-validator-rebuild-evidence-cli.mjs verify <OPERATIONAL_VALIDATOR_REBUILD_SPEC> <OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE> .
   ```

   Ein falscher Commit oder `Cargo.lock`, ein abweichender Buildbefehl,
   Toolchain-/Umgebungsdrift, eine nicht erlaubte PE-Abweichung oder ein bereits
   vorhandenes Binary- oder Receiptziel blockiert den Lauf. Der preserved
   Raw-Pin darf nie durch den erst im Receipt belegten Rebuild-SHA ersetzt
   werden; `verify` muss ohne Quellrepository, Git oder Buildtoolchain aus
   Spec, Receipt, dem persistierten Quell-TAR, dem persistierten
   Provenienzbeleg und den beiden unveränderlichen Binaries funktionieren.
   Publication- und Build-Evidence behalten seine exakten Capture-Bytes und
   den getrennten Commit `operationalValidatorBuild`; zusätzlich binden sie
   Rebuild-Spezifikation, Rebuild-Bootstrap, portables Rebuild-Receipt und
   unveränderliches offizielles Rebuild-Binary.
   Prüfe vor der Ableitung, dass Candidate, Candidate-Sidecar, Bericht,
   `<OPERATIONAL_NATIVE_RECEIPT>`, finales Operational-v2-Artefakt, finales
   Sidecar und `<OPERATIONAL_PUBLICATION_RECEIPT>` noch nicht existieren. Ein
   älteres Candidate-Triplet aus einem getrennten oder veränderlichen Runner
   ist nur forensische Evidenz; verschiebe es mit Hashprotokoll aus den aktiven
   create-new-Zielen und verwende es nicht als Releaseinput.

   Führe danach ausschließlich den integrierten V2-Pfad mit den zuvor exakt
   aus `<ANNUAL_RELEASE_CONFIG>` gebundenen Argumenten aus. Der Runner prüft
   `<OPERATIONAL_EXECUTION_PINS>` sowie die gehaltenen Runner- und
   Validatorbytes vor und nach dem Kindprozess, übergibt dessen eine
   strukturierte JSON-Ausgabe unmittelbar an den Capture-Schritt und erzeugt
   `<OPERATIONAL_NATIVE_RECEIPT>` create-new. Erst dieses Receipt darf der
   Publisher akzeptieren:

   ```text
   node tools/region-import/germany/publish-operational-infrastructure-v2.mjs preflight <OPERATIONAL_DERIVER_OUTPUT> <OPERATIONAL_PUBLICATION_RECEIPT>
   ```

   Materialisiere die in `<OPERATIONAL_EXECUTION_PINS>` mit Bytezahl und
   SHA-256 gebundene Node-24-Runtime create-new als
   `<ARTEFAKTWURZEL>/toolchain/nodejs-24-operational-runner-v1.exe` und prüfe
   ihre Bytes vor und nach dem Kopieren.
   Starte die sichere lokale CLI ausschließlich mit genau dieser gehaltenen
   Runtime. Schreibe ihren portablen repositoryrelativen Pfad sowie die sieben
   Runnerargumente in einen exakten
   `zugfolge-operational-v2-direct-system-launch-context/v1`. Die
   Arbeitswurzel ist kein neunter Operatorinput: Der gepinnte Rust-Executor
   leitet sie kausal aus seiner eigenen im Annual-Plan belegten Dateilokation
   ab. Der Kontext wird intern einmal als kanonisches UTF-8-JSON/Base64
   transportiert; absolute oder rohe Pfadwerte gelangen nie in eine
   Shell-Kommandozeile.

   Vor Phase 1 und vor dem Merge des später geschützten `main`-Commits muss die
   Trust-Vorbereitung abgeschlossen sein. Sichere dazu die kanonisch sortierte
   Menge und die öffentlichen PEM-Bytes aller vorhandenen Einträge aus
   `ops/keys/trusted-delivery-keys.json` sowie ihre Scopes. Erzeuge nach
   namentlicher Key-Registrierungsfreigabe ein neues Ed25519-Keypair;
   `$DELIVERY_PRIVATE_KEY` liegt außerhalb von Repository, Worktree, Quell- und
   Artefaktwurzel, Buildcache, Transportpaket, Laufprotokoll und Deploymenthost.
   Der private Pfad und das private Schlüsselmaterial werden weder in Evidence
   noch in der Abschlussdokumentation ausgegeben. `$DELIVERY_KEY_ID` ist
   ausschließlich aus der aktuellen Paketversion abgeleitet. Prüfe vor dem
   Commit kryptographisch, dass privater und öffentlicher Schlüssel
   zusammengehören. Checke ausschließlich die öffentliche PEM-Datei unter
   `ops/keys/` ein und ergänze `$DELIVERY_KEY_ID` im selben Commit additiv in
   `ops/keys/trusted-delivery-keys.json` sowie ausschließlich im passenden Scope
   von `ops/keys/trusted-delivery-key-scopes.json`. Diese Registrierung ist noch
   keine Delivery-Signatur und keine Releasefreigabe.

   Jeder zuvor vorhandene Schlüssel, seine PEM-Bytes und seine bisherigen
   Scopes müssen unverändert erhalten bleiben; Entfernen, Ersetzen,
   Umsortierungsverlust oder stillschweigendes Widerrufen eines Altankers
   blockiert den Lauf. Der `candidatePackage.retainedTrustedKeyIds`-Vertrag von
   `$BUILD_EVIDENCE_SPEC` nennt jeden vor diesem Lauf vorhandenen
   Vertrauensanker eindeutig und kanonisch sortiert; der neue
   Kandidatenschlüssel darf darin nicht als Altanker erscheinen. Erst der
   Commit mit dieser additiven Trust-Registrierung darf geschützt gemergt und
   anschließend unverändert für beide Authority-Phasen, Kartenbuild, Signatur
   und Paketierung verwendet werden.

   Der releasefähige Start besteht aus zwei getrennten, commitgleichen
   Authority-Phasen und der dazwischen lokal gehaltenen Ausführung. Beide
   GitHub-Phasen laufen ausschließlich per `workflow_dispatch` auf dem
   geschützten `main`-Commit. Ein Branch-, Pull-Request-, Self-hosted- oder
   abweichender Commitlauf ist nicht releasefähig.

   Phase 1 ist
   `.github/workflows/operational-validator-rebuild-evidence.yml`. Sie baut
   das in `<OPERATIONAL_VALIDATOR_REBUILD_SPEC>` gebundene Binary auf einem
   frischen GitHub-hosted Windows-Runner reproduzierbar nach, materialisiert
   mit `<PINNED_ZUGFOLGE_INFRA_RELEASE>` ausschließlich den Annual-Plan
   `<OPERATIONAL_ANNUAL_PLAN>` und den Executor-Startbeleg
   `<OPERATIONAL_ANNUAL_START_EVIDENCE>` und erzeugt für beide Dateien sowie
   ihre create-new Completion-Belege eine gemeinsame GitHub-Sigstore-
   Build-Provenienz. Lade das vollständige Evidence-Artefakt und das getrennte
   minimale Plan-Authority-Artefakt über ihre numerischen GitHub-Artifact-IDs.
   Prüfe vor dem Entpacken GitHub-Metadaten, Workflow, `main`-Commit,
   erfolgreichen Abschluss und Archivdigest; danach muss das jeweilige
   Dateiinventar exakt dem eingecheckten Rebuild-Vertrag entsprechen. Das
   Sigstore-Bundle wird unverändert als
   `<OPERATIONAL_REBUILD_ATTESTATION_BUNDLE>` gehalten. Eine lokal selbst
   erzeugte Plan- oder Startdatei ist kein Ersatz.

   Führe anschließend auf Windows ausschließlich die sichere lokale CLI mit
   genau diesen heruntergeladenen, erneut bytegeprüften Plan-/Startbelegen aus:

   ```powershell
   & ".\<ARTEFAKTWURZEL>\toolchain\nodejs-24-operational-runner-v1.exe" tools/region-import/germany/run-operational-infrastructure-v2-annual-execution.mjs execute <OPERATIONAL_EXECUTION_PINS> <OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT> <ANNUAL_RELEASE_CONFIG> <SOURCE_CATALOG> <RIGHTS_LEDGER> <OPERATIONAL_LAUNCH_CONTEXT> <OPERATIONAL_ANNUAL_PLAN> <OPERATIONAL_ANNUAL_START_EVIDENCE> <OPERATIONAL_OUTER_EXECUTION_RECEIPT>
   ```

   Die CLI prüft Pins, Direct-Contract, Plan, Startbeleg und sämtliche
   Completion-Belege über gehaltene Bytes. Sie startet den byte- und
   commitgebundenen Rust-Executor ausschließlich über den gepinnten
   System32-Launcher mit vollständig ersetzter Umgebung und einem
   `windows-kill-on-job-close-root-exit-bounded-io-v1`-Job. Der
   Rust-Executor führt ausschließlich den bereits autorisierten Plan aus; er
   darf keinen neuen Plan bilden. Erfolg erzeugt create-new
   `<OPERATIONAL_OUTER_EXECUTION_RECEIPT>` und dessen Completion-Beleg. Der
   Outer-Beleg bindet denselben Annual-Launch-Vertrag bis in das integrierte
   Native-Receipt; ein gemischter, forensischer oder fremder Inner-/Outer-Lauf
   scheitert.

   Phase 2 ist `.github/workflows/operational-v2-execution-authority.yml`.
   Sie läuft auf exakt demselben geschützten `main`-Commit und in der
   geschützten Umgebung `operational-release-approval`. Übergib ausschließlich
   die numerische ID des minimalen Phase-1-Artefakts sowie Bytezahl und
   SHA-256 von Outer- und Completion-Beleg. Diese Phase führt die lokalen
   Quellen ausdrücklich **nicht** erneut aus; ihr enger
   `verificationScope=operator-approved-hash-binding-not-source-reexecution-v1`
   attestiert nach manueller Freigabe nur die beiden gehaltenen Hashes gegen
   denselben Phase-1-Plan und Commit. Lade das Ergebnis create-new als
   `<OPERATIONAL_EXECUTION_AUTHORITY_BUNDLE>` und verifiziere beide
   Singleton-Attestierungen lokal erneut mit dem bytegepinnten
   `<OPERATIONAL_ATTESTATION_VERIFIER>` und dem bytegepinnten
   `<OPERATIONAL_ATTESTATION_TRUSTED_ROOT>`. Erst diese vollständige Kette darf
   in Build-Evidence, Delivery-v2, Paketierung und Aktivierung gelangen.

   `print-operational-infrastructure-v2-system-launch-command.mjs` ist nur ein
   optionaler Diagnosevergleich. Er meldet zwingend `causal=false`,
   `releaseEvidenceEligible=false` und `releaseExecutionEligible=false`, steht
   weder in `runner.roots` noch in `runner.importClosure`, und sein ausgegebener
   Command-Block darf niemals ausgeführt, gepiped oder als Receiptquelle
   akzeptiert werden.

   Nach einem Exit 0 des direkten OS-Befehls und erfolgreicher Prüfung des
   create-new Native-Receipts darf publiziert werden:

   ```text
   node tools/region-import/germany/publish-operational-infrastructure-v2.mjs publish <OPERATIONAL_DERIVER_SPECIFICATION> <OPERATIONAL_CANDIDATE> <OPERATIONAL_CANDIDATE_SIDECAR> <OPERATIONAL_DERIVER_REPORT> <OPERATIONAL_NATIVE_RECEIPT> <OPERATIONAL_VALIDATOR_REBUILD_SPEC> <OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE> <OPERATIONAL_DERIVER_OUTPUT> <OPERATIONAL_PUBLICATION_RECEIPT>
   ```

   `capture-operational-infrastructure-v2-native-receipt.mjs` mit einer über
   stdin zugelieferten nativen JSON-Zeile bleibt ausdrücklich ein
   **nicht releasefähiger Forensik-/Testpfad**. Er erzeugt ausschließlich
   `producerKind=forensic-stdin-v1`, `releaseEvidenceEligible=false`,
   `productionActivationEligible=false` und `executionProof=null`. Schreibe
   seine Ausgabe nur in einen getrennten Scratchpfad außerhalb der aktiven
   Jahresartefakte; sie darf weder `<OPERATIONAL_NATIVE_RECEIPT>` ersetzen
   noch an den Publisher, Build-Evidence, Signatur- oder Aktivierungspfad
   weitergereicht werden.

   Das kanonische create-new Native-Receipt bindet die strukturierten nativen
   Receiptfelder quer an Spezifikations-, Candidate-, Candidate-Sidecar- und
   Berichtbytes sowie an Native-Binary und Capture-Script. Der Publisher liest
   das große Sidecar nie vollständig in den Speicher, sondern hasht und kopiert
   es streamend. Im Recoverypfad wird das im Capture gebundene Native-Binary
   vor und nach der Materialisierung erneut geprüft und dem Materialisierer
   explizit übergeben; ein inzwischen abweichender Umgebungsvariablenwert darf
   kein anderes Validator-Binary einschleusen. Sein kanonisches create-new Publication-Receipt bindet
   Native-Receipt, Quelltriplet, finale Paarbytes, Release-ID,
   Operational-/Sidecar-State, Transfer-Set, Publisher-Entrypoint und
   das vollständige Ausführungsinventar aus Wrapper, Publishermodul,
   Operational-Deriver, Materialisierer, create-new-Helper,
   `operational-infrastructure-binding.mjs`, Execution-Pins-Vertrag,
   Validator-Rebuild-Bootstrap und -Verifier sowie effektivem preserved
   Validator-Binary. Native- und Publication-Receipt binden denselben
   typisiert verifizierten Rebuild-Beleg. Nur die integrierte
   Runner-Capture-Kopplung darf `releaseEvidenceEligible=true` und
   `productionActivationEligible=true` belegen.
   Build-Evidence und Buildcache müssen genau dieselben
   Repo-Bytes, den tatsächlichen Validator und den Map-Build-Commit binden.

   Ein Prozessabbruch zwischen den beiden finalen Links kann absichtlich einen
   Sidecar-only-Zustand samt Claim und Staging hinterlassen; ein Abbruch vor
   dem Claim kann verwaistes Staging hinterlassen. Das ist kein debris-freier
   Erfolg, sondern ein fail-closed Recovery-Zustand. Führe den Preflight erneut
   aus. Nur bei `recoverable-prepublication`, `recoverable-partial` oder
   `complete-cleanup-required` darf der typisierte Recovery-Befehl laufen:

   ```sh
   node tools/region-import/germany/publish-operational-infrastructure-v2.mjs recover <OPERATIONAL_DERIVER_OUTPUT> <OPERATIONAL_PUBLICATION_RECEIPT>
   ```

   Recovery entfernt ausschließlich Links und Claim/Staging mit der im Claim
   gebundenen eigenen `dev`/`ino`-Identität, dabei Operational zuerst und das
   Sidecar danach. Fremde Ersetzungen, ein ausgetauschtes/Symlink-/Junction-
   Elternverzeichnis, ein ungültiger Claim, verwaistes Staging ohne Claim oder
   eine unbesessene Teilpublikation bleiben zur manuellen Prüfung blockiert.

   Der erfolgreiche Lauf erzeugt neben Candidate, Bericht und materialisiertem
   Operational-v2-Artefakt zwingend create-new
   `<ARTEFAKTWURZEL>/operational-infrastructure-v2.movement-route-templates-v2.json`.
   Das Sidecar hat `schema=movement-route-templates-v2`, dieselbe
   InfraRelease-ID, einen eigenen kanonischen `stateHash` und bindet mit
   `operationalStateHash` exakt den Zustand des materialisierten
   Operational-v2-Artefakts sowie mit `timetableTransferSetSha256` exakt den
   `transferSetSha256` aus `$TIMETABLE_TRANSFER_OUTPUT`. Fehlendes, leeres,
   bereits vorhandenes oder abweichend gebundenes Sidecar blockiert den Lauf.

   Der Ableiter erhält die beobachtete, gepinnte E7-Gleisgeometrie unverändert
   (`realGeometry=true`) und simuliert nur fehlende betriebliche Zuordnungen
   (`simulatedOperationalAssignment=true`). Er darf ausschließlich vorhandene
   OSM-Gleiskanten verwenden; Geraden, Schätzpositionen, geografische
   Abkürzungen oder erfundene Verbindungen bleiben verboten. Wo reale
   Stellwerksrollen, Signalgrenzen oder Schutzwege nicht belegt sind, erzeugt
   die Policy intern ein deterministisches, gröberes und kapazitätsärmeres
   Sicherungsmodell. Dieses Modell ist `provenance=derived`,
   `qualityClass=B`, nie A-fähig und setzt zwingend
   `realInterlockingFactsClaimed=false`.

   Der Candidate muss gerichtete Kanten und Geometrien, Laufwege,
   Fahrstraßenvorlagen, Signalgrenzen, Knoten-/Weichenausschlüsse, getrennte
   nichtleere Fahrweg-, Durchrutschweg- und Flankenschutzmengen,
   Zugschlussfreigaben, Bahnsteigintervalle, restriktive
   Zugsicherungsprofile, Regionsgrenzen und RZÜ-Layout referenziell schließen.
   Jede inkompatible Bewegung muss mindestens eine gemeinsame oder explizit
   ausgeschlossene Ressource besitzen. Eine sichere Grobserialisierung ist
   zulässig; eine kapazitätssteigernde Vermutung ist es nicht. Sichtbare
   Kartenobjekte ohne vollständig belegbare Zuordnung werden dabei nicht
   stillschweigend zu B umetikettiert.

   Der Deutschland-Vollkorpus muss außerdem ohne vollständiges Einlesen und
   mehrfaches Parsen des Operational-JSON validiert, gehasht und inventarisiert
   werden. Solange diese streamende JSON-/Zustandshash-Validierung fehlt,
   blockieren Evidence und Inventar große Kandidaten ausdrücklich mit
   `operational-v2-streaming-validation-required`. Erhöhe nicht nur ein
   Speicherlimit; ein kleines Fixture ist kein Deutschland-Nachweis.

   Jede Laufwegversion muss aus einer lückenlosen gerichteten Kantenfolge mit
   derselben ganzzahligen Millimeterbasis und exakter E7-Geometrie bestehen;
   der Bericht muss gegen die vollständigen gepinnten Jahresdaten
   `unresolvedRequired=0`, `activationEligible=true`, die Eingabehashes und
   `candidateProduced=true` belegen. Nur dann ruft der Fünf-Argument-Runner den
   vorhandenen fail-closed Materialisierer intern auf. Dieser prüft den
   strikten JavaScript-Vertrag und den nativen Rust-Vertrag, gleicht beide
   kanonischen Hashes ab, prüft unveränderte Eingabebytes und veröffentlicht
   Candidate, Movement-Route-Templates-v2, Bericht und
   `<OPERATIONAL_DERIVER_OUTPUT>` gemeinsam mit Create-new-Semantik. Bei einem
   bereits vollständig vorhandenen nativen Triplet übernimmt stattdessen
   ausschließlich der oben benannte receiptgebundene RecoveryPublisher dieselben
   Gates für die finale Paarung und belegt den tatsächlich benutzten Sonderpfad
   mit seinem Publication-Receipt. Ein zweiter manueller Materialisierungsaufruf
   ist in beiden Fällen unzulässig. Das Ausgabedokument
   enthält exakt den statischen `OperationalInfraRelease` und keine
   Deploymenthülle; das getrennte Movement-Sidecar ist dennoch ein
   verpflichtendes signiertes Delivery- und Laufzeitartefakt.

   `activationEligible=true` ist an dieser Stelle ausschließlich das interne
   Ableitungs-Subgate. Es ersetzt weder Deliverysignatur noch produktive
   Freigabe; der unsigned Gesamtvertrag bleibt
   `productionActivationEligible=false`.

   Der historische Negativvertrag bleibt ausschließlich als Fail-closed-Test
   erhalten: `mode=readiness-only` wird mit exakt vier Argumenten ausgeführt,
   endet mit **Status 2**, schreibt nur einen Readiness-Bericht mit
   `candidateProduced=false` und `unresolvedRequired=10` und erzeugt weder
   Candidate noch Output. Er ist nicht der Jahresableiter und darf den neuen
   konservativen Vertrag nicht ersetzen.

   Erzeuge erst aus diesem nativen Ergebnis zusätzlich das Closure-Receipt mit
   dem eingecheckten create-new-Jahresvertrag:

   ```sh
   node tools/region-import/germany/run-synthetic-operational-closure.mjs <SYNTHETIC_CLOSURE_SPEC> <ARTEFAKTWURZEL>/synthetic-operational-closure-receipt.json
   ```

   Das Schema `zugfolge-synthetic-operational-closure-receipt/v2` bindet die
   eingecheckte Policy und Jahresspezifikation, die sechs normalisierten
   Kartenlayer sowie die vier Pflichtinputs `gtfs-snapshot`,
   `timetable-route-report`, `timetable-routes` und
   `timetable-transfer-demands`, Candidate,
   materialisiertes Operational-v2-Artefakt, natives Streaming-Receipt und
   den nativen Ableitungsbericht samt kanonischem Zustand per SHA-256. Coverage,
   Records und Native-Hashes werden ausschließlich daraus abgeleitet und sind
   keine CLI-Parameter. Die `timetableRouteEvidence` muss zusätzlich die drei
   Datei-SHAs und Bytezahlen, Snapshot-/Archivhash, CC-BY-4.0-Lizenz, vollständige
   ausgewählte Segmentabdeckung sowie
   `externalOperationalNetworkProvenance=false` spiegeln. Der Beleg muss exakt `unresolvedRequired=0`,
   `ordinaryAssumptionsPromoted=0`, `mapClassCReclassified=0`,
   `qualityClass=B`, `provenance=derived`,
   `realGeometry=true`, `simulatedOperationalAssignment=true` und
   `realInterlockingFactsClaimed=false` ausweisen. Weil das Operational-v2-
   Artefakt die synthetischen Betriebsobjekte tatsächlich enthält und sie mit
   beobachteten Objekten in denselben Laufzeit-Collections führt, muss der
   Beleg außerdem exakt `syntheticOperationalDetailsShipped=true`,
   `objectLevelProvenanceShipped=false` und
   `observedAndSyntheticObjectsShareRuntimeCollections=true` ausweisen. Ohne
   bytegeprüftes Receipt oder bei bereits vorhandenem Ziel bleiben gewöhnliche
   Annahmen Klasse C und blockieren den Release; Überschreiben ist unzulässig.

   Erzeuge danach den getrennten Operational-Qualitätsbericht. Er bindet den
   unveränderten sichtbaren Kartenbericht per SHA-256, lässt dessen C-Objekte
   sichtbar und qualifiziert ausschließlich den geschlossenen Operational-v2-
   Graphen:

   ```sh
   node tools/region-import/germany/run-operational-quality-report.mjs <OPERATIONAL_QUALITY_SPEC> <ARTEFAKTWURZEL>/operational-infrastructure-quality.json
   ```

   Der Bericht muss
   `schema=zugfolge-operational-infrastructure-quality-report/v1`, operatives
   C=0, `unresolvedRequired=0`, `mapClassCReclassified=false` und
   `mapObjectsRemoved=false` ausweisen. `operationalQualityEligible=true`
   bedeutet nur, dass dieses Qualitätsgate bestanden ist; `signatureImplied`
   und `activationImplied` bleiben `false`.
6. Validiere das statische v2-Artefakt vor dem Manifestbau mit demselben
   nativen Rust-Vertrag, den die Operational-v2-Runtime beim Weltstart nutzt.
   Releasekennung, Kanten, Ressourcen, Fahrstraßen, Laufwege, Geometrien,
   Bahnsteige, Regionsgrenzen und RZÜ-Layout müssen vollständig und
   referenziell geschlossen sein; unbekannte Felder oder weltbezogene Inhalte
   blockieren den Kandidaten.
7. Aktualisiere und prüfe `<ANNUAL_ARTIFACT_SPEC>` als bindenden Jahresvertrag
   mit `schema=zugfolge-infra-release-artifact-spec/v2`. Er muss genau je einen
   Descriptor für `operational-infrastructure-v2`,
   `movement-route-templates-v2` und `timetable-transfer-demands-v2`
   enthalten. Für diese drei erstklassigen Operational-v2-Artefakte gelten
   exakt:

   - Operational: `id=<OPERATIONAL_ARTIFACT_ID>`,
     `kind=operational-infrastructure-v2`,
     `infraReleaseId=<INFRARELEASE_ID>`,
     `sourceFile=<ARTEFAKTWURZEL>/operational-infrastructure-v2.json` und
     `file=operational-infrastructure-v2.json`; der Descriptor enthält
     ausschließlich `id`, `kind`, `infraReleaseId`, `sourceFile` und `file`.
   - Movement: `kind=movement-route-templates-v2`,
     `sourceFile=<ARTEFAKTWURZEL>/operational-infrastructure-v2.movement-route-templates-v2.json`
     und
     `file=operational-infrastructure-v2.movement-route-templates-v2.json`;
     der Descriptor enthält ausschließlich `id`, `kind`, `sourceFile` und
     `file`.
   - Transfers: `kind=timetable-transfer-demands-v2`,
     `sourceFile=<ARTEFAKTWURZEL>/timetable-routes-v2.transfer-demands-v2.json`
     und `file=timetable-routes-v2.transfer-demands-v2.json`; der Descriptor
     enthält ausschließlich `id`, `kind`, `sourceFile` und `file`.

   Jeder `sourceFile`-Pfad muss relativ zur Repository-Wurzel sein, darunter
   bleiben und exakt zum aktuellen Jahreskandidaten auflösen. Keine der drei
   Dateien darf aus einem Vorjahresrelease, einem Candidate-Pfad oder einer
   Deploymenthülle stammen. `bytes`, `sha256`, `stateHash`,
   `operationalStateHash`, `timetableTransferSetSha256` oder
   `transferSetSha256` dürfen niemals manuell in einen Descriptor geschrieben
   werden. Erzeuge die Dateibindungen ausschließlich über die typisierte
   Inventarpipeline:

   ```sh
   node tools/region-import/germany/run-release-artifacts.mjs <ANNUAL_ARTIFACT_SPEC> . <RELEASE_ARTIFACT_INVENTORY>
   ```

   Das erzeugte `zugfolge-infra-release-artifacts/v2`-Inventar muss alle drei
   Arten genau einmal mit ihren realen `id`, `kind`, `file`, `bytes` und
   `sha256` transportieren. Für `<OPERATIONAL_ARTIFACT_ID>` kommen unverändert
   `infraReleaseId` und `stateHash` hinzu. Sein `sha256` hasht die
   materialisierten kanonischen Dateibytes, niemals die Candidate-Bytes oder
   die vollständige weltgebundene Initialisierung; sein `stateHash` ist exakt
   `alphaHash("operational-infrastructure-v2", OperationalInfraRelease)`.
   Der spätere Build-Evidence-v3-Prüfer muss zusätzlich aus den realen
   Sidecar-Inhalten belegen, dass Movement-`operationalStateHash` diesem
   Operational-`stateHash` und Movement-`timetableTransferSetSha256` dem
   Transfer-`transferSetSha256` entspricht. Falls Pipeline oder v3-Evidence
   diese Bindungen nicht erzeugen, stoppe den Lauf, erweitere Pipeline und
   Positiv-/Negativtests und baue neu. Patche weder Spezifikation noch
   erzeugtes Inventar, Wrapper, Deliverymanifest oder Evidence mit manuell
   berechneten Hashes.
8. Baue den öffentlichen InfraRelease-Wrapper mit dem Jahresvertrag im
   autoritativen Rust-Compiler. Sein Ziel ist ausschließlich
   `<ARTEFAKTWURZEL>/map-release-free-v2/public/infra-release.json`, nicht die
   für Delivery reservierte Datei `public/release.json`:

   ```sh
   node tools/region-import/germany/build-germany-release.mjs manifest <ANNUAL_RELEASE_CONFIG> tools/region-import/germany/source-catalog.json tools/guards/quellenregister.json <SOURCE_CAPTURE_MANIFEST> <RELEASE_ARTIFACT_INVENTORY> <ARTEFAKTWURZEL>/map-release-free-v2/public/static-map-quality-v2.json <ARTEFAKTWURZEL>/operational-infrastructure-quality.json <ARTEFAKTWURZEL>/map-release-free-v2/public/infra-release.json
   ```

   Übergib dabei `<RELEASE_ARTIFACT_INVENTORY>` unverändert als dessen
   `ARTIFACTS`-Argument. `STATIC_QUALITY` ist der ausgelieferte
   `zugfolge-static-map-quality/v2`-Beleg mit den unveränderten sichtbaren
   Kartenklassen; `OPERATIONAL_QUALITY` ist der getrennte
   `zugfolge-operational-infrastructure-quality-report/v1`-Closure-Beleg. Eine
   manuell nachgebaute Artefaktliste oder das Weglassen eines der beiden
   Qualitätsartefakte ist unzulässig.
   Suche anschließend
   rekursiv nach verbotenen internen
   Evidenzkennungen. Jeder Treffer, ein fehlendes oder mehrfaches
   `operational-infrastructure-v2`-, `movement-route-templates-v2`- oder
   `timetable-transfer-demands-v2`-Artefakt und jede Abweichung von deren
   erwarteter Byte-, Release-, Transfer- oder kanonischer Zustandsbindung
   blockieren den Release.

   Alle aktuellen Ausgabeziele dieses Jahreslaufs sind create-new. Das gilt
   auch dann, wenn ihr Inhalt gegenüber dem Vorjahr gleich wäre. Vor jedem
   Builder müssen alle seine Ziele fehlen; ein vorhandenes Ziel wird weder
   gelöscht noch ersetzt, sondern erzwingt einen neuen Kandidatenpfad oder eine
   neue Release-ID. Binde die gepinnte Basemap-Stylevorlage aus dem
   Source-Capture, die lokale PMTiles-URL und den öffentlichen Assetwurzelpfad
   aus `<MAP_PACKAGE_PLAN>` unverändert an `$BASEMAP_UPSTREAM_STYLE`,
   `$BASEMAP_PMTILES_URL` und `$MAP_PUBLIC_ASSET_ROOT`. Materialisiere den
   Offline-Stil atomar create-new:

   ```sh
   node tools/tiles/build-offline-basemap-style.mjs "$BASEMAP_UPSTREAM_STYLE" <ARTEFAKTWURZEL>/map-release-free-v2/style.json <INFRARELEASE_ID> "$BASEMAP_PMTILES_URL" "$MAP_PUBLIC_ASSET_ROOT"
   ```

   Der Stil muss MapLibre v8, vollständig selbst gehostet und releasegebunden
   sein. Externe Laufzeit-URLs, `latest`, eine fremde Release-ID oder ein
   bereits vorhandenes Ziel blockieren den Lauf. Dasselbe create-new-Gate gilt
   für PMTiles, ReadModel, Quality, Sources, Captures, Wrapper, Inventare und
   alle Deliverydateien; nur der oben geprüfte
   Cross-Release-Materialisierer darf ausdrücklich deklarierte historische
   Bytes in den neuen, vorher leeren Zielbaum übernehmen.

   Materialisiere anschließend die übrigen öffentlichen Kartenrollen getrennt.
   Der statische Quellenbeleg muss unter
   `<ARTEFAKTWURZEL>/map-release-free-v2/public/static-map-sources-v2.json`
   liegen. Der Karten-Capture wird nach fertigen PMTiles-Bytes als
   `<ARTEFAKTWURZEL>/map-release-free-v2/public/map-source-capture.json`
   erzeugt; `build-map-release.mjs` schreibt den daraus abgeleiteten Wrapper
   nach
   `<ARTEFAKTWURZEL>/map-release-free-v2/public/map-release.json`.

   Erzeuge den unsigned Deliveryvertrag mit dem exakten Karten-Build-Commit in
   `<ARTEFAKTWURZEL>/map-release-free-v2/delivery-unsigned/`:

   ```sh
   node tools/tiles/build-map-delivery-release.mjs <MAP_PACKAGE_PLAN> . <ARTEFAKTWURZEL>/map-release-free-v2/public/infra-release.json <ARTEFAKTWURZEL>/map-release-free-v2/public/map-release.json <ARTEFAKTWURZEL>/map-release-free-v2/public/read-model.sqlite.report.json "$MAP_BUILD_COMMIT" <ARTEFAKTWURZEL>/map-release-free-v2/delivery-unsigned
   ```

   Damit sind dessen
   Paketquellen exakt `delivery-unsigned/release.json` und
   `delivery-unsigned/sources.json`. Sein Inventar muss Operational-v2,
   Movement-Route-Templates-v2 und Timetable-Transfer-Demands-v2 jeweils genau
   einmal mit den kanonischen Installationspfaden und den Bindungen aus
   Qualitätsbericht und InfraRelease-Inventar enthalten. Die Datei
   `<ARTEFAKTWURZEL>/map-release-free-v2/public/release.json` ist ausschließlich
   dem später genehmigten signierten Deliveryvertrag vorbehalten und bleibt im
   unsigned Lauf absent.

   Baue die Semantik-PMTiles ausschließlich über den manifestverifizierten
   GDAL-Launcher. Ein frei über `PATH` gefundenes `ogr2ogr`, eine einzelne EXE
   ohne Runtime-Manifest oder eine Runtime mit fehlender, zusätzlicher oder
   abweichender Datei ist unzulässig:

   ```sh
   node tools/tiles/build-gdal-semantic-pmtiles.mjs <SEMANTIC_TILE_INPUTS> <SEMANTIC_TILE_INPUT_ROOT> <SEMANTIC_PMTILES_OUTPUT> <GDAL_RUNTIME_MANIFEST> .
   ```

   Binde nach allen Quellen-, Sidecar- und unsigned Ausgaben den für
   `<INFRARELEASE_ID>` eingecheckten
   `zugfolge-map-build-cache-inventory-plan/v1` an `$BUILD_CACHE_PLAN` und sein
   vorher nicht vorhandenes, in `$BUILD_EVIDENCE_SPEC` referenziertes Ziel an
   `$BUILD_CACHE_INVENTORY`. Der Plan muss beide Operational-v2-Sidecars mit
   ihren aktuellen Quell- und unveränderlichen Cachepfaden enthalten. Da der
   sichere Cross-Release-Materialisierer deklarierte Wiederverwendungsbytes
   bereits in ihre aktuellen Zielpfade überführt hat, baut der Jahreslauf das
   vollständige Inventar aus genau einer Repository-Wurzel:

   ```sh
   node tools/tiles/map-build-cache-inventory-cli.mjs build <INFRARELEASE_ID> . "$BUILD_CACHE_PLAN" "$BUILD_CACHE_INVENTORY"
   ```

   Das Inventar ist atomar create-new, vollständig, streamend gehasht und
   enthält weder Symlinks/Junctions noch zusätzliche Dateien. Ein manuelles
   Overlay für nicht materialisierte Vorjahrespfade ist im neuen Lauf
   unzulässig. `$BUILD_EVIDENCE_SPEC` muss exakt dieses Inventar als seine eine
   `build-cache-inventory`-Eingabe binden.
9. Führe Unit-, Golden-Master-, Determinismus-, Rechte-, Lizenz-,
   Konfliktinvarianten-, Karten- und unabhängige Holdout-Tests aus. Vergleiche
   Qualitätslängen und Laufzeit/RAM/PMTiles-Größe mit dem Vorjahresrelease und
   erkläre jede wesentliche Abweichung.
10. Führe zusätzlich die Operational-v2-, LiveMap- und RZÜ-Abnahme aus dem
    folgenden Abschnitt vollständig aus. Historische v1-Waypoint-,
    Kartenestimate-, 24-Stunden-Wiederholungs- und synthetische Lastbelege sind
    kein v2-Nachweis.
11. Lege Kandidat, tatsächliche Hashes, Berichte und Reviewliste zur
    namentlichen Releasefreigabe vor. Signiere erst, wenn sämtliche
    v2-Cutover-Gates grün sind. Dieser kostenlose Clean-v2-Lauf endet ohne eine
    solche Freigabe beim unsigned Kandidaten und ruft keinen Signer auf. Ein
    bereits signierter InfraRelease wird nicht nachträglich erweitert, sondern
    bleibt bytegleich unverändert; jeder geänderte v2-Kandidat erhält einen
    neuen Releasebezeichner, einen neuen Delivery-Key und eine neue Signatur.
    Markiere M14.2 nur dann erledigt, wenn der vollständige Deutschlandlauf und
    nicht lediglich eine Fixture bestanden hat und alle verbleibenden
    Abnahmebelege erfüllt sind.

    Nach dem geschützten Merge, beiden erfolgreichen Authority-Phasen, dem
    vollständigen unsigned Preflight und der namentlichen
    Delivery-Signaturfreigabe muss `$MAP_BUILD_COMMIT` exakt der unveränderte
    geschützte `main`-Commit mit der bereits additiv registrierten öffentlichen
    PEM-Datei sein. Signiere erst dann Delivery-v2 create-new am reservierten
    öffentlichen Ziel:

    ```sh
    node tools/tiles/sign-map-delivery-release.mjs <MAP_PACKAGE_PLAN> . "$DELIVERY_PRIVATE_KEY" "$DELIVERY_KEY_ID" "$MAP_BUILD_COMMIT" <ARTEFAKTWURZEL>/map-release-free-v2/public/release.json
    ```

    Prüfe die erzeugte Ed25519-Signatur gegen die bereits im selben geschützten
    Commit registrierte öffentliche PEM-Datei und anschließend gegen den
    vollständigen additiven Keyring samt Scope. Jede Abweichung zwischen
    privatem Signierschlüssel, öffentlicher PEM-Datei, Keyring oder Scope
    blockiert den Lauf.

    Leite erst nach dieser additiven Registrierung den Signed-Paketplan
    ausschließlich reproduzierbar ab; kopiere oder editiere den Jahresplan
    nicht von Hand:

    ```sh
    node tools/tiles/signed-map-package-plan-cli.mjs <MAP_PACKAGE_PLAN> . ops/keys/trusted-delivery-keys.json ops/keys/trusted-delivery-key-scopes.json "$MAP_BUILD_COMMIT" <ARTEFAKTWURZEL>/map-release-free-v2/signed-package-plan.json
    ```

    Der Generator muss den Jahresplan deterministisch zu
    `zugfolge-map-package-spec/v2` expandieren und jede einzelne expandierte
    Paketdatei einschließlich PMTiles, ReadModel, Quality, Style, Sources,
    Glyphen und Sprites mit den aktuell inventarisierten Bytes und SHA-256
    pinnen. Gegenüber dieser vollständig gepinnten unsigned Spezifikation darf
    er fachlich ausschließlich die Releasequelle von
    `delivery-unsigned/release.json` auf `public/release.json` und deren
    Byte-SHA-Bindung auf die realen signierten Bytes umstellen;
    `zugfolge-map-runtime/v2`, Paketidentität, Installationspfade, Rollen und
    alle übrigen Felder bleiben unverändert. Jede weitere Abweichung ist ein
    Abbruch. Ein integriertes Operational-v2-Paket aus einer unvollständig
    gepinnten Spezifikation ist ebenfalls zwingend abzulehnen. Der Generator
    und die späteren Paket-/Aktivierungs-Preflights müssen die Signatur jeweils
    gegen den öffentlichen Keyring prüfen.

    Halte die drei Ergebnisse ausdrücklich auseinander: Paket-`verify` beweist
    die Integrität der inventarisierten Bytes, die erfolgreiche Prüfung von
    Signatur-Key-ID und Ed25519-Signatur gegen den additiven Keyring beweist das
    Vertrauen in den Delivery-Signer, und erst ein gesonderter, erfolgreicher
    Aktivierungs-Preflight samt Freigabe darf eine Zielumgebung umschalten. Ein
    eingecheckter Public Key, ein gültiger Manifesthash oder eine lokale
    Installation allein ist niemals ein Aktivierungsbeleg.
    Binde anschließend in der Jahres-Evidence nicht den unsigned Basisplan als
    Kandidaten, sondern den erzeugten `signed-package-plan.json` über den
    verpflichtenden `candidatePackage`-Vertrag. Dieser muss Paketversion,
    signierte `public/release.json`-Bytes, Release-Hash, Signatur-Key-ID und den
    vollständigen additiven `ops/keys/trusted-delivery-keys.json` belegen. Die
    dort benannten bisherigen Vertrauensanker dürfen nicht entfernt oder durch
    den neuen Karten-Key ersetzt werden. Erzeuge und prüfe nun erst den
    unveränderlichen Build-Evidence-v3-Beleg aus den tatsächlichen Bytes und
    den vollständigen Commit-IDs des Semantikexports, Kartenbuilds und des
    tatsächlich ausgeführten Operational-v2-Validators:

    ```sh
    node tools/tiles/map-release-build-evidence-cli.mjs build "$BUILD_EVIDENCE_SPEC" . "$BUILD_EVIDENCE_OUTPUT" "$SEMANTIC_EXPORT_COMMIT" "$MAP_BUILD_COMMIT" "$OPERATIONAL_VALIDATOR_BUILD_COMMIT"
    node tools/tiles/map-release-build-evidence-cli.mjs verify "$BUILD_EVIDENCE_OUTPUT" .
    ```

    Build und Verify müssen die Ed25519-Signatur erneut gegen den additiven
    öffentlichen Keyring prüfen; ein privater Schlüssel ist keine
    Evidence-Eingabe. Der Beleg muss
    `schema=zugfolge-map-release-build-evidence/v3` tragen, genau die neun
    vorab vereinbarten Ausgaben führen und Operational-v2, beide Sidecars,
    InfraRelease-Inventar, signiertes Delivery-v2-Inventar und Signed-Paketplan
    auf identische Dateibytes, Release-ID, Operational-State-Hash und
    Transfer-Set-Hash schließen. Evidence-Ausgabe und alle vorgelagerten
    Signatur-/Plan-Ziele sind create-new; kein Hash oder Status wird vor einem
    tatsächlich erfolgreichen Build eingetragen.
12. Erzeuge kein integriertes Operational-v2-Paket direkt aus dem ungepinnten
   Jahresplan oder dem unsigned Deliveryvertrag. Die unsigned Dateien
   `map-release-free-v2/delivery-unsigned/release.json` und
   `map-release-free-v2/delivery-unsigned/sources.json` sind ausschließlich
   Eingaben der vollständigen Pre-Sign-Prüfung. Ohne namentliche
   Signaturfreigabe endet der integrierte Lauf dort ohne Pack, Verify, Install
   oder Game-Staging.

   Erzeuge das transportneutrale integrierte Paket erst nach freigegebener
   Signatur und erfolgreich verifiziertem Build-Evidence-v3 ausschließlich aus
   dem vollständig expandierten und bytegenau gepinnten
   `signed-package-plan.json`:

   ```sh
   node tools/tiles/map-package-cli.mjs pack <ARTEFAKTWURZEL>/map-release-free-v2/signed-package-plan.json <ARTEFAKTWURZEL>/map-package-signed .
   node tools/tiles/map-package-cli.mjs verify <ARTEFAKTWURZEL>/map-package-signed
   node tools/tiles/map-package-cli.mjs install <ARTEFAKTWURZEL>/map-package-signed <ARTEFAKTWURZEL>/map-package-installed-signed
   ```

   Prüfe das Paket vollständig, installiere es in ein neues versioniertes
   Testziel und protokolliere Manifest-Hash, Teilezahl, Gesamtbytezahl und
   Installationspfad. Trage keinen Hash und keinen Pack-, Verify- oder
   Installstatus ein, bevor der jeweilige Schritt tatsächlich beendet ist.
   Übergib anschließend ausschließlich dieses signierte, geprüfte und frisch
   installierte Paket über den vorgesehenen Odoo-Jahresimport in das getrennte
   Game-Staging, sofern die Zielumgebung verfügbar ist. Es darf weiterhin
   keinen produktiven Übernahmeantrag ohne gesonderte Aktivierungsfreigabe
   erzeugen.

   Signaturfreigabe, lokales Pack/Verify/Install, Odoo-Import, Game-Staging und
   Produktionsaktivierung sind getrennte Gates. Für STRATO ist der Zielhost
   `h3076743.stratoserver.net`. Ermittle dort zunächst ausschließlich lesend
   den aktiven Pointer, die installierten Releases, den exakten Source-Commit,
   die Image-Digests und den ausführbaren Rollbackstand; prüfe vor jeder
   Verbindung den bestätigten Hostschlüssel über den vorgesehenen sicheren
   Inventarweg. Eine Trust-Registry-ID oder ein Buildvorgänger darf nicht als
   installierter Rollbackstand angenommen werden.

   Vor jeder zustandsändernden Installation oder Aktivierung ist unmittelbar
   davor eine neue ausdrückliche Freigabe einzuholen. Sie muss Zielhost, vollen
   40-stelligen Commit, `<INFRARELEASE_ID>`, Paketmanifest-SHA und die
   konkret freigegebene Aktion nennen. Vor der ersten Mutation müssen das neue,
   bisher fehlende `.5`-Installationsverzeichnis, der unverändert aktive
   Vorgängerpointer und vollständiges Rollbackmaterial feststehen. Ein
   ausführbarer Rückweg verlangt das bytegenau installierte Vorgängerpaket,
   sein signiertes Runtime-Rollback-Tuple, gepinnte Image-Digests sowie
   bestandene Datenbank- und Keycloak-Restore-Belege; der bloß beibehaltene
   `.4`-Public-Key genügt nicht. Ohne diese Serverfreigabe und Rollbackbelege
   endet der Lauf nach den lokalen beziehungsweise Staging-Belegen mit
   `nicht installiert/aktiviert`; eine frühere Release- oder
   Signaturfreigabe autorisiert keine Servermutation.

Operational-v2-, LiveMap- und RZÜ-Abnahme:

1. Erzeuge nach dem statischen Release eine getrennte lokale
   Test-Deploymenthülle mit einem vollständigen
   `zugfolge-operational-simulation-initialize/v2`. Sie bindet eine konkrete
   Testwelt, Region, Weltepoche, Fahrzeugtypen, weltgebundene Fahrzeuge,
   Formationen, Züge und das unveränderte statische
   `OperationalInfraRelease`; sie wird weder Bestandteil noch Artefakt des
   `InfraRelease`. Ohne gesonderte namentliche Freigabe bleibt auch diese Hülle
   unsigned und nicht produktiv aktivierbar. Starte diese Testwelt
   ausschließlich über die native
   Operational-v2-ABI. Der Start muss ein `operational-world/v2` mit Revision
   und Publishersequenz `0`, reproduzierbarem vollständigem Zustandshash sowie
   je einer LiveMap- und RZÜ-Projektion desselben Commitstands erzeugen. Eine
   fehlende native ABI oder ein JavaScript-Ersatz ist ein Abbruch, kein Skip.
2. Beweise an realen Klasse-A-/B-Ausschnitten, soweit Klasse A im Jahresrelease
   vorhanden ist, dass Zugspitze, Zugschluss, belegte Kantenintervalle und
   Blöcke, Fahrberechtigungsende, analytischer Bewegungsabschnitt,
   Fahrstraßenlocks und Signalzustände aus demselben Zustand stammen. Abgesehen
   vom Sichttyp `live-map`/`rzue` müssen Welt, Region, InfraRelease, Commit,
   Simulationszeit, Züge, Locks und Signale beider Projektionen gleich sein.
   RZÜ darf keine zweite Simulation oder erfundene Stellwerkslage besitzen.
3. Prüfe den produktiven Workerpfad: welt-/regionsgebundener Single-Writer,
   idempotente Befehle, optimistische Prüfung von Revision, State-Hash und
   Publishersequenz, atomarer Batch-Rollback und Persistenz-Commit vor Fanout.
   Ein Fanoutfehler darf den committed Zustand nicht zurückrollen und muss
   durch Restore/Neuprojektion ohne Doppelanwendung aufholbar sein.
4. Publiziere je Commit einen atomaren Regionsframe mit sämtlichen v2-Zügen.
   Snapshot und lückenlose Deltas tragen dieselbe Welt, Region, InfraRelease-ID,
   Commitsequenz und Simulationszeit; die nächste Publishersequenz ist exakt
   `+1`. Eine Lücke, ein fremder Commit oder ein gemischtes Teilbild erzwingt
   Freeze und vollständigen Snapshot-Reset.
5. Prüfe den gemeinsamen Clientvertrag: Der Heartbeat beträgt fünf Sekunden;
   beim produktiven 60-Sekunden-Scheduler wird ein Regionszustand nach 75
   Sekunden stale. Bis `validUntilMs` darf ausschließlich der vom Server
   autorisierte analytische Abschnitt ausgewertet werden; danach frieren
   LiveMap und RZÜ ohne Extrapolation oder Geometriesprung ein.
6. Führe negative Tests für fehlende, doppelte, manipulierte, weltbezogene oder
   nicht releasegebundene statische v2-Artefakte, eine nicht zum Release
   passende Deploymenthülle, falsche Welt/Region/Weltepoche, fremde
   Laufwege/Ressourcen/Fahrzeuge/Formationen/Züge, operative v1-Schemas und
   -Befehle, `AddDelay`, partielle Regionsframes, Sequenzlücken, Stale-Grenzen
   und getrennte LiveMap-/RZÜ-Zustände aus. Jeder Fall muss geschlossen
   scheitern.
7. Qualifiziere Fahrplanwiederholung, mehrtägige Materialisierung,
   Periodenwechsel und deterministische Bereinigung/Retirement vollständig
   unter v2. Replay und Restore müssen denselben `operational-world/v2`-Hash
   ergeben. Ein früherer v1-Tageslauf darf dieses Gate nicht ersetzen.
8. Erbringe außerdem sämtliche Invarianten-, Rangier-, Störungs-, Plattform-,
   Regions-, Last-, Restore-, Fail-safe- und Aktivierungs-/Rollbacknachweise
   aus Abschnitt 10 von `docs/betriebsengine.md`. Ein Rollback betrifft nur
   einen noch nicht endgültig aktivierten statischen Kandidaten oder das
   vollständige v2-Deployment. Nach dem harten Cutover gibt es keinen
   produktiven v1-Fallback und niemals eine Übersetzung dynamischer Zustände.
   Schließe außerdem die noch offenen produktiven Gates aus
   `docs/betriebsengine-lastnachweis.md`: 5.000 Ereignisse/s über zehn Minuten
   mit PostgreSQL-Persistenz und Stream; 4.000–5.000 gleichzeitig fahrende
   Züge und 120.000–180.000 materialisierte Läufe in einem gemeinsamen
   Weltzustand; Queue-p99, Commit-zu-Client-p99 und CPU im Normalbetrieb sowie
   bei 50-fachem Catch-up; 200 gefilterte Clientabonnements und reale
   Netzwerkbandbreite auf dem Zielnode. Bis diese Nachweise mit dem
   produktiven v2-Single-Writer und dem qualifizierten Deutschlandrelease
   vorliegen, bleibt das Cutover-Gate geschlossen; Kern- oder synthetische
   M4-Benchmarks ersetzen sie nicht.

Liefere am Ende eine knappe Tabelle mit Quelle/Version/Hash, A-/B-Länge,
offenen Ursachen, Teststatus, Artefaktgrößen, Änderungen zum Vorjahr und
Signaturstatus. Weise `operational-infrastructure-v2.json` mit
`infraReleaseId`, Byte-SHA-256 und kanonischem `stateHash` gesondert aus.
Weise daneben `movement-route-templates-v2` mit Byte-SHA-256, `stateHash` und
`operationalStateHash` sowie `timetable-transfer-demands-v2` mit Byte-SHA-256,
DailyPlan-Hash und `transferSetSha256` aus und bestätige die gekreuzte
Hashbindung. Nenne Cross-Release-Reuse-Receipt und Zahl der ausschließlich
create-new übernommenen Dateien oder ausdrücklich „keine Wiederverwendung“.
Dokumentiere Build-Evidence-Schema, -Hash und Verify-Status sowie die additive
Trust-Änderung mit neuem Key, vollständig beibehaltenen Altankern und
Signaturprüfung, ohne private Schlüsselpfade oder Schlüsselmaterial offenzulegen.
Dokumentiere die getrennte Test-Deploymenthülle mit Signaturstatus, Welt,
Region, Weltepoche, Zugzahl und nativer Initialisierung daneben, aber niemals als
InfraRelease-Artefakt. Ergänze LiveMap-/RZÜ-Commitgleichheit,
Sequenz-/Stale-/Freeze-, Replay-/Restore-, Wiederholungs-/Retirement- und
operativen v1-Negativstatus sowie Paketmanifest-Hash, Teilezahl,
Verify-/Installstatus,
Odoo-/Game-Stagingstatus und den ausdrücklich getrennten Aktivierungsstatus.
Nenne für Produktion zusätzlich den exakten Commit- und Paketmanifeststand
sowie den Status der gesonderten Serverfreigabe; ohne Freigabe lautet er
„nicht installiert/aktiviert“.
Verlinke alle internen Laufbelege, aber keine APN-Rohdateien.

---
