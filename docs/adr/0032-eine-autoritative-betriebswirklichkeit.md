# ADR-0032: Eine autoritative Betriebswirklichkeit für LiveMap und RZÜ

Dieses ADR entspricht E31.

- Status: angenommen
- Entscheidung: E31; ersetzt den Laufzeit- und Darstellungsvertrag von E12 und E27
- Kontext: M9-Betriebsreife und anschließender Deutschlandbetrieb

## Kontext

Der bisherige regionale Kern führte Zugläufe über Fahrplan-Wegpunkte in
Sekunden und interpolierte eine globale Millimeterposition. Störungen wirkten
im Produktionspfad überwiegend als hinzugefügte Verzögerungssekunden. Die
öffentliche Kartenprojektion ergänzte davon getrennt entweder eine exakte
Gleisposition oder eine visuelle Schätzung. Stellwerksprüfung,
`VirtualDispatcher`, Formation/Rangierzeit und Kartenprojektion waren fachlich
geeignete Vorarbeiten, aber keine gemeinsame laufende Betriebswirklichkeit.

Diese Aufteilung kann nicht beweisen, dass sichtbare Spitze und Schluss,
belegte Intervalle, Blockfreigabe, Fahrstraße, Signal und Fahrberechtigung zum
selben Commit gehören. Ein angeliefertes `route_is_safe = true` kann außerdem
keine atomare Prüfung des autoritativen Zustands ersetzen.

## Entscheidung

Ein reiner regionaler Rust-Single-Writer führt je Welt genau einen
`OperationalWorld`. Dessen unveränderliche Eingaben sind ein operatives
`InfraRelease`, Fahrzeugtypen und Laufwegvorlagen. Sein Zustand enthält
physische Fahrzeuge, unveränderliche Formations- und Laufwegversionen,
analytische Bewegungsabschnitte, exakte Kantenintervalle, Fahrstraßenlocks,
Fahrberechtigungen, Störungen und eine ereignisgesteuerte Arbeitsmenge.

Interne Einheiten sind Millisekunden, Millimeter, Millimeter je Sekunde und
Millimeter je Sekunde zum Quadrat. Die analytische Gleichung rundet bei halben
Einheiten vom Nullpunkt weg. Autoritative Pfade verwenden keine
Gleitkommazahlen. Der virtuelle Lokführer erzeugt neue unveränderliche
Abschnitte nur an Ereignisgrenzen. Der FDL bewertet nur Kandidaten betroffener
Ressourcen lexikographisch; die Sicherungslogik leitet Freisein,
Weichenstellung, Ausschlüsse, Durchrutschweg und Flankenschutz selbst ab.

Rangierbewegungen verwenden dieselbe Bewegungs-, Intervall-, Stellwerks- und
Fahrberechtigungsengine mit `movement_kind = shunting`. Eine
Zusammenstellungsänderung ist nur im Stillstand möglich und veröffentlicht
atomar eine neue Formation samt neu berechneter Länge, Masse, Leistung,
Bremsung, Spitze, Schluss und Belegung.

Störungen ändern konkrete Ressourcen oder physische Fahrzeuge. Verspätung ist
nur noch eine Ableitung aus tatsächlichem Lauf und Fahrplan. Eine Störung endet
nur durch eine konkrete technische oder externe Freigabe.

LiveMap und RZÜ lesen denselben committed projection record. Der Browser darf
nur den vom Server gelieferten analytischen Abschnitt samt releasegebundener
Geometrie bis `valid_until` auswerten. Danach, bei Sequenzlücke oder
Verbindungsabbruch friert er ein. Es gibt keine Karten- oder RZÜ-Schätzung.

## Harter Wechsel

Der v2-Vertrag wird gemeinsam für Rust-Runtime, native Grenze, API, Snapshot,
Delta und Client aktiviert. Laufende dynamische v1-Zustände werden nicht
übernommen. Eine Welt kann erst unter v2 starten, wenn ihr signiertes
Deployment das vollständige operative `InfraRelease`, Fahrzeugpflichtdaten
und lückenlose Laufwege enthält. Altweltpositionen, `AddDelay`,
`PublicMapEstimate`, Waypoint-Interpolation, produktive Dual-Writes und ein
Fallback auf v1 sind ausgeschlossen.

Der Cutover ist ein Fahrplan-/Weltwechsel:

1. v2-Release offline qualifizieren und signieren;
2. Testwelt aus leerem v2-Zustand starten, Replay, Last und Projektionen prüfen;
3. Schreibannahme für v1 stoppen und letzten v1-Export nur als Auditbeleg sichern;
4. Server, API und Client zusammen auf v2 deployen;
5. neue Welt ausschließlich aus validierten statischen Releases starten;
6. nach der Umschaltung v1-Schemas und alte Positionslogik entfernen.

Ein Rollback stellt das vorherige Deployment und dessen unveränderten
v1-Datenstand wieder her; v2-Ereignisse werden niemals in v1 transformiert.

## Konsequenzen

- Sicherheit begrenzt Durchsatz; Lasttests dürfen Prüfungen nicht abschalten.
- Ein unvollständiges Release oder Fahrzeug gelangt nicht in den Betrieb.
- Nicht beweisbare Zustände verursachen einen sicheren Halt mit erhaltener
  Belegung und sichtbarer Diagnose.
- Statische Geometrie und RZÜ-Layout dürfen releasegebunden geteilt werden;
  dynamischer Zustand bleibt vollständig weltisoliert.
- Checkpoints speichern relevante Betriebszustände, nicht jede gerenderte
  Mikroposition. Checkpoint plus Event-Tail muss denselben Zustands-Hash
  ergeben wie der ununterbrochene Lauf.
- ADR-0027 bleibt historischer Entscheidungsnachweis, ist aber für den
  Laufzeitvertrag durch dieses ADR ersetzt.

## Abgelehnte Alternativen

- Verbesserte Waypoint-Interpolation: keine reale Kanten- oder Zugschlussbelegung.
- Separate RZÜ-Simulation: zweite betriebliche Wahrheit.
- Sicherheits-Booleans vom Aufrufer: umgehbare Stellwerksprüfung.
- Pauschale Verspätungsaddition: keine konkrete betriebliche Wirkung.
- Produktiver Parallelbetrieb: nicht deterministisch abgrenzbare Autorität.
- Positionsschätzung bei Unsicherheit: widerspricht dem sicheren Halt.

## Nachweise

- `crates/zugfolge-sim/src/operational.rs`
- `crates/zugfolge-sim/tests/operational_engine.rs`
- `apps/livemap/src/operational-protocol.test.ts`
- `apps/livemap/src/rzue.test.ts`
- `docs/betriebsengine.md`
