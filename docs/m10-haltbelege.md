# M10.3a — produktive Haltbelege und Manifestfortschreibung

Implementierungsplan **v1**, Stand 06.09.2026, für
[#210](https://github.com/larynxberlin-rgb/Zugfolge/issues/210).
Die nachfolgend neu benannten Verträge sind noch zu implementieren. Dieses
Dokument ist kein Abnahmebeleg und schließt das Issue nicht. Es konkretisiert
die offene Anbindung aus [personenverkehr.md](personenverkehr.md) innerhalb
der bestehenden E31-Betriebswirklichkeit; eine neue Grundsatzentscheidung
oder ein Abschluss von #518 ist dafür nicht erforderlich.

## 1. Vorhandene Produzenten und genaue Lücke

| Grenze | Bereits vorhanden | Für #210 noch erforderlich |
|---|---|---|
| [Native Bewegung](../crates/zugfolge-sim/src/operational.rs) | `plan_motion`, `advance_to`, bestätigte Spitze/Schluss, Geschwindigkeit, Fahrberechtigung, Laufwegversion; `physical_route_complete` und `refresh_route_completion` | Geordneter Fahrgasthaltplan, Bremsziel am Zwischenhalt, persistenter Haltzustand und einmalige Ankunfts-/Abfahrtsereignisse |
| [Native Fahrtabschlüsse](../crates/zugfolge-sim/src/operational/service_outcomes.rs) | `ServiceOutcomeBinding`, `ServiceOutcomeProgress`, `complete_service_outcome`: `train-outcome` mit tatsächlichem `actualArrivalMs = self.now_ms`, Laufleistung und belegter Mindestkapazität | Eindeutige Herkunfts- und Zwischenhaltbelege; der reale Abschluss des gesamten Laufwegs beweist diese nicht |
| [Routencompiler](../tools/region-import/germany/timetable-route-compiler.mjs) | `routePair` und `anchorEvidence` finden die konkreten Anker jedes aufeinanderfolgenden Haltepaares | Anker beim Zusammenführen der Route als geordnete, gerichtete Haltpositionen erhalten und signiert exportieren |
| [Weltcompiler](../tools/region-import/build-alpha-world.mjs) und [Bewegungsbindung](../tools/region-import/movement-route-allocation-v2.mjs) | Signierte Fahrt-/Formations-/Abschlussbindungen, `scheduledDepartureMs`, `publicPassengerStop`, Fortsetzungen ganzer Fahrtabschnitte | Exakte Halte an `TrainMaterialization` binden; `routeForLeg` verteilt `positionMm` derzeit gleichmäßig über die Laufweglänge und ist dafür keine zulässige Quelle |
| [Regionaler Worker](../apps/game-api/src/regional-simulation-worker.ts) und [Eventadapter](../apps/game-api/src/operational-domain-event-adapter.ts) | Regionaler Zustand und `appendEvents` werden in derselben DB-Transaktion gespeichert; Welt, Region, Commit und native Ereignissequenz bleiben gebunden | Strikter Decoder der neuen Haltbelege nach dem Muster von [operational-service-outcome.ts](../apps/game-api/src/operational-service-outcome.ts) |
| [Nachfragekern](../crates/zugfolge-demand/src/engine.rs) | `validate_progress`, `frozen_journeys`, `previousEvaluation`, `DemandOperationalProgressV1`: begonnene Abschnitte, Sitze und Tarife bleiben erhalten | Produktiver, kausal vollständiger Belegstrom statt ausschließlich synthetischer Fortschrittsfixtures |
| [DemandService](../apps/game-api/src/demand-service.ts) und [DemandStore](../apps/game-api/src/demand-store.ts) | Gepinnte Poolauswertung, geschütztes Weltjournal, native Replayprüfung und Periodenhorizont | Anfangsauswertung vor Abfahrt, persistenter Belegcursor, Fortschreibung aus bestätigten Ereignissen und Auswahl des aktuellen Abschnitts anhand dieser Belege |

`motion-segment-started` entsteht auch bei gewöhnlichen Geschwindigkeitswechseln.
`motion-segment-ended`, ein Signalhalt und `movement-continued` sind ebenfalls
keine Fahrgasthaltbelege. Die öffentliche `PublicOperationalTrainState`-Projektion
enthält keine solche Semantik. Weder ihre Position noch eine Sollzeit oder ein
Verspätungsaufschlag darf diese Lücke durch einen erfundenen Ist-Zeitpunkt füllen.

## 2. Zu implementierende Verträge

Die folgenden JSON-Feldnamen gelten an der TypeScript-/Rust-Grenze. Zeitwerte
sind sichere ganze Millisekunden seit Weltepoche, Positionen ganze Millimeter;
Rust verwendet die entsprechenden geprüften Integer-Typen. Unbekannte Felder,
inkonsistente Pins und unvollständige Zuordnungen werden abgelehnt.

**`OperationalPassengerStopPlanV1`**, Schema
`zugfolge-operational-passenger-stop-plan/v1`:

- Kopf: `schemaVersion`, `worldId`, `infrastructureReleaseId`,
  `timetableReleaseId`, `serviceId`, `serviceRunId`, `trainRunId`,
  `routeVersionId`, `sourceBindingHash`.
- `stops`: geordnete Liste mit `stopId`, `stationId`, `stopSequence`,
  `routeMm`, `platformId`, `scheduledArrivalMs`, `scheduledDepartureMs`,
  `minimumDwellMs`. Ein Eintrag bezeichnet ausschließlich einen Fahrgasthalt.
- `stopId` bezeichnet das eindeutige Haltvorkommen dieses Zuglaufs und muss dem
  Halt in `TrainServiceV1` entsprechen; wiederholte Besuche derselben Station
  behalten verschiedene Haltkennungen. `stopSequence` beginnt bei null.
- `routeMm` ist die Halteposition der Zugspitze, abgeleitet aus dem gerichteten
  Gleisanker. Der signierte Plattform-/Gleisbezug und die Formation müssen eine
  zulässige Haltlage belegen. Fehlt diese Evidenz, bleibt die Bindung unzulässig.
  Halte mit identischen Positionen dürfen nicht unbemerkt verschmolzen werden.
- `stopPlanHash` ist die kanonische SHA-256-Prüfsumme des vollständigen Plans
  und wird in Initialisierung, Zustand und Belegen referenziert. Die Liste ist
  durch ein explizites Release-Limit begrenzt; der Compiler prüft zusätzlich
  die bestehenden Gesamtgrenzen für Zugläufe und Nachfrageabschnitte.

**`OperationalPassengerStopReceiptV1`**, Schema
`zugfolge-operational-passenger-stop-receipt/v1`:

- `schemaVersion`, `worldId`, `serviceRunId`, `trainRunId`, `stopId`,
  `stopSequence`, `stopPlanHash`, `routeVersionId`, `formationVersionId`,
  `kind` (`arrival` oder `departure`), `actualTimeMs`, `receiptId`.
- Das vorhandene Journal bindet außerdem `regionId`, `commitSequence` und
  `nativeEventSequence`; Decoder prüfen `actualTimeMs == event.atMs` und
  `trainRunId == event.subjectId` sowie sämtliche Welt-/Releasebezüge.
- `receiptId` entsteht deterministisch aus Welt, Fahrt, Haltvorkommen und Art.
  Derselbe Beleg muss nach Restore oder Regionsübergabe dieselbe Identität
  besitzen. Ein Duplikat mit anderem Zeitpunkt oder Bindung ist ein Fehler.
- Die Belege enthalten keine Fahrgastschlüssel, Seeds oder verdeckten
  Fahrberechtigungen. Der Nachfrageconsumer projiziert ihre Fakten in den
  bestehenden `DemandOperationalProgressV1`; er berechnet keine eigene Wahl,
  Belegung oder Fahrberechtigung in TypeScript.

Der native Zugzustand benötigt zusätzlich den Planbezug, den nächsten
Haltindex, eine aktive Ankunft mit Zeitpunkt und den bereits bestätigten
Fortschritt. Diese Daten gehören in Zustands- und Handoverhash. Das Journal
behält die unveränderlichen Belege; Snapshots behalten nur die begrenzten
Fakten, die für die aktive Fahrt und eine idempotente Fortsetzung nötig sind.

**`DemandProgressCursorV1`**, Schema `zugfolge-demand-progress-cursor/v1`,
ergänzt einen versionierten Nachfragecheckpoint um `schemaVersion`, `worldId`,
`initialCheckpointSequence`, `throughWorldSequence`, `safeThroughMs`,
`receiptSetHash` und `regions`. Jeder Regionseintrag enthält `regionId`,
`commitSequence`, `nativeEventSequence` und `completeThroughMs`. Die Weltsequenz
referenziert `domain_events.sequence`; der Belegsethash bindet die kanonisch
sortierten übernommenen Haltbelege. Regionsliste und Belegmenge bleiben durch
den gepinnten Pool und seine freigegebenen Grenzen beschränkt. Alte
Forecast-Checkpoints bleiben lesbar, erhalten aber keinen erfundenen Cursor.

## 3. Implementierungsreihenfolge

1. **Bindungen und Vorprüfung.** Der Routencompiler bewahrt die tatsächlich
   gewählten Anker und ihre kumulierten Positionen auch über `mergeLegs`.
   Der Weltcompiler verbindet diese mit Haltevorkommen, Plattform, Tageslauf
   und einmalig umgerechneten Fahrplanzeiten. Die neue Bindung wird Bestandteil
   des signierten Initialisierungskorpus. Ergänzungen erfolgen konsistent in
   [Operational-Runtime](../crates/zugfolge-sim-runtime/src/operational_runtime.rs),
   [nativem TypeScript-Vertrag](../packages/runtime-native/src/operational-simulation.ts)
   und `TrainMaterialization`; eine fehlgeschlagene Vorprüfung mutiert nichts.

2. **Echte Haltereignisse.** `plan_motion` behandelt den nächsten Fahrgasthalt
   als zusätzliches Brems- und Ereignisziel innerhalb der vorhandenen
   Fahrberechtigung. Ankunft entsteht erst an der gebundenen Haltlage bei
   Geschwindigkeit null. Dwell und Abfahrtsfreigabe benutzen diese tatsächliche
   Ankunft sowie den gepinnten Mindestaufenthalt und die Sollabfahrt. Abfahrt
   entsteht einmal beim nativen Übergang vom freigegebenen Halt in die Bewegung;
   ein bloßes Dispatch-Kommando reicht nicht. Die Originallage benötigt einen
   bestätigten nativen Haltzustand vor ihrer ersten Abfahrt. Ein Signalhalt
   erfüllt den Plan nicht. Fahrstraßensicherung und Konfliktgrenzen gelten weiter.

3. **Atomare Speicherung und Decoder.** Die neuen nativen Ereignisse durchlaufen
   denselben Commitpfad wie `train-outcome`. Der strikte Adapter erhält nur
   bestätigte Fakten; ungültige Belege verhindern den Commit. Die Welt- und
   Typindizes des bestehenden Journals bleiben der Einstieg für begrenzte
   Abfragen. Ein zweiter Bewegungszustand in der Nachfrageplattform entfällt.

4. **Kausale Anfangsauswertung und Consumer.** Vor der ersten tatsächlichen
   Abfahrt eines Pools werden Release, Seed, vollständige `generationWindows`
   und das zu diesem Zeitpunkt bestätigte Angebot nativ ausgewertet und als
   Anfangscheckpoint persistiert. Die Abfahrtsverarbeitung muss diesen
   Anfangscheckpoint voraussetzen. Erst danach werden nichtleere Haltbelege
   mit `previousEvaluation` fortgeschrieben: Der Kern lehnt Fortschritt ohne
   vorherige Auswertung bereits heute ab. Ein erst nach der Abfahrt berechneter
   Forecast ist kein Ersatz für diese Anfangsbelegung.

   Der Consumer verarbeitet Haltbelege und wirksame Angebots-/Störungsänderungen
   an ihren bestätigten Zeitgrenzen mit dem dort gültigen Angebot. Ein einzelner
   30-Sekunden-Endsnapshot darf zwischenzeitliche Abfahrten und Ausfälle nicht
   übergehen. Gleichzeitige Fakten werden vollständig gesammelt, bevor die
   Nachfrage diesen Zeitpunkt überschreitet. Journalcursor, Eingabepins,
   Fortschrittsbeleg und neue Auswertung werden unter dem bestehenden Weltmutex
   atomar gespeichert. Die Cursorfortschreibung ist auch bei einem inhaltlich
   unveränderten Manifest dauerhaft und idempotent.

5. **Öffentliche Projektion.** `DemandService.manifest` verwendet bestätigte
   Abfahrt/Ankunft zur Auswahl des tatsächlich befahrenen Abschnitts. Am Halt
   bleiben bestätigte Aussteiger, Durchreisende und erst vorgesehene Einsteiger
   unterscheidbar; die bisherigen prognostizierten Abfahrtsintervalle reichen
   dafür nicht. Nur belegte Abschnitte werden als tatsächlicher Bestand
   bezeichnet. Zukünftige Abschnitte bleiben Prognosen, auch wenn das
   Gesamtergebnis `projectionMode = progress_bound` trägt. Verdeckte FareFacts
   bleiben im geschützten serverseitigen Manifest.

## 4. Restore, Regionen und Perioden

- **Start nach Unterbrechung:** Der letzte Checkpoint wird nativ mit seinen
  gespeicherten Eingaben geprüft; der Consumer liest anschließend ausschließlich
  den noch nicht bestätigten Journaltail. Ohne Anfangscheckpoint ist ein
  Wiederaufbau nur aus dem vollständigen gepinnten Anfangsinput und der
  vollständigen Ereignishistorie zulässig. Fehlt beides, bleibt die tatsächliche
  Manifestprojektion nicht verfügbar. Ein heutiger Betriebsstand darf keine
  historische Anfangsbelegung nachträglich festlegen.
- **Zeitgrenze mehrerer Regionen:** Der Worker prüft bereits einen monotonen
  Weltstand beim regionalen Commit. Das beweist allein noch nicht, dass alle
  relevanten Regionen ihre älteren Haltbelege geliefert haben. Der Consumer
  benötigt deshalb einen persistierten sicheren Verarbeitungsstand der am Pool
  beteiligten Regionen einschließlich laufender Handovers. Er darf `asOfMs`
  erst über einen Zeitpunkt bewegen, wenn deren Journaltails bis dahin
  vollständig sind. Stille oder verzögerte Regionen erfordern Rückstau statt
  angenommener Ereignisfreiheit; Empfangszeit ist keine Simulationszeit.
- **Handover und Laufwegwechsel:** Der bestehende native Eigentumsübergang
  überträgt Haltindex, Planhash und bestätigten Fortschritt. Nur der bestätigte
  Besitzer emittiert neue Belege. Laufwegnachfolger benötigen eine neu geprüfte
  Bindung ihrer künftigen Halte; gefahrene Präfixe und ihre Kennungen bleiben
  unverändert. Eine Fortsetzung mit neuer `trainRunId` erhält eine explizite
  Fahrtzuordnung und darf keine neue Kopie bereits Reisender erzeugen.
- **Kapazität und Release:** Abgefahrene Abschnitte behalten Identitäten, Sitze
  und gebuchten Tarif. Änderungen der Formation benötigen belegte künftige
  Kapazitäten. Ein Ausfall während der Fahrt erlaubt ohne bestätigte
  Ausstiegslage keinen erfundenen Ausstieg. Der bisherige Pool und sein Pin
  bleiben erhalten, solange tatsächliche Reisen laufen; eine prognostizierte
  Endzeit darf sie beim Periodenwechsel nicht beenden. Der bestehende
  Aufschub des Folgepools ist entsprechend an diese Belege zu binden.

## 5. Vollständiger nativer Drei-Halt-Nachweis

Der Abnahmetest verwendet einen gekennzeichneten, signiert gebundenen
Drei-Halt-Korpus A–B–C mit echten Gleisen, Plattformen, Fahrzeug-/Kapazitätsdaten
und einer Anschlussfahrt ab B. Die **Belege selbst** entstehen ausschließlich
im gebauten nativen Operational-Addon aus Bewegungs- und Störungskommandos.
Handgeschriebene `operationalProgress`-Objekte beweisen diesen Pfad nicht.

| Nachweis | Erwartung |
|---|---|
| A: Anfangscheckpoint, Haltfreigabe, tatsächliche Abfahrt | Erste belegte Abschnittsbelegung ist auf vorher festgelegte Kohorten zurückführbar; noch kein Ist-Beleg allein durch Erreichen der Sollzeit |
| Zusätzlicher Signalhalt zwischen A und B | Keine Fahrgasthaltquittung, kein Ein-/Ausstieg und keine neue Fahrgastidentität |
| B: tatsächliche Ankunft, Aufenthalt, Abfahrt; anschließend C | Aussteiger nach B, Durchreisende nach C und neue Einsteiger in B erhalten exakte Summen; kein Fahrgast wird zweimal gezählt; Mindestaufenthalt und früheste Abfahrt gelten nativ |
| Verzögerte Ankunft in B nach tatsächlicher Anschlussabfahrt | Anschlussverlust folgt aus Ist-Ankunft plus Mindestumstieg gegen Ist-Abfahrt; nur der künftige Reiseanteil ändert sich, gefahrene Präfixe, Schlüssel, Sitze und FareFacts bleiben bitgleich |
| Ausfall vor Abfahrt sowie während besetzter Fahrt | Vor Abfahrt keine eingefrorenen Reisenden; während der Fahrt keine Verlagerung ohne tatsächlichen Ausstiegsbeleg |
| Restore während A–B und während Aufenthalt B | Identische native Belege, Zustandshashes und Nachfrageergebnisse wie ohne Unterbrechung |
| Absturz nach Betriebscommit/vor Nachfragecommit sowie nach Nachfragecommit | Tail wird vollständig nachgeholt; wiederholte Zustellung verändert keine Summen; widersprüchliche Duplikate werden abgelehnt |
| Handover bei laufender Fahrt, zweite Welt mit gleichen lokalen IDs | Genau ein Belegproduzent; keine doppelte Belegung und keine Sichtbarkeit oder Mutation in der anderen Welt |
| Fahrtende nach Periodengrenze, manipulierter Plan-/Releasepin | Alter Pool bleibt bis zum bestätigten Reiseende gebunden; unzulässiger Pinwechsel und falsche Quellenbindung scheitern geschlossen |

Der Integrationsnachweis muss den vollständigen Pfad **signierter Import →
natives Regional-Addon → atomarer Worker-Commit → Journalconsumer → natives
Nachfrage-Addon → persistierter Restore → geschützte HTTP-Projektion** ausführen.
Zusätzlich werden die vorhandenen Rust-Eigenschaftstests für Erhaltung,
Determinismus und unabhängige Fahrberechtigungsfakten weiter ausgeführt.
Ein Linux-CI-Lauf mit beiden gebauten Addons und archiviertem Testbericht ist
der Abschlussbeleg; ein übersprungener Native-Test oder ausschließlich der
Rust-CLI-Pfad genügt für diese Integration nicht.

## 6. Dokumentation beim Abschluss

[personenverkehr.md](personenverkehr.md), [betriebsengine.md](betriebsengine.md),
[glossar.md](glossar.md) und [M10-Abgleich](m10-issue-verknuepfung.md) erhalten
die implementierten Verträge und den reproduzierbaren Nachweis. Bis dahin
lautet der Status präzise: **Native Fahrtabschlussbelege existieren bereits.
Für #210 fehlen noch signierte Zwischenhaltbindungen, native Ankunfts- und
Abfahrtsbelege sowie deren persistenter Nachfrageconsumer.** #518 kann den
Abschlussbelegpfad weiter ausbauen; es ist kein externer Blocker dieser Arbeit.
