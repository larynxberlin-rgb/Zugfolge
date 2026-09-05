# M10 — Anforderungen, Codepfade und PR-Verknüpfungen

Abgleich vom 06.09.2026 mit den acht vollständigen Issue-Beschreibungen des
[Milestones 11](https://github.com/larynxberlin-rgb/Zugfolge/milestone/11).
Der Stack besteht aus [#532](https://github.com/larynxberlin-rgb/Zugfolge/pull/532)
(Kern), [#533](https://github.com/larynxberlin-rgb/Zugfolge/pull/533)
(Trassenautorität) und [#534](https://github.com/larynxberlin-rgb/Zugfolge/pull/534)
(Integration, Oberfläche, Daten und gemeinsame Nachweise).

Schließende Verknüpfungen gehören an den obersten PR #534: Erst er enthält
auch die Plattformintegration und die ergänzten Abnahmebeweise. Die unteren
PRs bleiben als Implementierungsreferenzen verknüpft. Voraussetzung für die
Schließung ist ein grüner CI-Lauf des endgültigen Stacks. Kein Issue wird
allein durch diesen Bericht oder einen bestandenen Teiltest geschlossen.

| Issue | Fachlicher Abgleich | PR-Zuordnung | Verknüpfung |
|---|---|---|---|
| [#169](https://github.com/larynxberlin-rgb/Zugfolge/issues/169) | Gemeinsame Quelle, alle Nachfragetreiber, versionierte Kohorten, Pilot-/Tagesgang-Golden und Summenerhaltung abgedeckt | #532, #534 | Abschluss über #534 vorgesehen |
| [#170](https://github.com/larynxberlin-rgb/Zugfolge/issues/170) | Alle sechs lexikographischen Größen, Verkehrsmittel-/Verbindungs-/Zugwahl, Erklärungen und Angebotsänderungen abgedeckt | #532, #534 | Abschluss über #534 vorgesehen |
| [#171](https://github.com/larynxberlin-rgb/Zugfolge/issues/171) | Tarif-/Vertriebsstörung, Kapazität, Reservierung, Komfort, freie Quellenbindung und unabhängiger Fahrberechtigungsstatus abgedeckt | #532, #534 | Abschluss über #534 vorgesehen |
| [#172](https://github.com/larynxberlin-rgb/Zugfolge/issues/172) | Spielerplanung mit nativer Nachfrage, echter Trassenkonkurrenz und wirtschaftlicher Prognose verbunden; Gesamtnachweis im Native-HTTP-Test | #533, #534 | Abschluss über #534 nach grünem Native-Nachweis vorgesehen |
| [#210](https://github.com/larynxberlin-rgb/Zugfolge/issues/210) | Manifest-/Fortschrittskern und geschützte Persistenz vorhanden; produktiver Haltbelegpfad fehlt | #532, #534 | Referenz, keine automatische Schließung |
| [#173](https://github.com/larynxberlin-rgb/Zugfolge/issues/173) | Vergleichsverfahren, freie Quellen und echter SPNV-Holdout vorhanden; Toleranzen verfehlt, weitere Holdouts fehlen | #532, #534 | Referenz, keine automatische Schließung |
| [#361](https://github.com/larynxberlin-rgb/Zugfolge/issues/361) | Planungsablauf, Datenzustände, Datenschutz und Rücknavigation implementiert; ausdrücklich verlangte Deutschland-/Knoten-Kartenprüfung fehlt | #534 | Referenz, keine automatische Schließung |
| [#379](https://github.com/larynxberlin-rgb/Zugfolge/issues/379) | Gestaltung, Legenden, gestufte Details und mobile Listen nachgewiesen; vollständige Karten-/Datenabnahme an Deutschland und dichten Knoten fehlt | #534 | Referenz, keine automatische Schließung |

## Gemeinsame tatsächliche Verkabelung

Die öffentlichen Rust-Verträge stehen in
[types.rs](../crates/zugfolge-demand/src/types.rs), ihre Auswertung in
[engine.rs](../crates/zugfolge-demand/src/engine.rs). Der Export
`evaluatePassengerDemand` in [runtime-napi](../crates/zugfolge-runtime-napi/src/lib.rs)
ruft unmittelbar `evaluate_demand_json` auf. Der
[TypeScript-Adapter](../packages/runtime-native/src/demand.ts) verwendet dieses
Addon und prüft die zurückgelieferte Welt-, Perioden- und Revisionsbindung.

[server.ts](../apps/game-api/src/server.ts) lädt den gepinnten Korpus,
instanziiert `DemandService`/`SpfvService`, übergibt sie an `buildApp` und
aktualisiert die Nachfrage nach bestätigtem Betriebsschritt.
[app.ts](../apps/game-api/src/app.ts) registriert die
[Nachfrage-/SPFV-Routen](../apps/game-api/src/demand-routes.ts) mit bestehender
Authentifizierung und Planungsbegrenzung. Die URLs stimmen mit den Aufrufen in
[LiveMap-API](../apps/livemap/src/api.ts) und
[Spieler-API](../apps/game-web/src/api.ts) überein.

`DemandStore.latest/commit` in [demand-store.ts](../apps/game-api/src/demand-store.ts)
nutzt das vorhandene Weltjournal mit Welt-/Typindex und Weltmutex. Restore
bewertet den gespeicherten Input erneut nativ; Pinwechsel in derselben Periode,
veränderte Ergebnisse und Writes in archivierten Welten werden abgelehnt.
`demand-service.test.ts`, `demand-horizon.test.ts` und `demand-privacy.test.ts`
prüfen Wiederholung, Welt-/Eigentümergrenzen, Zeit-/Periodenübergang, Restore
und das Zurückhalten verdeckter Daten.

## #169, #170 und #171 — vollständiger jeweiliger Fachumfang

| Anforderung | Code und gezielter Beweis |
|---|---|
| Bevölkerung, Arbeitsplätze, POIs, Anlass, Saison, Tageszeit, Stations-ÖPNV | `DemandZoneV1`, `DemandProfileV1`, `DemandDaySliceV1`, `StationTransitAccessV1`; `attraction`, `cohorts_for_window`, `candidates`; Treibertest in [closure_acceptance.rs](../crates/zugfolge-demand/tests/closure_acceptance.rs) |
| Derselbe Korpus speist SPNV und SPFV; spätere deterministische Materialisierung | Eine gemeinsame Kohorten-/Kapazitätsauswertung, stabile Kohortenkennungen und `materialize`; Pilot-Golden und mehrere Halte in [passenger_demand.rs](../crates/zugfolge-demand/tests/passenger_demand.rs) |
| Summenerhaltung, Tagesgang, bitgleicher Seed/Restore | `assert_conservation`, Pilot-Golden mit 40 Morgen-/120 Restreisen, 48 Seeds mit Eingabepermutation und JSON-Restore, gemeinsamer Pool mehrerer Tagesgangfenster |
| Preis, Zeit, Umstiege, Takt, Zuverlässigkeit, Komfort | `Search::metrics`, `compare_metrics`, `ChoiceMetricsV1`, `ConnectionChoiceV1`, `TrainChoiceV1`; alle sechs Erklärungswerte und Reihenfolge im additiven Akzeptanztest |
| Auto, Reisebus, lokaler ÖPNV, Fußweg, konkrete Züge | `AlternativeModeV1`, `Search::visit`, `candidates`; volle Züge erzwingen jede Alternativart, begrenzte Alternativplätze erhalten die unbediente Restmenge |
| Ausfall, Anschlussverlust, Preis-/Komfortänderung | Bestehende Nachfragefälle prüfen geänderte Wahl, Anschlussverlust um eine Millisekunde, atomare Kapazitätsablehnung und unveränderte Identitäten |
| Tarife, Vertrieb, Reservierung und Komfort | `FareProductV1`, `ComfortClassV1`, `TrainCapacityV1`, `CapacityAllocationV1`, `seat_plan`; Tests für Vertriebsausfall/Bordverkauf, durchgehende Sitze, Stehen, Reservierungs- und Sonderplatzgrenzen |
| Herkunft der Fahrberechtigungspolitik und Unabhängigkeit | `FareCompliancePolicyV1`, `validate_sources`, `validate_release`, separater Hashstrom in `materialize`; 24 Seeds × zwei Komfortklassen × vier Platzbedarfe liefern exakt dieselben gepaarten FareFacts, geschützte Zusatzfelder werden abgewiesen |

Die fünf Abschlusschecklistenpunkte sind durch versionierte
[Fachspezifikation](personenverkehr.md), öffentliche Typen, Unit-/Property-/
Determinismustests, den echten Rust→PGlite→API-Nachweis, Negativ-/Restore-/
Periodentests sowie [Glossar](glossar.md) und [Abnahmematrix](m10-abnahme.md)
zugeordnet. Der balancierte Pilot ist als Modellannahme gekennzeichnet.
Die reale Kalibrierung von #173 und der Ist-Manifestanschluss von #210 werden
nicht als versteckte zusätzliche Anforderungen dieser drei Kern-Issues behandelt.

## #172 — Spielerwerkzeug bis zur tatsächlichen Trassenzuteilung

[SpfvService](../apps/game-api/src/spfv-service.ts) bindet Entwurf, Formation,
geprüfte Plätze, Preise, Frist und Ersetzungsmenge an eine persistente Vorschau.
`DemandService.estimateSpfv` berechnet Nachfrage und prognostizierte Erlöse
mit demselben Rust-Kern; Betriebskosten stammen aus der verifizierten Flotte.
Die Bestätigung nutzt `resolveAuthoritativePlanningPathRequest`, bestehende
Zugnummernvergabe und die atomare `planning.coordinate/v2`-Queue.

[Planning-Worker](../packages/planning-worker/src/worker.ts) und
[native Planning-Runtime](../crates/zugfolge-planning-runtime/src/lib.rs)
prüfen begrenzte Abfahrten gegen bereits bestätigte Belegungen. Nur wirklich
angenommene Reservierungen gelangen über
[loadCommittedSpfvServices](../apps/game-api/src/spfv-demand-projection.ts)
wieder in die Nachfrage. Abgelehnte, ausstehende oder ersetzte Fahrten tun dies nicht.

[spfv-native.integration.test.ts](../apps/game-api/src/spfv-native.integration.test.ts)
verbindet HTTP-Vorschau/Bestätigung, echte native Flottenableitung und -prüfung,
native Nachfrage, Queue, native Trassenvergabe, konkurrierende zweite Linie,
Rückprojektion, Wiederholung und Restore mit PGlite. Die reguläre Linux-NAPI-CI
führt den Test mit beiden echten Addons aus. Korpus und Infrastruktur sind
explizite Testdaten; die drei fachlichen Laufzeiten werden nicht gemockt.
Der [Plattformvertrag](spfv-planung.md), native/Worker-Negativtests und
Browsertests vervollständigen die Abschlusscheckliste. Tatsächliche
Betriebsaktivierung und Ist-Erlösbuchung sind getrennte, offene Producer-Aufgaben.

## Präzise verbleibende Anforderungen

**#210:** Der Kern besitzt `previousEvaluation`, `operationalProgress`,
`frozen_journeys` und Tests für tatsächliche Halte, Anschlussverlust, stabile
Personen/Sitze/FareFacts und Restore. `DemandService.refreshOnce` übergibt
produktiv aber noch keine bestätigten Haltbelege und keinen Vorgängerbeleg
an diesen Modus. Die derzeitige API ist ausdrücklich eine Prognose. Es fehlt
die durchgehende Kette vom Betriebsproducer bis zum persistenten revidierten
Ist-Manifest; der vorhandene Kern braucht dafür keinen zweiten Nachfragedienst.

Die konkrete Lücke liegt vor dem Consumer: `OperationalTrain` und
`TrainMaterialization` in [operational.rs](../crates/zugfolge-sim/src/operational.rs)
besitzen noch keine geordnete, physisch gebundene Zwischenhaltliste. Benötigt
werden signierte Haltanker, native Ankunfts-/Abfahrtsquittungen mit Aufenthalt
und deren persistenter Nachfrageconsumer einschließlich Ausgangsmanifest.
Der vorhandene [Fahrtabschlussproducer](../crates/zugfolge-sim/src/operational/service_outcomes.rs)
erzeugt bereits `train-outcome`; dieser Terminalbeleg ersetzt keine
Zwischenhalte. #518 ist benachbarte Abschluss-/Abrechnungsarbeit und keine
zwingende externe Blockade für diese noch offene M10-Implementierung.

**#173:** [Kalibrierungsquellen](m10-kalibrierungsquellen.md) und
[nativer Vergleich](../tools/demand-calibration/README.md) belegen freie
Quellen, getrennte Daten und reproduzierbare Abweichungen. Der SPNV-Holdout
besteht nur 6/21 Stunden- und 31/105 Abschnittsvergleiche, WAPE 52,20 % bzw.
45,06 %. SPNV-Umstiege sowie SPFV-Tagesgang, -Querschnitt und -Umstiege fehlen
als getrennte gemessene Holdouts. Die erforderlichen sechs Bereiche sind
damit nicht innerhalb der Toleranzen nachgewiesen.

**#361/#379:** Die
[Nachfrageansichten](../apps/livemap/src/demand.ts) und
[SPFV-Planung](../apps/game-web/src/spfv.ts) bieten Legende, Zeitraum,
Herkunft, gestufte Eigentümerdaten, Nullwertabgrenzung und Listenalternative.
Linienänderungen nennen vor der Bestätigung Zugnummern, Weltabfahrtszeiten
und Strecken der gepinnten ersetzten Fahrten sowie Komfort-/Sonderplätze.
Rücknavigation erhält Kartenkontext und Filter;
der ausgewählte Zug ist Navigationskontext, keine ungeprüfte Modellreferenz.
Die Browsernachweise zeigen responsive Seiten und Tabellen mit Beispieldaten.
Sie messen noch keine echte Deutschland-MapLibre-Karte und keine belasteten
Knoten mit den geforderten Datenmengen. Diese expliziten Abnahmecheckboxen
bleiben offen; die 50er-Pagination allein beweist sie nicht.
