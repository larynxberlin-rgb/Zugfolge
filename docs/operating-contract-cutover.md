# Aktuelle Betriebsbindung aus M6 und M5

Quellenprüfung zu [Issue #518, Teil D](https://github.com/larynxberlin-rgb/Zugfolge/issues/518),
Stand 07.09.2026. Der vorhandene produktive Pfad und die noch fehlende
Übergangsgrenze werden getrennt beschrieben. Diese Prüfung erzeugt weder
einen Betreiberwechsel noch eine neue Vollständigkeitsfreigabe.

## Vorhandene autoritative Quellen

| Gegenstand | Vorhandener Produzent und tatsächliche Bindung |
|---|---|
| Ursprüngliche Spielfahrt und Los | [build-alpha-world.mjs](../tools/region-import/build-alpha-world.mjs) übernimmt die erzeugte `game-trip`-Kennung in `planning.snapshot.patterns[].journeys[].id`. [alpha-world-start.ts](../apps/game-api/src/alpha-world-start.ts), `validateAlphaOperationalPlanningBinding`, prüft dieselbe Kennung gegen `serviceOutcome.serviceId`, das Los, die ursprünglichen Haltzeiten und den Diensttag. Die weiterhin GTFS genannten Transporttypen bedeuten hier keinen Join anhand eines Bahnhofnamens oder einer fremden Referenzfahrt. |
| M6-Vertrag | [workflow.ts](../packages/economy/src/workflow.ts), `completeMobilization`, speichert den aus dem Zuschlag entstandenen Vertrag mit `worldId`, `lotId`, `operatorId`, `startsAt`, `endsAt` und Qualitätszusagen. |
| Tatsächlicher Betriebsübergang | [runtime.ts](../packages/economy/src/runtime.ts), `trainRunsForLot` und `applyOperatingTransition`, übergeben die originalen Fahrtkennungen und den geprüften M5-Mobilisierungsbeleg an [zugfolge-runtime](../crates/zugfolge-runtime/src/lib.rs). Der native Übergang bindet jede Fahrt an Betreiber und `formationId`; er erzeugt `train-operation-assigned` mit tatsächlichem `atS`. |
| Dauerhafte M6-Revision | [state-store.ts](../packages/economy/src/state-store.ts), `persistEconomyTransition`, schreibt `operatingRuntimeByLot` und originale Runtimeereignisse atomar und weltgebunden. Im nativen Zustand bleiben die verarbeiteten Kommandos mit Ergebnisrevision und Originalereignissen erhalten. Der aktuelle Kopf allein ist trotzdem kein Nachweis dafür, dass seine Zuordnung bereits vor einem späteren Übergang galt. |
| Tatsächlicher M5-Zustand | [fleet-native-producer.ts](../packages/economy/src/fleet-native-producer.ts), `loadFleetProducerCheckpoint`, lädt den zuletzt gemeinsam gespeicherten Flottenzustand, Zustandshash, Mobilisierungssnapshot und Snapshothash. `verifyFleetWorldState` ist die native Prüfgrenze. Formationen haben konkrete Fahrzeugkennungen, Betreiber und Verfügbarkeit; Personal- und Trassenbelege besitzen eigene Gültigkeiten. |
| Physische Zugfolge | [world-deployment-runtime.ts](../apps/game-api/src/world-deployment-runtime.ts), `boundaryCommands` und `physicalFormationVersionId`, instanziieren das signierte Betriebsprogramm. Die Tagesumlaufpermutation bindet Nachfolgen an dieselben tatsächlich weiterfahrenden Fahrzeuge. |

Der exakte Service-/Los-Join des aktuellen Alpha-Produzenten ist somit
vorhanden. Für ältere oder abweichende Quellprogramme darf er nicht anhand
ähnlicher Zeichenketten nachgebildet werden.

## Nachgewiesene fehlende Anbindung

`ActiveWorldDeploymentRuntime` liest beim Erzeugen einer Zeitgrenze weiterhin
den signierten ursprünglichen Betreiber, die ursprüngliche Abschlussbindung
und die ursprüngliche physische Fahrzeugfolge. Der Katalog übernimmt dabei
keine spätere `operatingRuntimeByLot`-Revision und keinen späteren
Flottencheckpoint. Die veröffentlichten Betriebsmarkierungen ersetzen diese
Übernahme nicht.

Außerdem werden Nachfolgen bereits vor ihrer tatsächlichen Abfahrt in der
nativen Queue angelegt, auch über eine Tagesgrenze hinweg. Der native
[Operational-Kern](../crates/zugfolge-sim/src/operational.rs) prüft, dass die
Formationsversion einer Nachfolge zur physischen Formation ihres Vorgängers
passt. Das Ersetzen einer späteren `formationId` durch eine andere
`formationVersionId` wäre daher kein bloßer Vertragswechsel: Ohne tatsächliche
örtliche Übergabe beziehungsweise Rangierbewegung würde es Fahrzeugpositionen
und Belegungen erfinden.

Die neue
[Tagesplan- und Abschlussbasis](../crates/zugfolge-sim/specifications/operational-service-days-v1.json)
bindet die vollständige ursprüngliche Tagesmenge. Ihre
`ServiceDayPolicy` wird am signierten Start gesetzt; spätere Instanzen und
bereits eingeplante Nachfolgen müssen zu dieser Quelle passen. Sie besitzt
noch keine atomare `replace`-/`rebind`-Grenze für M6-Vertragswechsel.
Auch bei unverändertem Fahrzeugbestand darf die Plattform daher nicht nur
einzelne neue Betreiber- oder Vertragsfelder in eine schon gebundene Queue
schreiben.

## Erforderlicher nächster Produzent

Ein vollständiger Übergang muss aus derselben autorisierten Welttransaktion
die wirksame M6-Revision, den originalen Übergangszeitpunkt, den zu diesem
Zeitpunkt gültigen Vertrag und die nativ geprüften M5-Ressourcen übernehmen.
Der native Übergang benötigt dabei einen expliziten bisherigen Planhash und
eine festgelegte wirksame Zeitgrenze. Er muss noch nicht gestartete
Tagesinstanzen und bereits eingeplante Nachfolgen gemeinsam behandeln.
Bereits gefahrene oder abgeschlossene Instanzen behalten ihre ursprünglichen
Betreiber-, Vertrags- und Kostenbelege.

Die Fahrzeugkontinuität bleibt eine zusätzliche Bedingung: unveränderte
physische Fahrzeuge benötigen eine belegte Betreiber-/Vertragsübernahme;
andere Fahrzeuge benötigen eine tatsächlich mögliche örtliche Übergabe oder
eine native Rangier- und Bereitstellungskette. M5-`formationId` und operative
`formationVersionId` sind verschiedene Bindungen und dürfen nicht allein
wegen ähnlicher Kennungen gleichgesetzt werden. Wiederanlauf und Catch-up
müssen dieselben ursprünglichen Übergänge in derselben zeitlichen Reihenfolge
anwenden; ein späterer aktueller Kopf darf vergangene Tage nicht umschreiben.

Als Nachweis fehlt damit noch die zusammenhängende produktive Folge
M6-Betriebsübergang → geprüfter M5-Zustand → atomarer operativer Planübergang →
tatsächliche Fahrt → Abschluss beim richtigen Betreiber/Vertrag, einschließlich
Queue, Wiederanlauf, Retry und einem realen Formationswechsel. Ein aus
Testdaten direkt ersetztes Planfeld erfüllt diese Grenze nicht.

Teil D bleibt deshalb offen. Diese Quellenprüfung fügt keine zusätzliche
isolierte Sperre hinzu. Die bestehenden Vollständigkeits- und
Vertragsabrechnungsgates bleiben maßgeblich; die nachgewiesene vollständige
ursprüngliche Tagesmenge allein behauptet noch keine allgemeine aktuelle
Betriebsbindung.
