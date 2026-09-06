# M10.3a — produktive Haltbelege und Manifestfortschreibung

Implementierungsstand **v1**, 06.09.2026, für
[#210](https://github.com/larynxberlin-rgb/Zugfolge/issues/210).
Die Kette aus signierten Haltbindungen, nativen Ankunfts-/Abfahrtsbelegen,
atomarem Regionsjournal und persistentem Nachfrageconsumer ist implementiert.
Der lokale Rust-Integrationslauf ist bestanden. Der maßgebliche vollständige
Linux-NAPI-Abschlussbeleg wird in den [Checks von PR #534](https://github.com/larynxberlin-rgb/Zugfolge/pull/534/checks)
geführt; eine schließende Issue-Verknüpfung setzt dessen grünen finalen Code voraus.
Das ist keine allgemeine Produktionsfreigabe. Die getrennte
Kalibrierungsabnahme [#173](https://github.com/larynxberlin-rgb/Zugfolge/issues/173)
bleibt offen.

## 1. Implementierter Datenfluss

| Grenze | Implementierung und Verantwortung |
|---|---|
| [Routencompiler](../tools/region-import/germany/timetable-route-compiler.mjs) | Erhält die wirklich gewählten gerichteten `passengerStopAnchors` und kumulierten Laufwegpositionen vor `mergeLegs`; wiederholte Stationsbesuche bleiben eigene Vorkommen. |
| [Rust-Infrastrukturimport](../crates/zugfolge-infra/src/germany_operational_v2.rs) | Prüft Anker gegen gerichtete Teillegs, Quellkanten und exakte gemeinsame Endknoten; geometrisches Snapping ersetzt keinen Quellbeleg. |
| [Haltbindung](../tools/region-import/passenger-stop-binding-v1.mjs), [Weltcompiler](../tools/region-import/build-alpha-world.mjs), [Bewegungsbindung](../tools/region-import/movement-route-allocation-v2.mjs) | Binden Originalhalte und Fahrplanzeiten nach der Bewegungszuweisung an die tatsächliche Dispatchroute, Formation und eindeutig belegte Plattform. Der vollständige Haltplan gehört in den signierten Initialisierungskorpus. |
| [Native Haltsteuerung](../crates/zugfolge-sim/src/operational/passenger_stops.rs) | Validiert die gesamte Formation an jedem Halt, setzt das nächste Bremsziel, wartet auf tatsächliche Ankunft und Mindestaufenthalt und emittiert einmalige Belege. |
| [Native Runtime](../crates/zugfolge-sim-runtime/src/operational_runtime.rs) | Bindet spätere Materialisierungen an die signierten Haltvorlagen und prüft Zustand, Replay und zulässige Tagesinstanzen. |
| [Regionaler Worker](../apps/game-api/src/regional-simulation-worker.ts), [Decoder](../apps/game-api/src/operational-passenger-stop.ts), [Eventadapter](../apps/game-api/src/operational-domain-event-adapter.ts) | Speichern native Zustandsänderung und streng geprüfte Haltbelege atomar mit Welt, Region, Commit und nativer Ereignissequenz. |
| [Anfangspools](../apps/game-api/src/demand-pool-seeds.ts) | Pinnen auch zukünftige freigegebene Pools vor dem ersten Regional-Advance als private, unveränderliche native Anfangsauswertung. |
| [Nachfrageconsumer](../apps/game-api/src/demand-progress.ts), [Nachfragespeicher](../apps/game-api/src/demand-store.ts) | Lesen den vollständigen bestätigten Journaltail unter Weltmutex und speichern kausale Fortschritte, Replayinput und Cursor zusammen. Zugwahl und Personenmaterialisierung bleiben im Rust-Nachfragekern. |
| [Angebotshistorie](../apps/game-api/src/demand-offer-history.ts) | Rekonstruiert bestätigte SPFV-Angebote bis zu ihrer jeweiligen Planungssequenz und verbindet deren wirksame Zeiten mit dem Haltbelegstrom. |
| [DemandService](../apps/game-api/src/demand-service.ts), [Serverzyklus](../apps/game-api/src/server.ts) | Bereiten Nachfrage vor dem Regionalzyklus vor und holen Belege danach nach. Das berechtigte Manifest verwendet tatsächliche Abschnittsgrenzen. |

`motion-segment-started`, `motion-segment-ended`, `movement-continued`, ein
Signalhalt, Kartenkoordinaten und Sollzeiten sind keine Fahrgasthaltbelege.
Auch ein nativer `train-outcome` beweist nur den vollständigen Fahrtabschluss.
Die Haltereignisse entstehen im bestehenden E31-Bewegungskern; es gibt keine
zweite Positions- oder Bewegungsautorität in TypeScript.

## 2. Geordnete und signierte Haltbindung

Der additive Routencompiler-Eintrag `passengerStopAnchors` enthält je Vorkommen
`stationId`, `stopSequence`, `edgeId`, `direction`, `offsetMm`, `routeMm`,
`sourceEdgeId` und `sourceOffsetMm`. `routeMm` ist die kumulierte Entfernung
über die gerichteten Teillegs, keine gleichmäßige Verteilung der Halte.
Die ursprüngliche GTFS-Reihenfolge bleibt streng steigend; Lücken sind erlaubt.
Eine abweichende Quellkante ist nur am nachgewiesenen gemeinsamen Endknoten
zulässig. Wiederholte Stationsbesuche werden nicht verschmolzen.

`OperationalPassengerStopPlan`, Schema
`zugfolge-operational-passenger-stop-plan/v1`, ist das optionale Feld
`stopPlan` der Zuginitialisierung und Materialisierung:

- Kopf: `schemaVersion`, `worldId`, `infrastructureReleaseId`,
  `timetableReleaseId`, `serviceId`, `serviceRunId`, `trainRunId`,
  `routeVersionId`, `sourceBindingHash`.
- Zwei bis **100** Halte mit `stopId`, `stationId`, `stopSequence`, `routeMm`,
  `platformId`, `scheduledArrivalMs`, `scheduledDepartureMs`, `minimumDwellMs`.
  Der operative `stopSequence` ist lückenlos ab null. Die Kennung lautet
  `<trainRunId>:<stopSequence>` und muss dem Halt in `TrainServiceV1` entsprechen.
- Sichere ganzzahlige Millimeter und Millisekunden seit Weltepoche. Zeiten
  werden an der Importgrenze genau einmal aus Fahrplansekunden umgerechnet.
  Fahrtage und Originalabstände bleiben dabei erhalten.
- Der erste Halt liegt exakt an der initialen Zugspitze, der letzte am
  Laufwegende. Alle Haltpositionen steigen strikt. Die gesamte Formation muss
  an jedem Halt innerhalb eines einzigen gleichgerichteten Plattformintervalls
  liegen; ein nur ungefähr bekannter Bahnhof reicht nicht.

`sourceBindingHash` bindet GTFS-Snapshot, Routenartefakt, Infrastrukturzustand,
Bewegungsroutenzustand, gerichtete Anker, Plattformfakten, Formation und
zugewiesene Route. Der Infrastrukturleser streamt den vollständigen
byte-/SHA-256-gepinnten Korpus und hält nur benötigte Routen und Plattformen.
Die Generatorprovenienz enthält auch Haltbinder- und Bewegungsallocator-Quellen.
Der Initialisierungshash schließt sämtliche Fahrgast- und Bewegungsvorlagen ein,
nicht nur anfangs materialisierte Züge.

Der kanonische `stopPlanHash` wird **nativ berechnet** und im Haltzustand und
in den Belegen geführt; er ist kein vom Client gesetztes Eingabefeld.
`state.passengerStopTemplates` bindet eine normalisierte Vorlagenmenge an
den Runtimezustand. Spätere Materialisierung und physische Fortsetzung dürfen
weder Halte, Route, Quelle, Plattform noch Mindestaufenthalt ändern oder einen
vorher gebundenen Plan entfernen. Erlaubt sind nur die exakt aus
`repeatEveryMs` abgeleiteten Tageskennungen und einheitlichen Zeitverschiebungen;
eine vorhandene `serviceOutcome`-Bindung muss denselben Betriebstag belegen.

Alte Korpora ohne Anker bleiben lesbar und erhalten keinen erfundenen Plan.
Fehlt ein eindeutiger Plattformbeleg für die vollständige Formation, wird kein
Plan ausgegeben und der Compiler meldet die fehlende vollständige Evidenz.
Widersprüchliche Anker, Pins oder Fahrplanzuordnungen werden abgelehnt.

## 3. Native Ankunft, Aufenthalt und Abfahrt

`plan_motion` begrenzt den analytischen Abschnitt zusätzlich am nächsten
gebundenen Fahrgasthalt. Fahrberechtigung, Stellwerksicherung und Konfliktprüfung
gelten unverändert. Eine Ankunft entsteht erst bei exakter gebundener Zugspitze,
Geschwindigkeit null und beendetem Bewegungsabschnitt. Die bestätigte
Anfangslage erzeugt ebenfalls eine Ankunft; eine Sollzeit allein keine Abfahrt.

Die früheste Abfahrt ist
`max(actualArrivalMs + minimumDwellMs, scheduledDepartureMs)`.
Auch danach ist eine reale Fahrberechtigung nötig. Erst der native Übergang
in einen vorwärtsführenden Bewegungsabschnitt emittiert die Abfahrt. Ein
Dispatchauftrag oder eine Störungsfreigabe reicht für sich allein nicht.
Am Endhalt entsteht nur die Ankunft, keine zusätzliche Abfahrt.

`OperationalPassengerStopReceipt`, Schema
`zugfolge-operational-passenger-stop-receipt/v1`, enthält
`schemaVersion`, `worldId`, `serviceRunId`, `trainRunId`, `stopId`,
`stopSequence`, `stopPlanHash`, `routeVersionId`, `formationVersionId`,
`kind` (`arrival` oder `departure`), `actualTimeMs` und `receiptId`.
Die Kennung entsteht deterministisch aus Welt, Tagesfahrt, Zuglauf,
Haltvorkommen und Art. Der Decoder prüft Ereignisart, native Zeit, Subjekt und
Welt; der Regionscommit bindet `regionId`, `commitSequence` und
`nativeEventSequence`. Es entstehen die privaten Weltjournalereignisse
`operations.passenger-stop-arrival` und `operations.passenger-stop-departure`.
Widersprüchliche Duplikate sind Fehler. Die Belege enthalten keine
Fahrgastschlüssel oder verdeckten Fahrberechtigungen.

Plan, Planhash, nächster Haltindex, bestätigte Zeiten und fällige
Abfahrtsereignisse gehören zum nativen Zustand und seiner Restore-/Handoverprüfung.
Nur der bestätigte regionale Besitzer setzt eine übergebene Fahrt fort.
Formationänderungen prüfen die noch erforderlichen Haltlagen erneut; bereits
passierte Plattformen werden nicht rückwirkend gegen die neue Formation
bewertet. Ein ungeprüfter Laufwegwechsel einer haltgebundenen Fahrt wird
abgelehnt; eine neue Bindung wird nicht aus alten Halten geschätzt.

## 4. Anfangspool und kausaler Nachfrageconsumer

Vor dem ersten Regional-Advance pinnt `pinDemandPoolSeeds` unter Weltmutex
alle freigegebenen Pools, einschließlich späterer Fenster. Ein
`DemandPoolSeed`, Schema `zugfolge-demand-pool-seed/v1`, enthält vollständige
Vorlage und native Anfangsauswertung, Welt-/Perioden-/Deploymentbindung,
deren Hashes, initiale Regionsstände sowie die tatsächliche Journalgrenze.
Er wird als privates `demand.pool-initialized` gespeichert. Der Anfangscursor
liegt vor einer gegebenenfalls schon gespeicherten Origin-Ankunft; eine
bereits vorhandene passende Abfahrt wird dagegen immer abgewiesen, auch bei
Weltzeit null. Der am weitesten fortgeschrittene beteiligte Regionsstand darf
den ersten Abfahrtzeitpunkt nicht überschritten haben. Ein späterer Neustart
prüft den vorhandenen Seed nativ, statt historische Reisende mit dem heutigen
Angebot neu zu erzeugen.

`DemandProgressCursor`, Schema `zugfolge-demand-progress-cursor/v1`, enthält
`schemaVersion`, `worldId`, `initialInputHash`, `throughWorldSequence`,
`safeThroughMs`, `receiptSetHash`, `regions`, `receipts` und `pendingReceipts`.
Die additive Angebotshistorie ergänzt `receiptWorldSequences`, `offerServices`,
`offerSourceServices` und `pendingOffers` im selben gehashten privaten Cursor.
Je Region sind `regionId`, `initializationHash`, `commitSequence`,
`nativeEventSequence` und `completeThroughMs` gebunden. Pools und Regionen
sind jeweils auf **256**, übernommene plus wartende Haltbelege auf **40.000**
und serialisierte Seeds/Checkpoints auf **16 MiB** begrenzt.

Ein weiteres Kommando kann am aktuellen Regionszeitpunkt noch ein Ereignis
erzeugen. Deshalb verarbeitet der Consumer nur Zeiten strikt vor dem
kleinsten bestätigten Regionszeitpunkt:
`safeThroughMs = max(0, min(region.nowMs) - 1)`. Bei Weltzeit null bleiben
auch Nullzeitbelege zunächst wartend. Belege einer vorauslaufenden Region
bleiben im Cursor, bis alle gebundenen Regionen aufgeholt haben. Region-,
Pin- und Sequenzrückschritte werden abgelehnt.

Der Consumer ordnet nach tatsächlicher Zeit und dauerhafter Weltsequenz.
Gleichzeitige Haltbelege gehen gemeinsam in den bestehenden Rust-Eingang
`DemandOperationalProgressV1` ein, solange kein dazwischen committierter
Angebotswechsel die Grenze teilt. Zwischen Zeitgrenzen wird
jeweils das vorherige Ergebnis als `previousEvaluation` weitergereicht.
Private `demand.pool-progressed`-Einträge halten diese Replayeingaben;
erst `demand.evaluated` veröffentlicht den neuen Nachfragekopf. Fortschreibung
und Cursor werden in derselben Welttransaktion gespeichert. Auch ein
unverändertes Manifest darf seinen vollständig gelesenen Cursor fortschreiben.

`loadDemandOfferHistory` liest höchstens 256 bestätigte Angebotsrevisionen
aus `planning.runtime-state` und dem unmittelbar zugehörigen, im selben
Planungscommit geschriebenen `planning.diagram`. Der bestehende SPFV-Projektor
rekonstruiert mit `asOfWorldSequence` die zu diesem Zeitpunkt akzeptierten
Fahrten aus ihren gepinnten Vorschauen und tatsächlich bearbeiteten Anträgen.
Ein `DemandOfferRevision` bindet Welt, Periode, Weltsequenz, wirksame
Commitzeit seit Weltepoche, Quellenhash, Angebot und Provenienz. Hierfür wird
kein zusätzlicher Planungsereignistyp eingeführt.

Angebotswechsel und Haltbelege werden gemeinsam fortgeschrieben. Ein Angebot
gilt erst ab bestätigter Zeit und Weltsequenz, nicht schon bei Bestellung oder
Vorschau. Vorauseilende Angebote bleiben bis zur sicheren Regionszeit im
Cursor. Entfernte Dienste bleiben als ausgefallen referenzierbar, damit
gefahrene Abschnitte und ihre Belege nicht verschwinden. Der neueste
Endsnapshot darf keine frühere Abfahrt rückwirkend verändern.

Die operative Kartenprojektion liefert `running`/`waiting`, keine eigene
historische Cancel-/Delay-Autorität. Ungebundene Ausfall-, Betreiber- oder
Verspätungsänderungen eines Snapshots werden im autoritativen Nachfragepfad
abgelehnt. Tatsächliche und daraus abgeleitete Folgezeiten stammen dort aus
den Haltbelegen. Der gesonderte Forecastpfad behält seine Prognoseeingaben.

## 5. Abschnittsmanifest, Perioden und öffentliche Grenze

Ein tatsächlich aktiver Abschnitt benötigt die bestätigte Abfahrt am
Ausgangshalt und noch keine bestätigte Ankunft am Folgehalt.
`DemandService.manifest` veröffentlicht dafür `source: confirmed`; am
Fahrgasthalt sowie vor Fahrtbeginn und nach Fahrtende antwortet die Route
mit **409**. Ein Signalhalt innerhalb des Abschnitts beendet diesen nicht.
Weitere Abschnittsbelegungen und abgeleitete zukünftige Zeiten bleiben
Prognosen, auch bei `projectionMode: progress_bound`.

Der Eigentümer erhält paginiert Fahrgastkennung, Ein-/Ausstiegsbezeichnung,
Sitzklasse und Platzbedarf. `fareFact`, Tarifpolicy, interne Sitznummern und
Reiseketten bleiben geschützt. Öffentliche Nachfrageansichten enthalten
Aggregate. Der Rust-Kern hält begonnene Teilreisen, Personenkennungen, Sitze,
Reservierungen und gebuchte Tarife stabil; nach nachgewiesenem Anschlussverlust
revidiert er nur den noch nicht gefahrenen Anteil. Ohne Fortsetzung bleibt
die Reise `stranded`. Ohne Ist-Ausstiegsbeleg darf kein Reisender aus einem
Zug verlagert werden.

Das Erzeugungsfenster begrenzt keine laufende Reise. Der alte Pool bleibt
bis zur bestätigten Zielankunft begonnener Reiseketten gebunden, auch beim
Umstieg und nach einer prognostizierten Endzeit. Folgepools besitzen bereits
ihren eigenen Anfangsseed; ihre historischen Belege werden beim Übergang
nachgeholt, ohne die öffentliche Zeit zurückzustellen. Fehlender Anfang,
fremde Welt, geänderter Releasepin oder beschädigter Cursor führen zu einer
nicht verfügbaren Projektion und keiner erfundenen Belegung.

## 6. Nachweise und Freigabegrenzen

| Nachweis | Test und Umfang |
|---|---|
| Gerichtete Originalanker, ungleich verteilte Zwischenhalte, wiederholte Stationen | [Routencompilertests](../tools/region-import/germany/timetable-route-compiler.test.mjs) |
| Plattformbindung, Signaturwirkung, fehlende Evidenz, begrenztes Streaming | [Haltbindertests](../tools/region-import/passenger-stop-binding-v1.test.mjs) und [Generatorprovenienz](../tools/region-import/vehicle-catalog-deployment-binding.test.mjs) |
| Drei Halte mit Signalhalt, Mindestaufenthalt, Restore; Handover und Formationswechsel | [Native Betriebstests](../crates/zugfolge-sim/tests/operational_engine.rs), insbesondere `native_passenger_stops_three_halts_signal_dwell_and_restore` und `native_passenger_stop_handover_transfers_dwell_and_exactly_once_receipts` |
| JSON-Vertrag, signierte Vorlagen und Wiederholung | [Native Runtime-Tests](../crates/zugfolge-sim-runtime/src/operational_runtime.rs), insbesondere `native_passenger_stop_contract_three_halt_receipts_and_replay` |
| Private Anfangspools, Welt-/Regionspins, späte Starts, Rollback, Seed-Replay | [Poolseedtests](../apps/game-api/src/demand-pool-seeds.test.ts) |
| Gleichzeitige und verspätete Journalbelege, Cursor, Periodengrenzen und widersprüchliche Wiederholung | [Consumertests](../apps/game-api/src/demand-progress.test.ts); synthetische Transportbelege sind ausdrücklich ausgewiesen |
| Wirksame Angebotswechsel und zeitlich begrenzte historische Projektion | [Angebotsregressionen](../apps/game-api/src/demand-offer-history.test.ts): sieben Fälle, darunter sechs mit echtem Rust; Wegfall vor/nach Abfahrt, gleiche Zeit nach Weltsequenz, vorauseilender Planner, neuer Dienst, Bootstrap vor Seedcursor und Restore |
| Importbinder → native Bewegung → Workerjournal → Consumer → native Nachfrage → Restore → HTTP | [Drei-Halt-Integration](../apps/game-api/src/demand-operational-native.integration.test.ts): zwei getrennte native Fahrten, Sperre vor B, tatsächliche Anschlussabfahrt vor verspäteter B-Ankunft, bitgleicher Manifestpräfix, Mindesthalt, fünf geordnete Hauptzugbelege, Ende und idempotente Wiederholung |

Reproduzierbarer Integrationstest aus der Repositorywurzel, mit gebautem
Linux-Addon in `ZUGFOLGE_RUNTIME_NATIVE_PATH`:

```sh
pnpm --filter @zugfolge/game-api exec vitest run src/demand-operational-native.integration.test.ts --no-file-parallelism
```

Der lokale Fall ist durch dieselben Rust-Einstiegspunkte über einen
ausgewiesenen CLI-Transport bestanden. Dies beweist nicht das Laden des
NAPI-Addons; ein übersprungener Test genügt ebenfalls nicht. Der vollständige
Linux-CI-Lauf ist deshalb der maßgebliche Abschlussbeleg. Der synthetische Drei-Halt-Korpus
belegt Implementierungsverhalten, keine produktive Deutschland-Releasequalität
und keine beobachtete Nachfragekalibrierung.

[#173](https://github.com/larynxberlin-rgb/Zugfolge/issues/173) bleibt offen:
Der echte RE7-Holdout erreicht **52,38 % WAPE** beim stündlichen Einstieg und
**45,34 % WAPE** bei gerichteter Abschnittsbesetzung und besteht auch die
eingeschränkte SPNV-Prüfung nicht. Freie Vergleichsdaten für SPNV-Umstiege
sowie SPFV-Tagesgang, -Querschnitt und -Umstiege fehlen weiterhin; Details
stehen in [Kalibrierungsquellen](m10-kalibrierungsquellen.md).
Kosten-/Day-Close-/Vertragsbelege aus #518 und der Dispositionsvertrag aus #517
sind eigenständige Umfänge und kein pauschaler Blocker dieser Haltbelegkette.
