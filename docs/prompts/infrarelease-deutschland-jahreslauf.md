# Fester Arbeits-Prompt: Deutschland-InfraRelease zum Fahrplanwechsel

Diesen Prompt einmal jährlich in einem neuen, protokollierten Codex-Task
verwenden. `<FAHRPLANJAHR>`, `<STICHTAG_UTC>`, `<QUELLWURZEL>`,
`<ARTEFAKTWURZEL>`, `<INFRARELEASE_ID>`, `<OPERATIONAL_CANDIDATE>`,
`<ANNUAL_RELEASE_CONFIG>`, `<ANNUAL_ARTIFACT_SPEC>`,
`<OPERATIONAL_ARTIFACT_ID>`, `<RELEASE_ARTIFACT_INVENTORY>`,
`<TIMETABLE_ROUTE_SPEC>`, `<SYNTHETIC_CLOSURE_SPEC>`,
`<OPERATIONAL_QUALITY_SPEC>`, `<SOURCE_CAPTURE_MANIFEST>` und
`<MAP_PACKAGE_PLAN>` müssen vor dem Start konkret ersetzt werden; kein
Platzhalter darf in einem Kandidaten verbleiben.
`<OPERATIONAL_CANDIDATE>` ist der Pfad zu einem fachlich aus den gepinnten
Deutschlanddaten abgeleiteten, weltfreien `OperationalInfraRelease`, nicht zu
einer Deploymenthülle. `<ANNUAL_RELEASE_CONFIG>` ist der eingecheckte
Jahresvertrag für genau `<INFRARELEASE_ID>` und `<FAHRPLANJAHR>`; die generische
Beispielkonfiguration darf ihn nicht ersetzen. Führe alle Befehle aus dem
Repository-Wurzelverzeichnis aus; `<ARTEFAKTWURZEL>` und die `sourceFile`-Pfade
der Jahresspezifikation müssen darunter liegen.

Validiere vor dem ersten Build alle aktiven Jahresbindungen gemeinsam und
brich bei jeder Abweichung ab:

