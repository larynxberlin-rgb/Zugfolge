# Autoritative Betriebsengine

Kanonischer Fach- und Laufzeitvertrag für die exakte Betriebswirklichkeit
hinter LiveMap und RZÜ. Entscheidung: E31 / ADR-0032. Die allgemeinen
Systemgrenzen stehen in `architektur.md`, Infrastrukturbegriffe in
`infrastruktur.md`, Fahrzeuge/Rangieren in `betrieb.md` und Ursachen/Kalibrierung
in `stoerungen.md`.

## 1. Bestands- und Ablöseanalyse

| Bisheriger Produktionspfad | Tragfähiger Bestandteil | v2-Ablösung |
|---|---|---|
| `zugfolge-sim`: Wegpunkte, globale `position_mm`, Sekundenzeit, lineare Interpolation | reiner Kern, Event-Log, deterministischer Hash, Materialisierungsfenster | gerichtete Kanten, Laufwegversion, Millisekunden, analytische Abschnitte, Spitze/Schluss und Intervalle |
| `Command::AddDelay` und `ApplyDisruption { delay_seconds }` | Ursachen- und Providerkatalog außerhalb des Kerns | konkrete Ressourcen-/Fahrzeugänderung; Verspätung nur abgeleitet |
| `VirtualDispatcher` mit angelieferten Reservierungen und Sicherheits-Booleans | deterministische Priorisierungsdimensionen und Erklärungen | atomare Sicherungslogik leitet alle Voraussetzungen selbst ab; FDL priorisiert nur sichere Kandidaten |
| `ShuntingRequirement`: Zeit plus kurze Anlagenbelegung | automatische Bedarfsableitung, Formations- und Anlagenfachlichkeit | echte Rangierbewegung mit eigener Fahrberechtigung in derselben Engine |
| regionaler v1-Runtimezustand rekonstruiert Waypoint-Simulation aus Kommandolog | welt-/regionsgebundener Single-Writer, Commit vor Fanout, idempotente Befehle | v2-Checkpoint plus Event-Tail des `OperationalWorld`; v1-Zustand wird nicht migriert |
| TypeScript-Kartenprojektor: `mapPosition` oder `mapEstimate` | releasegebundene E7-Geometrie, Snapshot/Delta, Weltisolation | ausschließlich exakte Position; serverautorisierter Abschnitt bis `valid_until`, danach Freeze |
| Client interpoliert zwischen zwei empfangenen Samples | vorhandener GPS-artiger LiveMap-Stil | analytische Auswertung des Serverabschnitts; keine Extrapolation und kein Geometriesprung |

Der Altpfad ist kein Rollback innerhalb einer v2-Welt. Ein Rollback setzt das
gesamte Deployment auf seinen getrennten v1-Datenstand zurück. Dynamische
Zustände werden in keine Richtung übersetzt.

## 2. Unveränderliche Eingaben

Ein operatives `InfraRelease` enthält zusätzlich zum Betriebsgraphen:

- gerichtete Gleiskanten samt ganzzahliger Länge und E7-Kartenpolylinie;
- topologische Knoten, Blöcke und Freimelde-/Freigabegrenzen;
- Signale mit Richtung, Weichen mit zulässigen Lagen, Grenzzeichen und
  Rangiergrenzen;
- Fahrstraßenvorlagen mit Fahrweg, Durchrutschweg, Flankenschutz,
  Schutzabständen, Ausschlüssen, Fahrberechtigungsende und
  zugschlussbezogener Auflösegrenze;
- Geschwindigkeits-, Neigungs-, Elektrifizierungs- und Zugsicherungsprofile;
- Bahnsteiggleise und nutzbare Intervalle, sichere Halte-/Überholpunkte,
  Regionsgrenzen sowie ein statisches RZÜ-Layout;
- je Element eine interne Herkunft, Rechtefreigabe und Ableitungsregel.

Fehlende betriebliche Elemente darf nur der Offline-Releasecompiler mit einer
versionierten deterministischen Regel erzeugen. Herkunft bleibt intern und
wird öffentlich nicht gekennzeichnet. Eine Welt pinnt das gesamte Artefakt bis
zum sicheren Fahrplan-/Weltwechsel.

Eine `RouteVersion` ist eine lückenlose Folge konkreter gerichteter Kanten.
Wiederkehrende Läufe teilen eine Vorlage. Eine Abweichung erzeugt am sicheren
Übergabepunkt eine unveränderliche Nachfolgeversion; der bereits gefahrene
Weg bleibt historisch und geometrisch unverändert. Ohne vollständigen Laufweg
keine Materialisierung.

