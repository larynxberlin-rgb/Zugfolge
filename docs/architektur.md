# Architektur

## 1. Erst die Last, dann die Technik

„Sehr performant“ ist kein Ziel, solange keine Zahl daran hängt. Größenordnungen
für Gesamtdeutschland, **eine** Welt:

| Größe | Schätzung |
|-------|-----------|
| Betriebsstellen | 4.000–5.000 |
| Blockabschnitte als Konfliktressourcen | 40.000–80.000 |
| Weichen | ~65.000 |
| Zugfahrten je Tag inklusive Zusatzfahrten | 40.000–60.000 |
| Betriebsereignisse je Tag | 2–3 Mio. → Ø ~30/s, Spitze ~150–200/s |
| Gleichzeitig materialisierte `TrainRun`s (48–72 h) | 120.000–180.000 |
| `PlanningRun` je Fahrplanperiode | Batch, Laufzeit von Stunden zulässig, regional parallelisierbar |

**Es sind zwei gegensätzliche Lasten, und sie brauchen Gegensätzliches:**

- Die **laufende Simulation** ist ereignis- und ein-/ausgabegeprägt. Wenige
  hundert Ereignisse je Sekunde mit überschaubarer Rechenarbeit, dazu
  Delta-Versand an viele Clients gleichzeitig. Ein Nebenläufigkeitsproblem, kein
  Rechenproblem.
- Der **Trassen-Solver** ist das Gegenteil: ein kombinatorisches
  Planungsproblem über zehntausende Konfliktressourcen, NP-hart, mit der
  Sperrzeitenprüfung in der innersten Schleife. Hier entscheidet reine
  Rechenleistung, und zwar um Größenordnungen.

Jede regulaere Spielwelt besitzt einen eigenen Server, eigene Datenhaltung und
eine feste HTTPS-Subdomain (E32). Weitere Welten skalieren ueber weitere Server;
`world_id`-Partitionierung und regionale Single-Writer bleiben verbindlich.
Die Start-, HTTP- und Odoo-Grenzen beschreibt
[ADR-0033](adr/0033-eine-spielwelt-pro-server.md).

## 2. Systemarchitektur (E5)

Der Schnitt folgt der Last, nicht der Bequemlichkeit.

```text
Web-Client — React + TypeScript, MapLibre GL, PMTiles
        │  WebSocket-Deltas / REST-Kommandos
Game-Services — TypeScript / Node.js
        Verträge, Ausschreibungen, Ledger, Märkte, Postfach,
        Entitlements, Odoo-Bridge, Delta-Fanout
        │  Kommandos rein, Events raus — keine gemeinsamen Datenstrukturen
Simulationskern — Rust
        Sperrzeiten, Fahrdynamik, Konfliktprüfung, Trassen-Solver,
        Regel-Engine, regionale Single-Writer
        │
PostgreSQL + PostGIS
        Verträge, Ledger, Fahrpläne, Event-Log (append-only, partitioniert)

Infra-Release-Pipeline (Batch, offline) — Rust
        OSM-PBF + Höhenmodell + Stationsdaten → versionierter InfraRelease
```

### 2.0a Spielhinweise und feste Weltbindung

Die Einführung ist ein rein lokaler Tooltip-Controller im Designsystem.
Er verbindet neu geschriebene Hinweise mit vorhandenen DOM-Elementen der drei
Spieloberflächen. Er benötigt keine API, Szenarien oder Simulationszustände.
Siehe [Spielhinweise](spielhinweise.md) und [E32](adr/0033-eine-spielwelt-pro-server.md).

**Warum der Kern in Rust liegt.** Nicht wegen der laufenden Simulation — die
liefe auch in TypeScript. Sondern weil im Kern drei Anforderungen
zusammentreffen, die sonst nirgends zusammenfallen: nationale Rechenlast im
Solver, bitgenaue Reproduzierbarkeit über Jahre hinweg, und ein Regelwerk, das
sich kaum ändert. Genau dort ist eine Sprache mit langsamerer Iteration die
richtige Wahl — und genau dort wäre ein späterer Umbau am teuersten, weil alles
andere gegen den Kern validiert ist.

