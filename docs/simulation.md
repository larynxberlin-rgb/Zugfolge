# Simulationskern und Livemap (M4)

## 1. Kernvertrag und Zeit

`zugfolge-sim` ist ein regionaler Single-Writer. Der Konstruktor bindet Welt,
Region, Materialisierungsfenster und die **explizite** Simulationszeit. Nur
`Command` gelangt hinein, ausschließlich sequenzierte `DomainEvent`s gelangen
heraus. Der Kern kennt keine Uhr, Datenbank, Netzwerkverbindung oder
Gleitkommazahl. `AdvanceTo` lehnt Zeitreisen ab. Eine nach Zeitpunkt, Zug,
Wegpunkt und Ereignisart geordnete Queue verarbeitet auch bei großen
Zeitsprüngen **jedes** Zwischenereignis mit seinem tatsächlichen Zeitpunkt.

Ein `TrainRun` existiert vollständig nur 48 bis 72 Stunden im Voraus. Sein
Fahrweg besteht aus monotonen Wegpunkten mit Ankunft, Abfahrt,
Mindesthaltezeit und ganzzahliger Position. Zwischen zwei Wegpunkten wird die
Position analytisch aus Strecke und Simulationssekunde ermittelt.
`RollingMaterializer` erzeugt aus kompakten `ServiceTemplate`s nur neue
Fahrten im rollierenden Fenster; `dematerialize_before` entfernt beendete
Fahrten wieder.

## 2. Fortpflanzung und Disposition

`propagate_delay` trennt drei fachliche Größen: Fahrzeitreserve,
Haltezeitreserve und Anschlusswartezeit. Die ersten beiden bauen eine bereits
vorhandene Verspätung ab. Eine gesicherte Verbindung erhöht den Abgang höchstens
bis zur veröffentlichten Anschlusswartezeit. Ursachen erzeugt der Kern nicht;
das bleibt M8.

Vor jeder Weiterfahrt ruft der Kern `Dispatcher::decide` auf. Das heutige
`ConservativeDispatcher` verhindert vorzeitige Abfahrten. M7 kann dort eine
Regel-Engine einsetzen, ohne Ereignisschleife oder Zustand aufzuschneiden.

## 3. Regionsübergabe

Die Quellregion erzeugt einen deterministischen Übergabetoken und behält den
Zug. Die Zielregion prüft Welt und Ziel, reserviert die mitgesandten
Konfliktressourcen atomar und materialisiert den Zug. Erst ihr danach erzeugtes
`ConfirmHandover` der exakt bezeichneten Zielregion entfernt ihn aus
dem Quellbestand. Verlorene, doppelte und an die falsche Region gerichtete
Bestätigungen werden abgelehnt. Damit besitzt eine Fahrt niemals unbestätigt
zwei regionale Writer.

## 4. Livemap-Protokoll und Sichtbarkeit

Ein Client beginnt mit `LiveSnapshot` und akzeptiert danach nur das nächste
`LiveDelta` derselben Welt. Eine Sequenzlücke erzwingt einen neuen Snapshot.
Öffentlich sind ausschließlich EVU, Zugart, Zugnummer, Position,
Geschwindigkeit, Verspätung, nächster Betriebspunkt und Status. Vertrag,
Ladung und interne Dispositionsdaten sind nicht Teil von `PublicTrain`.

`packages/livemap` materialisiert die Deltas je Welt und verteilt sie an
beliebig viele Abonnenten. Die Game-API stellt einen Initialsnapshot und einen
SSE-Strom mit Sequenzkennungen bereit; der Client lädt bei einer Lücke selbst
einen neuen Snapshot. `apps/livemap` interpoliert höchstens zehn Sekunden
voraus und zeigt Zuglaufdetails. Der Normalzustand ist achromatisch;
Gelb bezeichnet eine betriebliche Abweichung. Das Netz tritt gegenüber den
Zügen zurück. `tools/tiles/build-pmtiles.mjs` baut aus genehmigten lokalen
GeoJSON-Artefakten eigene PMTiles. Das ausgeschlossene Netz wird in einem
separaten, blassen Kontextlayer geführt; kein öffentlicher Kacheldienst ist
Laufzeitabhängigkeit.

## 5. Replay, Zeitumstellung und Lastbeweis

Das append-only Kommandolog ist die Eingabe für `replay`. `worldEventLog`
schreibt lückenlose Batches atomar; ein eindeutiger Index auf Welt und Sequenz
verhindert doppelte Ereignisse. Kanonische Ordnung
über `BTreeMap`, explizite Zeit und lückenlose Eventsequenzen liefern für das
gleiche Log einen bitgleichen Zustand. Der Golden-Master
`simulation-24h.hash` wird in der Linux-/Windows-CI geprüft. Lokale Zeit wird als Unix-Sekunde plus
explizitem UTC-Offset dargestellt. So sind die doppelte Herbststunde und die
fehlende Frühlingsstunde eindeutig; laufende Züge und Fahrplanperioden bleiben
auf der monotonen Weltzeit und werden bei einer Zeitumstellung nicht versetzt.

Der automatisierte Stabilitätsbeweis materialisiert 200 Züge, lässt sie 24
Simulationsstunden laufen und prüft ihren Endzustand. Der äußere Harnisch
`cargo run -p zugfolge-load --release` materialisiert standardmäßig 180.000
Fahrten, verarbeitet mindestens zwei Millionen Ereignisse und misst gegen 200
Ereignisse pro Sekunde. Nur der Harnisch liest die Wanduhr; der Kern erhält
weiterhin ausschließlich explizite Simulationszeit.