Neue explizite Fahrzeugtypen benötigen Länge, Masse, Vmax und den vollständigen
Rohdynamikblock aus `brakeWeightKg`, `maximumAccelerationCapMmps2`,
`serviceBrakeCapMmps2` und `emergencyBrakeMultiplierBasisPoints`; angetriebene
Typen zusätzlich Leistung und Anfahrzugkraft. Die typbezogenen
Beschleunigungs-, Betriebs- und Schnellbremswerte bleiben nur reproduzierbare
Referenzwerte. Bei einer konkreten Formation entstehen die wirksamen Werte
stattdessen aus Gesamtmasse, wirksamer Gesamt-Anfahrzugkraft und
Gesamtbremsgewicht. Ein teilweise vorhandener Rohblock oder eine Abweichung des
Referenzwerts scheitert fail-closed; nur vollständig alte Typmetadaten bleiben
im geschlossenen Legacy-Pfad lesbar. Diese Pflichtfelder werden nicht als
zweite Betriebsdatenbank gepflegt: Der Offline-Compiler aus
[`fahrzeugkatalog.md`](fahrzeugkatalog.md) projiziert denselben belegten Typ-
und Assetbestand sowohl in den Fleet-Authority-Release als auch in das
`zugfolge-operational-vehicle-inventory/v2`. Eine Receipt bindet beide
Projektionen; Fleet und Operational leiten Formationswerte erneut ab und
müssen jeden beigelegten Prüfwert reproduzieren. Neue Typen tragen Rolle und physische
Führerstände explizit; die geordnete Formation bestimmt daraus aktive
Zugspitze, Wendezugfähigkeit und wirksame Zugsicherung. Ein ausschließlich aus
nicht angetriebenen Fahrzeugen bestehender Wagenpark bleibt als immobile
Formation zulässig.

## 3. Weltzustand und Einheiten

`OperationalWorld` ist je Welt und Region der einzige Writer. Er enthält:

- physische Fahrzeuge und konkrete technische Einschränkungen;
- unveränderliche Formations- und Laufwegversionen;
- Zugspitze und Zugschluss als Laufwegmillimeter;
- die aktuell geschnittenen Intervalle auf allen berührten Gleiskanten;
- belegte Blöcke, Fahrstraßenlocks, Weichen- und Signalzustände;
- Fahrberechtigungen, analytische Bewegungsabschnitte und Wartegründe;
- konkrete Infrastruktur-/Fahrzeugstörungen;
- Ereigniswarteschlange, Commit-Sequenz und idempotente Befehlskennungen.

Einheiten: `i64` Millisekunden seit Weltepoche, `i64` Millimeter, `u32`
Millimeter je Sekunde, `i32` Millimeter je Sekunde zum Quadrat, Masse in
Kilogramm und Leistung in Watt. Fahrplansekunden werden genau einmal an der
Deploymentgrenze mit 1.000 multipliziert. Geld bleibt `i64` Cent.

Analytische Position für `dt` Millisekunden:

`s = s0 + round_half_away(v0 * dt / 1000 + a * dt² / 2_000_000)`

Zwischenwerte verwenden mindestens 128 Bit. Exakte Halben werden vom Nullpunkt
weg gerundet. Das Ergebnis wird hart am Fahrberechtigungsende begrenzt. Neue
Abschnitte entstehen nur bei Geschwindigkeits-/Kantengrenze, Halt,
Fahrberechtigungs-, Fahrstraßen-, Störungs-, Formations- oder Regionsänderung.
Es gibt weder Sekundentick noch periodischen Vollscan.

## 4. Belegung und Stellwerk

Die belegte Formation ist das Laufwegintervall `[tail, head]`, geschnitten an
allen Kantenübergängen. Getrennte Gruppen dürfen dasselbe Gleis nur mit
disjunkten offenen Millimeterintervallen belegen. Ein Zug bleibt auch während
Laufweg-, Formations- und Regionswechsel in der Rechnung.

Ressourcen folgen `free → route_locked → entered_by_head →
occupied_by_formation → cleared_by_tail → release_pending → free`. Fahrweg,
Durchrutschweg und Flankenschutz werden atomar verriegelt. Ein Aufrufer liefert
nur Zug- und Vorlagenkennung, niemals ein Sicherheitsergebnis. Die
Sicherungslogik prüft selbst:

1. Bewegungstyp und technische Zugsicherung;
2. konkrete Gleis-/Blockintervalle;
3. bestehende Locks und Ausschlüsse;
4. Weichenlage und Weichenstörung;
5. Fahrweg, Schutzabstand, Durchrutschweg und Flankenschutz;
6. Signal-/Freimeldestörung;
7. zulässiges Fahrberechtigungsende.