**Warum die Game-Services in TypeScript bleiben.** Verträge, Ausschreibungen,
Märkte und Postfach ändern sich ständig, sind ein-/ausgabegebunden und haben kein
Skalierungsproblem. Sie später umzuschreiben wäre billig — sie jetzt in einer
langsamer zu ändernden Sprache zu bauen, kostet dauerhaft Tempo. Ein
TypeScript-Frontend ist ohnehin zwingend.

**Zur Lernkurve, der ehrliche Teil.** Rust ist die schwerere Sprache, und ein
Kern, den man nicht selbst reparieren kann, bleibt ein reales Risiko (R14). Drei
Dinge halten es beherrschbar:

- Der Kern hat einen **engen, geprüften Vertrag**: Kommandos hinein, Events
  hinaus, kein Datenbankzugriff. Golden-Master- und Determinismus-Tests melden
  einen Fehler sofort, auch wenn der Code noch nicht flüssig gelesen wird.
- Sein **Regelwerk ist stabil**. Sperrzeitenmodell, Fahrdynamik und
  Konfliktregeln kommen aus dem Eisenbahnbetrieb, nicht aus
  Produktentscheidungen.
- Der Einstieg ist **klein und begrenzt**: M0.3 sind drei Betriebsstellen und
  zwei Züge.

| Baustein | Wahl |
|----------|------|
| Simulationskern und Release-Pipeline | Rust |
| Kern-Anbindung | napi-rs — In-Process-Aufruf aus Node, keine zweite Betriebseinheit |
| Game-Services | TypeScript auf Node.js LTS, Fastify |
| Datenbank | PostgreSQL + PostGIS |
| Datenzugriff | Drizzle — nah an SQL, weil Konflikt- und Belegungsabfragen komplex werden |
| Frontend | React + Vite, MapLibre GL, PMTiles — statisch ausgelieferte Kacheln, kein Kachelserver |
| Identität | Keycloak |

Message-Broker und Cache kommen erst, wenn eine **Messung** sie verlangt: NATS,
sobald Regionen getrennte Prozesse brauchen; Redis, sobald der Delta-Versand
messbar bremst. Additive Schritte, keine Umbauten — anfangs übernimmt Postgres
auch die Ereigniszustellung.

**Keine Live-Abhängigkeit von externen Quellen im Spielbetrieb.** Die
Infra-Pipeline läuft offline und erzeugt ein unveränderliches Artefakt.

### 2.1 Kartenpfad und Detailprojektionen (E26, E27)

Die Karte besteht aus drei bewusst getrennten Datenströmen:

1. Eine weltweit sichtbare, dunkle OSM-Basiskarte wird als eigene, selbst
   gehostete PMTiles-Artefaktgruppe ausgeliefert. Der Browser verwendet zur
   Laufzeit keine öffentlichen Kachelserver.
2. Der vollständige Deutschland-Korpus liegt als getrennte semantische
   PMTiles-Ebene vor. Stabile `feature_id`-Werte machen Gleise,
   Betriebsstellen, Bahnsteige, Weichen, Signale, Blöcke und
   Konfliktressourcen anklickbar. Eine Weltmaske begrenzt nur die Spielbarkeit,
   nie den geladenen Deutschlandbestand.
3. Nur kleine committed Live-Deltas für Züge und abweichende
   Infrastrukturzustände laufen über Snapshot und SSE. Eine Zugkartenposition
   nennt zwingend `infrastructureReleaseId`, Laufwegversion, bestätigte
   Ressource, Gleis, ganzzahligen Offset, Spitze/Schluss, Belegungsintervalle,
   analytischen Bewegungsabschnitt, `valid_until` und Fahrberechtigungsende.
   Bei fremdem, fehlendem oder widersprüchlichem Releasebezug hält der Kern am
   letzten sicheren Punkt und beide Anzeigen frieren ein. `ExternalLeg`
   erhält keine erfundene Position.

Es gibt keinen Estimate-, Korridor-, Anker- oder Nächstes-Gleis-Pfad mehr.
LiveMap und RZÜ sind zwei read-only Projektionen desselben committed
`OperationalWorld`; Fahrdienstleitung, Fahrstraßen und Clients besitzen keine
zurückschreibbare eigene Position.

