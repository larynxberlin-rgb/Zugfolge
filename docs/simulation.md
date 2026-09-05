# Simulationskern und Livemap (M4)

Dieses Dokument beschreibt technische Simulations- und Übertragungsgrenzen.
Regionen teilen die serverseitige Verarbeitung auf; sie begrenzen nicht das
deutschlandweite Produktziel oder den Startausschnitt der LiveMap. Gestaltung
und Navigation folgen [Design](design.md) und
[Spieleroberfläche](ux-spieler-shell.md).

## 1. Kernvertrag und Zeit

`zugfolge-sim` ist ein regionaler Single-Writer. Der Konstruktor bindet Welt,
Region, Materialisierungsfenster und die **explizite** Simulationszeit. Nur
`Command` gelangt hinein, ausschließlich sequenzierte `DomainEvent`s gelangen
heraus. Der Kern kennt keine Uhr, Datenbank, Netzwerkverbindung oder
Gleitkommazahl. `AdvanceTo` lehnt Zeitreisen ab. Eine nach Zeitpunkt, Zug,
Wegpunkt und Ereignisart geordnete Queue verarbeitet auch bei großen
Zeitsprüngen **jedes** Zwischenereignis mit seinem tatsächlichen Zeitpunkt.

`zugfolge-sim-runtime` ist die persistierbare Produktgrenze dieses Kerns. Sie
initialisiert oder restauriert genau eine Welt/Region, validiert Revision,
Zustandshash und Producer-Sequenz und wendet ausschließlich versionierte
Kommandos mit expliziter Weltsekunde an. Die TypeScript-Plattform darf daraus
keine Deltas erfinden: `RegionalSimulationWorker` schreibt neuen Zustand und
weltgebundene Ereignisse atomar nach `regional_simulation_states` und
`domain_events`; erst nach dem Commit publiziert er an die Livemap.

Die native Zustandsberechnung läuft dabei immer gegen einen unveränderlichen
gelesenen Kopf **außerhalb** einer PostgreSQL-Transaktion. Erst das fertige
Ergebnis öffnet eine kurze Transaktion, sperrt Welt und Region, prüft den
ursprünglichen Hash sowie Revision und Publisher-Sequenz erneut und schreibt
per CAS. Hat ein anderer Writer zwischenzeitlich gewonnen, wird die berechnete
Variante ohne Event oder Fanout verworfen. Damit kann eine langsame Native-
Berechnung niemals als `idle in transaction` Welt- oder Regionssperren halten.

Der Operational-v2-Checkpoint enthält außerdem keine unbeschränkte
Kommandohistorie. Für Idempotenz bleiben exakt die jüngsten maximal 4.096
Quittungen als lückenloses Revisionssuffix erhalten; native Runtime und Worker
verwerfen übergroße, gelochte, doppelte oder falsch gehashte Fenster
fail-closed. Die Größe und Hashkosten des Checkpoints wachsen dadurch nicht mit
der gesamten Laufzeit einer Welt.

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
beliebig viele Abonnenten. Jede Feed-Generation besitzt neben der monotonen
Sequenz eine neue undurchsichtige `streamId`. Der SSE-Cursor
`streamId:sequence` kann deshalb nach Prozessneustart oder TTL-Eviction nicht
versehentlich in eine gleich nummerierte, aber andere Generation fortsetzen.
Snapshot und atomare `subscribeAfter`-Registrierung schließen die
Snapshot/Subscribe-Race; eine begrenzte Queue, Heartbeats und Abort-/Close-
Cleanup verhindern unbegrenztes Wachstum und verwaiste Abonnenten.

Die Game-API authentifiziert Snapshot und Fetch-SSE, prüft Weltzugang und
liefert bei unbekannter oder nicht aus Rust restaurierter Welt bewusst `503`.
Beim Start restauriert sie vor dem Listener ausschließlich Regionen aus
dem verifizierten, signierten Deployment der fest konfigurierten Welt.
Der 1:1-Scheduler berechnet die Weltsekunde aus der gepinnten
Weltepoche und gibt sie explizit an Rust. Ein Cursor einer anderen Generation oder eine Lücke
erzwingt gezielt einen neuen Snapshot. `apps/livemap` interpoliert höchstens
zehn Sekunden voraus, ohne den autoritativen Fachzustand zu verändern, und
zeigt Zuglaufdetails. Die dunkle Deutschlandübersicht verwendet die eigene rote
Gleismarke und die Zustandsfarben aus [Design](design.md): Mint für bekannte
normale Live-Positionen, Amber für wartende Züge oder Verspätungen ab einer
Minute und Hellrot für Ausfälle oder Verspätungen über 15 Minuten.
Text, Minutenwerte und Muster ergänzen Farbe. Fehlende
Verspätungsdaten gelten nicht als Pünktlichkeit; bei unterbrochener Aktualisierung
wird der letzte bestätigte Stand sichtbar. Das Netz tritt gegenüber den Zügen
zurück. Suche, eigener Zugfilter und eine ausklappbare Zugübersicht greifen auf
denselben empfangenen Datenstand zu und erfinden keine Betriebsbewegungen.
`tools/tiles/build-pmtiles.mjs` baut aus genehmigten lokalen GeoJSON-Artefakten
eigene PMTiles. Das ausgeschlossene Netz wird in einem separaten, blassen
Kontextlayer geführt; kein öffentlicher Kacheldienst ist Laufzeitabhängigkeit.

Die internen Regionalrouten akzeptieren nur Initialisierungsfakten und
versionierte Simulationskommandos. Rohzustand, Sequenzkopf und fertige Deltas
sind kein HTTP-Eingabevertrag. Dadurch bleibt der Rust-Worker der einzige
Writer; der generische Eventadapter kann den Livemap-Fachzustand nicht
überschreiben.

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