- `<TIMETABLE_ROUTE_SPEC>` hat das Schema
  `zugfolge-germany-timetable-route-compiler/v3`, bindet
  `infraReleaseId=<INFRARELEASE_ID>` und nennt mit `output` und `report` zwei
  verschiedene create-new-Ziele unter `<ARTEFAKTWURZEL>`. Binde diese beiden
  Werte unverändert an `$TIMETABLE_ROUTE_OUTPUT` und
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

   Der create-new-Lauf muss `$TIMETABLE_ROUTE_OUTPUT` und
   `$TIMETABLE_ROUTE_REPORT` gemeinsam erzeugen. Der Bericht muss Policy
   `synthetic-operational-b/v2`,
   den Snapshot-Dateihash und internen `snapshotHash`, Archiv-SHA,
   `sourceLicense=CC-BY-4.0`, alle ausgewählten Segmente 1:1 und eine bytegleiche
   `routeSetSha256` binden. Er muss `realGeometry=true`,
   `simulatedOperationalAssignment=true`, `realInterlockingFactsClaimed=false`,
   `operationalNetworkUsed=false`, `gtfsShapeGeometryUsed=false` und
   `inventedGeometryUsed=false` ausweisen. Same-Stop-Übergänge sind nur als
   explizite Nullbewegung zulässig; sie dürfen weder eine erfundene Geometrie
   noch einen unvollständigen Fahrweg erzeugen.

   Lies anschließend den strikt validierten Subvertrag
   `pipeline.operationalDeriver` aus `<ANNUAL_RELEASE_CONFIG>`. Sein
   `entrypoint` muss exakt
   `tools/region-import/germany/run-operational-infrastructure-v2.mjs` sein;
   seine `specification` muss
   `schema=zugfolge-germany-operational-infrastructure-derivation/v2`,
   `mode=deterministic-conservative-v1`, denselben `<INFRARELEASE_ID>` und die
   Policy `synthetic-operational-b/v2` binden. Die sechs normalisierten
   Kartenlayer `tracks`, `platforms`, `switches`, `signals`, `blocks` und
   `conflictResources` müssen aus demselben Jahresstand stammen. Zusätzlich
   muss `layers.timetableRoutes` exakt den aus `<TIMETABLE_ROUTE_SPEC>`
   validierten, gepinnten Pfad `$TIMETABLE_ROUTE_OUTPUT` bezeichnen;
   `null`, ein fehlender oder ein leerer Pfad ist für einen aktivierbaren
   Jahresrelease unzulässig. `candidate` muss exakt
   `<OPERATIONAL_CANDIDATE>` entsprechen und `output` muss exakt
   `<ARTEFAKTWURZEL>/operational-infrastructure-v2.json` bezeichnen. Binde
   `specification`, `report` und `output` unverändert aus diesem Subvertrag an
   `$OPERATIONAL_DERIVER_SPECIFICATION`, `$OPERATIONAL_DERIVER_REPORT` und
   `$OPERATIONAL_DERIVER_OUTPUT` und führe den echten Fünf-Argument-CLI-Vertrag
   aus. Baue dafür zuerst das optimierte native Binary und setze den
   ausführbaren Pfad explizit; Deutschland-Candidate und Closure dürfen nicht
   versehentlich mehrfach über `cargo run` im Debugprofil validiert werden:

   ```sh
   cargo build --locked --release -p zugfolge-infra --bin zugfolge-infra-release
   export ZUGFOLGE_INFRA_RELEASE_VALIDATOR_PATH="$PWD/target/release/zugfolge-infra-release"
   node tools/region-import/germany/run-operational-infrastructure-v2.mjs "$OPERATIONAL_DERIVER_SPECIFICATION" . <OPERATIONAL_CANDIDATE> "$OPERATIONAL_DERIVER_REPORT" "$OPERATIONAL_DERIVER_OUTPUT"
   ```

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
   Candidate, Bericht und `$OPERATIONAL_DERIVER_OUTPUT` gemeinsam mit
   Create-new-Semantik. Ein zweiter manueller Materialisierungsaufruf ist
   unzulässig. Das Ausgabedokument enthält exakt den statischen
   `OperationalInfraRelease` und keine Deploymenthülle.

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
   Kartenlayer sowie die drei Pflichtinputs `gtfs-snapshot`,
   `timetable-route-report` und `timetable-routes`, Candidate,
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
   mit `schema=zugfolge-infra-release-artifact-spec/v2`. Er muss genau einen
   Operational-Descriptor mit ausschließlich `id`, `kind`, `infraReleaseId`,
   `sourceFile` und `file` enthalten. Dabei gelten exakt:

   - `id=<OPERATIONAL_ARTIFACT_ID>`;
   - `kind=operational-infrastructure-v2`;
   - `infraReleaseId=<INFRARELEASE_ID>`;
   - `sourceFile` löst unter der Repository-Wurzel exakt zu
     `<ARTEFAKTWURZEL>/operational-infrastructure-v2.json` auf;
   - `file=operational-infrastructure-v2.json`.

   `bytes`, `sha256` oder `stateHash` dürfen niemals manuell in den Descriptor
   geschrieben werden. Erzeuge sie ausschließlich über die typisierte
   Inventarpipeline:

   ```sh
   node tools/region-import/germany/run-release-artifacts.mjs <ANNUAL_ARTIFACT_SPEC> . <RELEASE_ARTIFACT_INVENTORY>
   ```

   Das erzeugte v2-Inventar muss für `<OPERATIONAL_ARTIFACT_ID>` unverändert
   `id`, `kind`, `file`, `infraReleaseId`, `bytes`, `sha256` und `stateHash`
   transportieren. `sha256` hasht die materialisierten kanonischen Dateibytes,
   niemals die Candidate-Bytes oder die vollständige weltgebundene
   Initialisierung. `stateHash` ist exakt
   `alphaHash("operational-infrastructure-v2", OperationalInfraRelease)`.
   Falls die Pipeline diese Bindung nicht erzeugt, stoppe den Lauf, erweitere
   Pipeline und Positiv-/Negativtests und baue neu. Patche weder Spezifikation
   noch erzeugtes Inventar oder Manifest mit manuell berechneten Hashes.
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
   `operational-infrastructure-v2`-Artefakt und jede Abweichung von dessen
   erwarteter Byte- oder kanonischer Zustandsbindung blockieren den Release.

   Materialisiere anschließend die übrigen öffentlichen Kartenrollen getrennt.
   Der statische Quellenbeleg muss unter
   `<ARTEFAKTWURZEL>/map-release-free-v2/public/static-map-sources-v2.json`
   liegen. Der Karten-Capture wird nach fertigen PMTiles-Bytes als
   `<ARTEFAKTWURZEL>/map-release-free-v2/public/map-source-capture.json`
   erzeugt; `build-map-release.mjs` schreibt den daraus abgeleiteten Wrapper
   nach
   `<ARTEFAKTWURZEL>/map-release-free-v2/public/map-release.json`.

   Erzeuge den unsigned Deliveryvertrag mit
   `build-map-delivery-release.mjs` in
   `<ARTEFAKTWURZEL>/map-release-free-v2/delivery-unsigned/`. Damit sind dessen
   Paketquellen exakt `delivery-unsigned/release.json` und
   `delivery-unsigned/sources.json`. Die Datei
   `<ARTEFAKTWURZEL>/map-release-free-v2/public/release.json` ist ausschließlich
   dem später genehmigten signierten Deliveryvertrag vorbehalten und bleibt im
   unsigned Lauf absent.