Große Detaildaten gehören weder in Vektorkacheln noch in den Livefeed. Die
weltgebundene Game-API liefert sie bei Auswahl aus einem unveränderlichen
Objekt- und Fahrplankatalog. Bahnhofstafel und FIS sind Darstellungen derselben
serverautoritativen Projektion. Öffentliche Zugdaten werden per Allowlist
redigiert; betriebsinterne Fahrzeug-, Personal-, Fahrweg- und Kostendaten
erfordern eine separate, serverseitig geprüfte EVU-Eigentümerroute.
Der deutschlandweite Katalog ist eine releasegebundene, read-only geöffnete
SQLite-Datei mit indizierten Einzelabfragen; nur kleine Testfixtures verwenden
weiterhin den vollständig geladenen JSON-Adapter. Schema, GTFS-Zuordnung und
Liveprojektion beschreibt [`livemap-detailkatalog.md`](livemap-detailkatalog.md).

Der historische Projektionskatalog 2026.1 belegt, dass nur 28,49 % der
Ressourcenmillimeter gleisscharf bestätigt waren; die damaligen Korridor- und
Ankerwerte sind kein v2-Betriebsnachweis. Die produktive v2-Freigabe bleibt
gesperrt, bis das operative Release die tatsächlich befahrenen Laufwege exakt
qualifiziert. Eine manuelle Browser- und Spielabnahme bleibt zusätzlich nötig.

Die fertigen Binärartefakte werden nicht in der Git-Historie versioniert. Git
enthält Spezifikation, Quellkatalog, festen Jahres-Prompt und Prüfcode. Ein
transportneutrales Paketmanifest bindet jede ausgelieferte Datei und jeden
100-MiB-Teil an Bytezahl und SHA-256; das Paket kann im Chat, auf einem
Datenträger oder in einem Artefaktspeicher übergeben werden. Die Installation
setzt es gestreamt zusammen, prüft Größe und Hash und schließt erst danach
atomar ab. Dadurch bleibt ein Serveraufbau reproduzierbar, ohne jedem
Quellcode-Klon sämtliche früheren Jahresstände aufzubürden.

Paketbildung, lokale Verifikation und Odoo-zu-Game-Staging sind von Aktivierung
getrennt. Ein Kandidat mit `signature: null` ist transport- und stagefähig,
aber trägt zwingend `activationEligible=false`. Odoo kann diese Grenze nicht
übersteuern; erst Signatur, erneute Game-Qualifizierung und der bestehende
Vier-Augen-Periodenwechsel dürfen eine Aktivierung vorbereiten.

### 2.2 Schaffnermodus als autorisierte Detailprojektion (E29)

M15 führt keinen zweiten Simulationskern ein. Das gemeinsame
Personenverkehrsmodell M10 liefert ein revisioniertes `PassengerManifestV1`;
der Schaffnermodus materialisiert daraus deterministisch eine private
1:1-Innenraumprojektion. Der interne Projektionsdienst bindet M10-Ergebnis,
bestätigte Haltlage, EVU und serververtrautes Platzinventar vor dem Rust-Aufruf.
Prognosen sind kein eingestiegener Fahrgastbestand. Der technische M15.2-Schnitt
ist noch keine öffentliche Sitzung.

Die vollständige Aktions-/Autoritätsmatrix, Sitzungs- und API-Grenze,
Datenschutz sowie Ressourcen- und Buchungsübergänge stehen ausschließlich in
[`schaffnermodus.md`](schaffnermodus.md) 2, 3, 9 und 11. Die konkrete
Einordnung vorhandener Implementierung steht in der
[Teilabnahme](m15-abnahme.md). Die gemeinsame Operational-v2-Betriebsengine
bleibt auch für spätere kontrollbedingte Halte zuständig.

## 3. Was einen späteren Umbau erzwingen würde

Ein Plattformwechsel entsteht selten aus einer Sprachwahl — der lässt sich hinter
einer engen Schnittstelle noch machen. Er entsteht aus Entscheidungen, die sich
später nicht nachziehen lassen, ohne jede gespeicherte Zeile anzufassen. **Diese
Liste ist die eigentliche Antwort auf „kein späterer Umbau“.**