Signalbegriffe sind Ableitungen. Kein Signal kann Bewegung über die interne
Fahrberechtigung hinaus erlauben. Auflösung erfolgt erst, wenn der Zugschluss
die vorlagengebundene Grenze passiert hat.

## 5. FDL und virtueller Lokführer

Der FDL bekommt nur Kandidaten, deren benötigte Ressourcen geändert wurden.
Er sortiert lexikographisch und versioniert nach: Sicherheit/Zulässigkeit,
bereits verbindlichem Lock, Fahrplan-/Folgeverspätung, Fahrgast/Anschluss,
Vertrag, Netzstabilität, Fahrzeug/Personal, Wiederherstellbarkeit,
Verhungerungsschutz und stabiler Zugkennung. Es entsteht kein gewichteter
Einzelscore. Begonnene oder verriegelte Bewegungen werden nicht zurückgenommen.

Der virtuelle Lokführer leitet Beschleunigen, Beharren und Bremsen aus
Formation, Kantenprofil, Neigung, Fahrberechtigung und Zielhalt ab. Verspätete
Züge nutzen die zulässige Leistung. Pünktliche Personenzüge fahren
vorausschauend, erzeugen aber keinen künstlichen Wartehalt auf freier Strecke.
Nur die veröffentlichte Abfahrt eines Fahrgasthalts ist eine harte
Untergrenze. Güter-, Leer-, Zusatz- und Rangierbewegungen dürfen nach lokaler
Konfliktprüfung früh fahren, erwerben dadurch keinen Vorrang.

## 6. Formationen, Rangieren und Bahnsteige

Kuppeln, Trennen, Teilen, Vereinigen, Verstärken, Schwächen, Lok-/Richtungs-
und Führerstandswechsel erzeugen im Stillstand atomar eine neue
`FormationVersion`. Alle Fahrzeuge behalten ihre Identität. Die Engine leitet
Länge, Masse, Vmax, Leistung, Beschleunigung, beide Bremswerte,
Zugsicherungskompatibilität, Spitze, Schluss und Intervalle neu ab.

Ein Rangierauftrag entsteht aus Formation, Umlauf, Wartung, Abstellung und
Betriebsentscheidung. Rangierplaner, Stellwerk/FDL und Lokführer führen ihn
über echte `shunting`-Bewegungen aus. Spieler geben weder Weichen noch
Einzelschritte vor. Das administrative Reparaturwerkzeug ist capability-
geschützt und append-only auditiert.

Kurzer Bahnsteig `platform-stop/v1`:

- Überhang `o = max(0, train_length - usable_platform_length)`;
- Überhang-Basispunkte `ceil(o * 10_000 / train_length)`;
- zusätzliche Haltezeit: 15 Sekunden je angefangene 1.000 Basispunkte;
- Qualitätsmalus: `overhang_bp * passenger_count / 100`, ganzzahlig abwärts;
- keine pauschale Geldpönale; nur ein konkreter Vertrag darf sie ableiten.

Der reale Überstand bleibt vollständig belegt. Eine Sicherheitsgrenze,
Weiche oder inkompatible Fahrstraße macht den Halt unzulässig. Sonst bevorzugt
der FDL den geeigneten langen Bahnsteig, darf den kurzen aber mit Begründung
wählen.

## 7. Störungen und sichere Grenze

Ursachenkatalog, `DisruptionPolicy`, deterministische Seeds, Kalibrierung,
Provider- und Auditgrenzen aus M8 bleiben. Der Ereignisgenerator terminiert
den nächsten Kandidaten aus Grundquote, Zustand, Laufleistung,
Betriebsstunden, Beobachtungen, Wartung und tatsächlicher Beanspruchung. Alter
ist kein direkter Faktor. Neuberechnung erfolgt nur an fachlichen Änderungen;
die Grundkalibrierung 22/10.000 wird genau einmal angewandt.

Wirkungen sind Ressourcensperrung, eingleisiger Betrieb,
Langsamfahrstelle, Signal-/Stellwerks-/Freimelde-/Weichenstörung oder eine
Fahrzeugeinschränkung an Leistung, Vmax, Beschleunigung, Bremsung,
Zugsicherung, Türen oder Fahrfähigkeit. Nach einer Fahrzeugwirkung wird die
Formation sofort neu berechnet. Sofortmaßnahmen des Lokführers erzeugen
`full`, `restricted` oder `immobile`; erst danach greifen Spielerregeln für
die Betriebsfolge. Aufhebung verlangt Providerrevision, Werkstattfreigabe oder
anderen autoritativen technischen Nachweis.

Widerspruch oder Ungewissheit bedeutet immer: Fahrberechtigung am letzten
garantierten Punkt beenden, Geschwindigkeit null, Belegungen und Locks
erhalten, Signale Halt, Diagnose veröffentlichen. Unfälle werden nicht
simuliert.