9. Führe Unit-, Golden-Master-, Determinismus-, Rechte-, Lizenz-,
   Konfliktinvarianten-, Karten- und unabhängige Holdout-Tests aus. Vergleiche
   Qualitätslängen und Laufzeit/RAM/PMTiles-Größe mit dem Vorjahresrelease und
   erkläre jede wesentliche Abweichung.
10. Führe zusätzlich die Operational-v2-, LiveMap- und RZÜ-Abnahme aus dem
    folgenden Abschnitt vollständig aus. Historische v1-Waypoint-,
    Kartenestimate-, 24-Stunden-Wiederholungs- und synthetische Lastbelege sind
    kein v2-Nachweis.
11. Lege Kandidat, Hashes, Berichte und Reviewliste zur Freigabe vor. Signiere
    erst nach namentlicher Releasefreigabe und wenn sämtliche v2-Cutover-Gates
    grün sind. Dieser kostenlose Clean-v2-Lauf endet ohne eine solche Freigabe
    beim unsigned Kandidaten und ruft keinen Signer auf. Ein bereits signierter
    InfraRelease ohne statische
    Operational-v2-Infrastrukturbindung wird nicht nachträglich erweitert,
    sondern bleibt unverändert; der v2-qualifizierte Kandidat erhält einen neuen
    Releasebezeichner und eine neue Signatur. Markiere M14.2 nur dann erledigt,
    wenn der vollständige Deutschlandlauf und nicht lediglich eine Fixture
    bestanden hat und alle verbleibenden Abnahmebelege erfüllt sind.
    Leite nach einer freigegebenen Signatur den Signed-Paketplan ausschließlich
    reproduzierbar ab; kopiere oder editiere den Jahresplan nicht von Hand:

    ```sh
    node tools/tiles/signed-map-package-plan-cli.mjs <MAP_PACKAGE_PLAN> . ops/keys/trusted-delivery-keys.json ops/keys/trusted-delivery-key-scopes.json <ARTEFAKTWURZEL>/map-release-free-v2/signed-package-plan.json
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
    Binde anschließend in der Jahres-Evidence nicht den unsigned Basisplan als
    Kandidaten, sondern den erzeugten `signed-package-plan.json` über den
    verpflichtenden `candidatePackage`-Vertrag. Dieser muss Paketversion,
    signierte `public/release.json`-Bytes, Release-Hash, Signatur-Key-ID und den
    vollständigen additiven `ops/keys/trusted-delivery-keys.json` belegen. Die
    dort benannten bisherigen Vertrauensanker dürfen nicht entfernt oder durch
    den neuen Karten-Key ersetzt werden. Evidence-Build und Verify müssen die
    Ed25519-Signatur erneut prüfen; ein privater Schlüssel ist keine
    Evidence-Eingabe.
12. Erzeuge kein integriertes Operational-v2-Paket direkt aus dem ungepinnten
   Jahresplan oder dem unsigned Deliveryvertrag. Die unsigned Dateien
   `map-release-free-v2/delivery-unsigned/release.json` und
   `map-release-free-v2/delivery-unsigned/sources.json` sind ausschließlich
   Eingaben der vollständigen Pre-Sign-Prüfung. Ohne namentliche
   Signaturfreigabe endet der integrierte Lauf dort ohne Pack, Verify, Install
   oder Game-Staging.

   Erzeuge das transportneutrale integrierte Paket erst nach freigegebener
   Signatur ausschließlich aus dem vollständig expandierten und bytegenau
   gepinnten `signed-package-plan.json`:

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
Dokumentiere die getrennte Test-Deploymenthülle mit Signaturstatus, Welt,
Region, Weltepoche, Zugzahl und nativer Initialisierung daneben, aber niemals als
InfraRelease-Artefakt. Ergänze LiveMap-/RZÜ-Commitgleichheit,
Sequenz-/Stale-/Freeze-, Replay-/Restore-, Wiederholungs-/Retirement- und
operativen v1-Negativstatus sowie Paketmanifest-Hash, Teilezahl,
Verify-/Installstatus,
Odoo-/Game-Stagingstatus und den ausdrücklich getrennten Aktivierungsstatus.
Verlinke alle internen Laufbelege, aber keine APN-Rohdateien.

---