**Irreversibel — muss ab dem ersten Commit stimmen:**

| Entscheidung | Warum unumkehrbar |
|--------------|-------------------|
| `world_id` in jeder Tabelle, jedem Index, jedem Event | nachträglich einzuziehen heißt, jede Abfrage und jede Zeile anzufassen |
| Regionale Single-Writer mit explizitem Übergabeprotokoll | entscheidet, ob überhaupt horizontal skaliert werden kann |
| Ganzzahliger Zustand, keine Gleitkommazahlen | zerstört Reproduzierbarkeit rückwirkend und unwiederbringlich |
| Expliziter Simulationstakt, benannte Seed-Substreams | ohne beides kein Replay und kein Determinismus-Test |
| Append-only Event-Log als Wahrheit des Betriebsverlaufs | trägt Replay, Audit, Backtesting und Tagesbericht gleichzeitig |
| Kern ohne direkten Datenbankzugriff | Bedingung dafür, dass der Kern austauschbar bleibt |
| `InfraRelease` und `EconomyRelease` versioniert und je Welt gepinnt | ohne Pinning keine reproduzierbare Welt, kein durchsetzbarer Stichtag |
| Weltprofil und `StartingCapitalPolicy` im signierten Blueprint | eine nachträgliche Änderung würde Eröffnungsbilanzen, Ranking und Replay derselben Welt unvereinbar machen |

**Reversibel — darf später wechseln, ohne Datenmigration:** Web-Framework,
Query-Builder, Transportweg zwischen den Diensten, Cache-Schicht, und die
Sprache einzelner Game-Services.

Die linke Liste steht vollständig in M0 bis M2 — nicht, weil sie dort am meisten
nützt, sondern weil sie dort noch billig ist.

## 4. Determinismus und Datenhaltung

Determinismus ist keine Nebenbedingung, sondern das Fundament für
Trassenvergabe, Audit, Replay-Export und Testbarkeit.

- **Simulationszeit ist ein expliziter Wert.** Nie `now()` im Kern.
- **Ein Seed je Welt und Periode**, aufgeteilt in benannte Substreams
  (`disruption`, `tiebreak`, `demand`, `failure`, `tender_release`,
  `tender_profile`). Ein neuer Substream verändert die bestehenden nicht. Der
  Vergabekalender einer Welt entsteht aus `tender_release`, das Vergabeprofil
  jeder Ausschreibung (E21) aus `tender_profile` — beide dadurch reproduzierbar
  und im Nachhinein prüfbar.
- **Keine Floats in zustandsrelevanten Werten.** Geld als `i64` Cent, Zeiten als
  ganzzahlige Millisekunden seit Weltepoche, Positionen als Millimeter entlang
  Kante. Fahrdynamik
  rechnet mit Floats — aber **einmalig in der Release-Pipeline**; die Simulation
  liest nur noch ganzzahlige Fahrzeittabellen.
- **Replay-Invariante:** gleicher `InfraRelease` + `EconomyRelease` + Seed +
  Kommandolog ⇒ bitgleicher Endzustand. Als CI-Test verankert.
- **`world_id` in jeder Abfrage und jedem Event**, mit automatisiertem
  Isolationsnachweis statt Disziplin.
- **Zeitumstellung** ist definiert zu behandeln — Verhalten von Fahrplanperiode
  und laufenden Zugfahrten beim Sommerzeitwechsel ist im 1:1-Echtzeitbetrieb ein
  Pflichtfall.

## 5. Authentifizierung, Sicherheit, Weltisolation

- Keycloak ist der eigenständige OIDC-Identity-Provider.
- Das Game-System ist Source of Truth für Spielerstatus, Weltzugänge und EVUs.
- Jede Datenbankabfrage und jedes Event trägt eine `world_id`.
- Autorisierung erfolgt serverseitig; der Browser erhält niemals versteckte
  Wettbewerbsdaten.
- Administrative Aktionen sind rollenbasiert, auditiert und bei
  Hochrisikoaktionen vier-Augen-fähig.
- Rate Limits, Anti-Bot-Prüfungen und Anomalieerkennung schützen Trassenfenster
  und Märkte.
- Datenschutz: Datenminimierung, Auskunft, Löschung, definierte
  Aufbewahrungsfristen.
