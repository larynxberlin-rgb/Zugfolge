# M10 — Anforderungen, Codepfade und PR-Verknüpfungen

Abgleich vom 06.09.2026 mit den acht vollständigen Issue-Beschreibungen des
[Milestones 11](https://github.com/larynxberlin-rgb/Zugfolge/milestone/11).
Der Stack besteht aus [#532](https://github.com/larynxberlin-rgb/Zugfolge/pull/532)
(Kern), [#533](https://github.com/larynxberlin-rgb/Zugfolge/pull/533)
(Trassenautorität) und [#534](https://github.com/larynxberlin-rgb/Zugfolge/pull/534)
(Integration, Oberfläche, Daten und gemeinsame Nachweise), ergänzt um
[#537](https://github.com/larynxberlin-rgb/Zugfolge/pull/537)
(Einwohnernachfrage und direkte Odoo-Datenpflege auf `codex/m10-population-demand`).

Die schließenden Verknüpfungen für #169–#172, #210, #361 und #379 sind per
GitHub-API an #534 bestätigt. #173 erhält wegen des geänderten Nutzerumfangs
seinen schließenden PR #537.
Die unteren PRs bleiben als Implementierungsreferenzen verknüpft. Voraussetzung
für die Schließung ist ein grüner CI-Lauf des endgültigen Stacks. Kein Issue wird
allein durch diesen Bericht oder einen bestandenen Teiltest geschlossen.

| Issue | Fachlicher Abgleich | PR-Zuordnung | Verknüpfung |
|---|---|---|---|
| [#169](https://github.com/larynxberlin-rgb/Zugfolge/issues/169) | Gemeinsame Quelle, alle Nachfragetreiber, versionierte Kohorten, Pilot-/Tagesgang-Golden und Summenerhaltung abgedeckt | #532, #534 | Schließend mit #534 verknüpft |
| [#170](https://github.com/larynxberlin-rgb/Zugfolge/issues/170) | Alle sechs lexikographischen Größen, Verkehrsmittel-/Verbindungs-/Zugwahl, Erklärungen und Angebotsänderungen abgedeckt | #532, #534 | Schließend mit #534 verknüpft |
| [#171](https://github.com/larynxberlin-rgb/Zugfolge/issues/171) | Tarif-/Vertriebsstörung, Kapazität, Reservierung, Komfort, freie Quellenbindung und unabhängiger Fahrberechtigungsstatus abgedeckt | #532, #534 | Schließend mit #534 verknüpft |
| [#172](https://github.com/larynxberlin-rgb/Zugfolge/issues/172) | Spielerplanung mit nativer Nachfrage, echter Trassenkonkurrenz und wirtschaftlicher Prognose verbunden; Gesamtnachweis im Native-HTTP-Test | #533, #534 | Schließend mit #534 verknüpft |
| [#210](https://github.com/larynxberlin-rgb/Zugfolge/issues/210) | Signierte Haltanker, native Ankunft/Abfahrt, geschützte Anfangspools und kausaler Journalconsumer mit Drei-Halt-/Restore-Beweis implementiert | #532, #534 | Schließend mit #534 verknüpft |
| [#173](https://github.com/larynxberlin-rgb/Zugfolge/issues/173) | Geänderter Nutzerumfang: Einwohnererhaltung, Stationsklassen, ungefähre Wunschziele und normale Odoo-Datenpflege sind im gemeinsamen Kern integriert | #537 | Schließender PR #537 |
| [#361](https://github.com/larynxberlin-rgb/Zugfolge/issues/361) | Planungsablauf, Datenzustände, Datenschutz, Rücknavigation und tatsächliche Deutschland-/Knoten-Kartenprüfung mit deklariertem Lastkorpus belegt | #534 | Schließend mit #534 verknüpft |
| [#379](https://github.com/larynxberlin-rgb/Zugfolge/issues/379) | Gestaltung, Legenden, gestufte Details, Kartenklick und mobile Listen unter Deutschland-/Knotenlast nachgewiesen | #534 | Schließend mit #534 verknüpft |

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
Der neue Populationsumfang von #173 und der Ist-Manifestanschluss von #210 werden
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
Der [Linux-NAPI-Nachweis auf ef588a3](https://github.com/larynxberlin-rgb/Zugfolge/actions/runs/33997190861/job/101389702587)
hat diese vollständige Kette bestanden. Er deckte zusätzlich die nun
behobene zweite Datenbankverbindung innerhalb der SPFV-Transaktion auf.
Der [Plattformvertrag](spfv-planung.md), native/Worker-Negativtests und
Browsertests vervollständigen die Abschlusscheckliste. Tatsächliche
Betriebsaktivierung und Ist-Erlösbuchung sind getrennte, offene Producer-Aufgaben.

## #210 — autoritative Fahrgastmanifeste bis zur API

Die Kette ist in [M10-Haltbelege](m10-haltbelege.md) beschrieben und besteht
aus tatsächlichen Produzenten und einem persistenten Consumer:

- Der [Fahrplancompiler](../tools/region-import/germany/timetable-route-compiler.mjs)
  erhält exakte gerichtete Haltanker. Der [Haltbinder](../tools/region-import/passenger-stop-binding-v1.mjs)
  und der Alpha-Builder verbinden sie mit tatsächlicher Fahrstraße, Bahnsteig,
  Formation und signiertem Deployment. Die Rust-Infrastrukturgrenze prüft die
  Anker auch beim realen JSON-Sequence-Import.
- [Native Fahrgasthalte](../crates/zugfolge-sim/src/operational/passenger_stops.rs)
  bremsen innerhalb der bestehenden Fahrterlaubnis, belegen tatsächlichen
  Stillstand und Mindesthalt und quittieren erst die tatsächliche Abfahrt.
  Signalausfälle erzeugen keine erfundenen Zwischenhalte. Der Runtime-Hash
  schützt Planvorlagen, Fortschritt und tägliche Fahrtbindungen über Restore.
- [Poolanfänge](../apps/game-api/src/demand-pool-seeds.ts) werden vor der ersten
  Abfahrt mit Quellpins und Journalgrenze geschützt gespeichert. Der
  [Journalconsumer](../apps/game-api/src/demand-progress.ts) verarbeitet nur
  gemeinsam abgeschlossene Regionszeitpunkte, wahrt Vorgängerergebnis und
  kumulative Ist-Belege und persistiert Zeitgrenzen und Cursor atomar.
  Folgepools behalten getrennte Fahrtkennungen; belegte begonnene Reisen
  wechseln erst nach bestätigter Zielankunft. Leere Züge blockieren diesen
  Wechsel nicht.
- `DemandService` wird vor und nach dem bestätigten Betriebsadvance aufgerufen.
  Die Manifest-API zeigt im autoritativen Modus ausschließlich einen tatsächlich
  abgefahrenen Abschnitt vor seiner Folgeankunft. Am Halt und nach Fahrtende
  meldet sie keinen aktiven Fahrgastabschnitt. Schlüssel, Sitze und verdeckte
  FareFacts bleiben für bereits gereiste Abschnitte erhalten.

Der [Drei-Halt-Integrationstest](../apps/game-api/src/demand-operational-native.integration.test.ts)
führt echten Betriebs- und Nachfrage-Rust mit PGlite, Signalstörung,
Anschlussverlust, Restore und HTTP zusammen. `demand-progress.test.ts`,
`demand-pool-seeds.test.ts`, `demand-pool-lifecycle.test.ts` und
`world-deployment-passenger-stops.test.ts` prüfen Bindungsfehler, Weltgrenzen,
mehrere Regionen, Abfahrten bei Zeit 0, Kaltstart über zwei Pools, tägliche
Kennungen und idempotentes Ende. `demand-offer-history.test.ts` belegt mit
Rust, dass bestätigte Angebotswechsel vor, nach und gleichzeitig mit einer
Abfahrt nach Zeit und Weltsequenz wirken. Neue Dienste, vorgemerkte
Planungsstände und historische Revisionen vor dem Seedcursor bleiben über
Restore erhalten. Unhistorisierte Snapshotänderungen werden abgewiesen.
Öffentlicher Ingest und Ereignisprojektionen
geben die privaten Fachbelege nicht frei. Die reguläre Linux-CI führt den
Drei-Halt-Beweis mit dem echten NAPI-Addon aus; die schließende Verknüpfung
setzt einen grünen Lauf des finalen Codes voraus.

Alte Deployments ohne nachgewiesene Haltanker erhalten keine erfundenen
Ist-Manifeste. Neue Routen benötigen eine zertifizierte Haltbindung. Der
nachgelagerte M15-PR #535 liest weiterhin denselben `PassengerManifestV1`-
und `demand-operational-progress/v1`-Vertrag; ein zweiter Nachfragekern entsteht
nicht.

## #173 — geänderter Nutzerumfang und tatsächlicher Datenweg

Am 06.09.2026 ersetzte der Nutzer die empirische Kalibrierungsabnahme durch
Ortsbevölkerung, daraus abgeleitete Stationsklassen und ungefähre Wunschziele
aus bestehenden Verbindungen. Hinzu kommt die ausdrücklich gewünschte
direkte Datenpflege durch normales Speichern in Odoo. Titel und Beschreibung von #173 wurden entsprechend auf
„[Roadmap 10.5] Einwohnerbasierte Stationsnachfrage und direkte Odoo-Datenpflege“
aktualisiert; die [Spezifikation](m10-populationsnachfrage.md) dokumentiert den
verbindlichen Umfang.

| Anforderung | Verbundener Code und Nachweis |
|---|---|
| Freie Einwohner- und Verbindungsdaten | [Import/Builder](../tools/population-demand/README.md), BKG-VG250-EW, GTFS.de-RV/FV, gepinnte Originalhashes und sieben Verkehrstage; 21 Python-Tests einschließlich drei nativer Integrationen |
| Einwohner einmal verteilen, Klassen und grobe Ziele | [population.rs](../crates/zugfolge-demand/src/population.rs), gemeinsamer `cohorts_for_window`-Pfad; konservierende Zuteilung, Klassenränder, deduplizierte gerichtete Verbindungen, positive latente Ziele und keine Rückkopplung aktueller Spielerangebote |
| Echter regionaler End-to-End-Korpus | Zwölf Originalstationskennungen, acht Orte, 1.245.193 erfasste Einwohner; [Report](../tools/population-demand/example/report.json) mit 3.729 nativen Wünschen und explizit synthetischen Testzügen |
| Normales Speichern in Odoo | [Datenmodelle](../odoo/addons/zugfolge_admin/models/demand_data.py) und [Pflegeansicht](../odoo/addons/zugfolge_admin/views/demand_data_views.xml): Einwohner, Stationsanteile und Verbindungen, Originalwerte und Änderungsbelege, automatische Übertragung ohne Freigabe-/Exportablauf |
| Signierter Datenbankweg und atomarer Ergebnisbeleg | [Datenkommandovertrag](../packages/commerce/src/demand-data.ts), [Transaktionsworker](../packages/commerce/src/demand-data-worker.ts) und [Game-Datenconsumer](../apps/game-api/src/demand-population-data.ts); HMAC, bestehende Adminrolle, Weltbindung, Revision, native Validierung, Wiederholung und Rollback |
| Wirkung auf neue Wünsche, bestehende Reisen erhalten | `populationRevision`, zeitliche Datenhistorie und `DemandService`; [Initialisierung](../apps/game-api/src/demand-population-initialization.test.ts), [signierte Übernahme](../apps/game-api/src/demand-population-data.integration.test.ts) und native Fortschritts-/Restorefälle |
| Schätzungen nachvollziehbar anzeigen | Nachfrage-API und LiveMap zeigen Klasse, zugeteilte Einwohner, höchstens fünf aus echten Kohorten aggregierte Wunschziele, Referenzwoche und Quellen; auch unbediente Stationen bleiben sichtbar |

Die lokalen Prüfungen sind in [der Abnahmematrix](m10-abnahme.md) aufgeführt.
Der finale CI-Lauf sowie neun ORM- und zwei HTTP-Tests im echten Odoo 19
werden am PR mit ihrem tatsächlich geprüften Commit und Lauf verknüpft.
Die Issue-Zuordnung ist #537; die GitHub-Verknüpfung schließt das Issue erst
bei Übernahme in den Hauptzweig. Die endgültigen Prüfungen bleiben Voraussetzung.

Die historischen [Kalibrierungsquellen](m10-kalibrierungsquellen.md) und
[AFZS-Holdoutberichte](../tools/demand-calibration/README.md) bleiben unverändert:
6/21 Stunden- und 31/105 Abschnittsvergleiche bestanden, WAPE 52,38 % bzw.
45,34 %. Daraus wird keine empirische Genauigkeit abgeleitet. Diese alte
Abnahmeschwelle ist durch den ausdrücklichen neuen Auftrag ersetzt.

## #361/#379 — UI-/UX-Abnahme mit echter Karte

Die
[Nachfrageansichten](../apps/livemap/src/demand.ts) und
[SPFV-Planung](../apps/game-web/src/spfv.ts) bieten Legende, Zeitraum,
Herkunft, gestufte Eigentümerdaten, Nullwertabgrenzung und Listenalternative.
Linienänderungen nennen vor der Bestätigung Zugnummern, Weltabfahrtszeiten
und Strecken der gepinnten ersetzten Fahrten sowie Komfort-/Sonderplätze.
Rücknavigation erhält Kartenkontext und Filter;
der ausgewählte Zug ist Navigationskontext, keine ungeprüfte Modellreferenz.
Der ergänzte [Kartenbericht](m10-kartenabnahme.md) und
[Browserlasttest](../apps/game-api/src/demand-map-browser.e2e.test.ts) prüfen
die tatsächlich gebaute LiveMap mit MapLibre, PMTiles-Rangezugriffen,
5.400 synthetischen Stationsobjekten und 5.000 Zugprojektionen. Im dichten
Knoten liegen 400 Stationen und Züge. Die 1366/390/320-Pixel-Fälle prüfen
Legende ohne Werkzeugüberlappung, echten Kartenklick, gestufte Zugdetails,
50er-Pagination, sichtbare Live-Deltas und den vollständigen Planungsrückweg.
Start-, Nachfrage- und Framezeiten werden gegen vorab gesetzte UI-Budgets
gemessen; späte Kartenfehler und externe Laufzeitrequests führen zum Fehler.

Damit sind diese UI-/UX-Anforderungen im offengelegten Testumfang erfüllt.
Das ist kein Nachweis des produktiven millionenfachen Deutschland-Korpus,
keine reale Nachfragekalibrierung und keine Betriebsfreigabe. Der geänderte
Umfang von #173 wird oben eigenständig geprüft; produktive Fachabnahmen
bleiben bei den bestehenden Release-/Betriebsissues.