## 8. Persistenz, Region und Projektion

Persistiert werden Befehle, Entscheidungen, Locks/Fahrberechtigungen,
Bewegungsabschnitte, Formationen, Störungen, technische Zustände,
Regionsübergaben und kompakte Checkpoints. Format `operational-checkpoint/v2`,
standardmäßig nach 50.000 persistierten Ereignissen oder 15 Minuten Weltzeit,
je nachdem was zuerst eintritt. Batchgrenze 4.096 Befehle. Änderung dieser
Werte ändert das Persistenzschema, nicht die Simulationsergebnisse.

Checkpoint plus Event-Tail muss denselben `operational-world/v2`-Hash ergeben.
Schlafende öffentliche Welten holen über die fällige Ereigniswarteschlange bis
zur 1:1-Weltzeit auf. Testwelten dürfen einen expliziten anderen Zeitvertrag
nutzen.

Eine Regionsübergabe hält Grenzressourcen vom Prepare bis zum bestätigten
Accept. Die Quelle entfernt erst nach Bestätigung; dadurch existiert während
des Protokolls eine geschützte, identische Übergabekopie, aber niemals zwei
bewegliche Autoritäten. Statische Releases werden geteilt, dynamischer Zustand
nicht.

LiveMap und RZÜ werden aus demselben Commit erzeugt. Snapshot und lückenlose
Deltas tragen Welt, Region, Commit, Simulationszeit, Laufweg-/Formationsversion,
Spitze/Schluss, Intervalle, Bewegungsabschnitt, `valid_until` und
Fahrberechtigungsende. Korridorfilter sind verpflichtend; leere Filter sind
nur für eine ausdrücklich aggregierte Deutschlandübersicht zulässig. Der
Stream-Heartbeat beträgt fünf Sekunden. Ein committed Regionszustand wird bei
dem produktiven 60-Sekunden-Scheduler nach 75 Sekunden als stale behandelt;
die zusätzlichen 15 Sekunden sind ausschließlich Transporttoleranz und keine
Extrapolationsfreigabe. Sequenzlücke oder überschrittene Stale-Grenze erzwingt
Freeze und Snapshot-Reset.

## 9. RZÜ und öffentliche Grenze

Die LiveMap behält Basiskarte, Farben, Symbole, Bedienung und Pop-ups. Ihr
Marker sitzt auf der exakten Zugspitze; hohe Zoomstufen dürfen Schluss und
Intervall ergänzen. Die RZÜ ist eine zusätzliche vollständig lesende
schematische Sicht mit Übersicht und Expertenebene. Sie zeigt Zugnummer,
Spitze/Schluss, Richtung, Geschwindigkeit, Fahrplanlage, Belegungen, grüne
Fahrberechtigungen/Fahrstraßen, Signale, Wartegrund und erwartete Freigabe.
Sie ist kein Stellwerk und kopiert keine geschützte Produktoberfläche.

Öffentlich sind nur wirksame Zustände. Reserven, unveröffentlichte
Spielerentscheidungen, interne Regeln, verworfene Varianten und die Herkunft
real/generiert bleiben privat.

## 10. Cutover- und Abnahmegates

Der produktive Wechsel ist nur freigegeben, wenn alle Gates gleichzeitig
grün sind:

1. signiertes vollständiges v2-Deployment; keine v1-Waypointinitialisierung;
2. Invarianten-, Rangier-, Störungs-, Plattform-, Replay- und Regionssuite;
3. LiveMap/RZÜ-Commitgleichheit, `valid_until`-Freeze, Sequenzreset und
   visueller LiveMap-Baselinevergleich;
4. reproduzierbarer Vollereignisbenchmark mit 20.000/s Kernziel,
   1.000/s Designpeak und 5.000/s über zehn Minuten;
5. p99 Queue < 250 ms, Commit-zu-Client < 750 ms und Catch-up ≥ 50×;
6. beobachteter Ressourcenverbrauch bei 4.000–5.000 gleichzeitig fahrenden
   Zügen und 120.000–180.000 materialisierten Läufen;
7. dokumentierter Restore-, Fail-safe- und Rollbackdrill.

Synthetische Altbenchmarks ohne Stellwerk, Bewegung und Rangieren sind kein
Nachweis. Fehlende qualifizierte deutschlandweite operative Infrastrukturdaten
oder nicht vollständig belegte Fahrzeugpflichtdaten sind echte externe
Datenblocker und dürfen nicht durch Laufzeitannahmen verdeckt werden.

Der reproduzierbare Kernlauf und seine bewusst getrennten offenen Systemgates
stehen in `betriebsengine-lastnachweis.md`.