- Ziel-SLO für Game API und Livemap: 99,9 % monatlich.

## 6. Health Checks

**M9.5 baut die Betriebsreife — Observability, Backup, Runbooks — erst später
aus, aber ihre Grundlage liegt seit M2 im Code.** Eine intensive Überwachung
lässt sich nicht rückwirkend über zwölf fertige Pakete streuen, ohne jedes
einzelne noch einmal anzufassen; deshalb steht der Vertrag von Anfang an, und
jeder künftige Milestone meldet seine eigene Prüfung an, statt sie am Ende
nachzuziehen — derselbe Grund, aus dem `world_id` seit M0.2 gilt (Abschnitt 3).

`@zugfolge/health` (`packages/health`) trägt genau diesen Vertrag, unabhängig
von jedem einzelnen Fachpaket:

- `HealthCheck` — ein Name und eine asynchrone Prüfung, die entweder
  `{ status, detail? }` liefert oder wirft. Wirft sie, zählt das als `down` —
  ein Paket muss seinen Fehlerfall nicht selbst in einen Status übersetzen.
- `HealthStatus` — `ok`, `degraded`, `down`. `degraded` ist erreichbar, aber
  eingeschränkt, kein Ausfall.
- `runHealthChecks` — führt alle Prüfungen nebenläufig aus und aggregiert zum
  **ungünstigsten** Status; eine werfende Prüfung reißt die anderen nicht mit.

`apps/game-api` verdrahtet zwei Endpunkte mit unterschiedlichem Zweck, beide
ohne Authentifizierung — Status- und Monitoringdienste tragen kein
Spielertoken:

| Endpunkt | Zweck | Antwort |
|----------|-------|---------|
| `GET /health` | Liveness: läuft der Prozess überhaupt | immer `{ status: "ok" }`, ohne Abhängigkeit zu prüfen |
| `GET /health/ready` | Readiness: sind die Abhängigkeiten erreichbar | aggregierter `HealthReport`; HTTP 503 bei `down`, sonst 200 |

Die Datenbankprüfung (`createDatabaseHealthCheck` aus `packages/db`) ist ab
M2.2 immer dabei. `AppDependencies.extraHealthChecks` ist der
Erweiterungspunkt: Jeder künftige Milestone, der eine neue Abhängigkeit
einführt — Keycloak-Erreichbarkeit, Message-Broker, externer Dienst —, meldet
dort seine eigene `HealthCheck`-Instanz an, ohne `app.ts` oder die Registry
selbst zu ändern.

Health Checks sind betrieblich, nicht weltgebunden: Die Datenbankprüfung liest
keine Tabellenzeile und definiert keine, sondern fragt nur, ob die Verbindung
antwortet (`select 1`) — der Wächter `world-id` greift dort gar nicht erst
(Abschnitt 4 in `monorepo.md`). Health Checks laufen nie im heißen Pfad der
Simulation; sie leben ausschließlich in den Game-Services.

## 7. Autoritative Betriebsengine und Projektionsgrenze (E31)

Der regionale Rust-Single-Writer führt ab v2 genau einen `OperationalWorld`.
Analytische Bewegung, Zugspitze/-schluss, Kantenintervalle, Stellwerkslocks,
Fahrberechtigungen, FDL, Lokführer, Rangieren und konkrete Störungswirkungen
sind Teil dieses reinen Zustands. Datenbank, Netzwerk und Systemuhr bleiben
außerhalb. Die Arbeitsmenge ist ereignis- und ressourcenindiziert; es gibt
weder Sekundentick noch regelmäßigen Zug-Vollscan.

Nach erfolgreichem Datenbankcommit erzeugt eine gemeinsame Projektionsgrenze
Snapshot oder Delta für LiveMap und RZÜ. Beide tragen dieselbe Commit-Sequenz;
eine zweite Karten- oder RZÜ-Position existiert nicht. Clientinterpolation ist
nur die Auswertung eines serverautorisierten analytischen Abschnitts bis
`valid_until`. Details, Einheiten, Checkpoint- und Cutoververtrag stehen in
[`betriebsengine.md`](betriebsengine.md) und ADR-0032.
