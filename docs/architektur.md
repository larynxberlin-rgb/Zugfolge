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

Mehrere Welten multiplizieren beides **linear** und sind vollständig isoliert.
Das ist eine Frage von Prozessen und Betriebskosten, nicht von Architektur —
vorausgesetzt, `world_id`-Partitionierung und regionale Single-Writer stimmen von
Anfang an.

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

### 2.0a Kurzlebige Tutorialwelten

Der öffentliche Weltstart und der Tutorialstart sind getrennte Orchestratoren:

```text
POST /worlds/:publicWorldId/tutorial-sessions
        │ weltgebundenes Konto sperren; aktive Sitzung wiederverwenden
TutorialSessionService
        │ tut_<base32> ↔ interne Tutorial-Welt-UUID
TutorialWorldFactory
        ├─ private/unranked Welt + profileKind=tutorial
        ├─ echtes Ledger, Economy, Fleet und Planning
        ├─ echtes Betriebsprogramm und Rust-Dispatcher
        └─ regionale Störung + finale Zustands-Hashes
```

Pro öffentlichem Weltkonto existiert höchstens eine aktive Sitzung. Die
partielle Datenbank-Unique-Constraint und eine Kontosperre serialisieren
Parallelstarts. Provisionierung und Kapitelaktionen tragen persistente
Schritt-/Kommando-IDs; ein Prozessneustart setzt sie fort. Alle Fachdaten,
Indizes und Events behalten die interne `world_id`-UUID. Nur die externe,
kryptographisch zufällige Referenz beginnt mit `tut_`.

Der Lebenszyklus lautet `provisioning → running → summary → closing →
archived`, ergänzt um `failed`. Idle-TTL, maximale Dauer und die fünfminütige
Summary-Schonfrist werden mit einer injizierbaren realen Uhr außerhalb des
Simulationskerns geprüft. Der Reaper schließt Economy und Welt idempotent,
entzieht den Zugang und persistiert Abschlussgrund und finalen Hash. Nach
`closing` werden Kommandos abgelehnt. Diese eng begrenzte, ungewertete
Weltklasse ist die dokumentierte Ausnahme vom No-Wipe-Vertrag öffentlicher
Welten.

Tutorialprofile werden aus administrativen Odoo-Weltlisten und Projektionen
ausgeschlossen. Einladung, Weltstartantrag, Vier-Augen-Verfahren und Odoo-
Outbox kennen keine einzelne Tutorialinstanz. Betriebstelemetrie nutzt nur
niedrigkardinale Dimensionen wie Templateversion, Kapitel und Ereignistyp;
individuelle Welt-UUIDs sind keine Prometheus-Labels.

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
3. Nur kleine Live-Deltas für Züge und abweichende Infrastrukturzustände laufen
   über Snapshot und SSE. Eine Zugkartenposition ist im Protokoll zwingend als
   Exact oder Estimate diskriminiert. Exact nennt den gepinnten
   `infrastructureReleaseId`, die bestätigte Ressource, das Gleis und den
   ganzzahligen gleisscharfen Offset. Estimate nennt denselben Release, die
   bestätigte `resourceId`, die Projektionsmethode und eine geschätzte
   E7-Koordinate, aber niemals `trackId` oder gleisscharfen Offset. Bei einem
   fremden oder fehlenden Releasebezug gibt es keine Kartenposition;
   `ExternalLeg` erhält ausdrücklich auch kein Estimate.

Exact bleibt die einzige betriebliche Positionswahrheit. Estimate entsteht
ausschließlich als deterministische, read-only und releasegebundene
Darstellungsprojektion: zuerst auf einem eindeutig orientierten amtlichen
Korridor, sonst auf dem im Release eindeutig zur bestätigten `resourceId`
gebundenen Ankerhalt. Die Ankerwahl ist eine zustandslose Artefaktzuordnung,
kein zuletzt beobachteter Serverstand. Ein mehrdeutiger Korridor fällt auf den
releasegebundenen Anker zurück; nur ohne einen solchen Anker endet die
Darstellung ohne Marker. Es gibt weder Nächstes-Gleis-Heuristik noch externe
Quelle oder KI im Laufzeitpfad.

Diese Abhängigkeit ist strikt einseitig vom autoritativen Simulationszustand
zur Livemap. Fahrdienstleitung, Fahrstraßen, Konfliktressourcen, Sperrzeiten,
Laufwegsuche, Trassenbestellung, Bestellbarkeit und Qualitätsbewertung dürfen
Estimate weder importieren noch zurückgereicht bekommen. Die `resourceId` im
Estimate bindet die richtige visuelle Projektion, behauptet aber keine
Gleisbelegung. Estimate schreibt keine Domain-Events und macht weder Klasse C
spielbar noch qualitativ besser.

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

Der reale Projektionskatalog 2026.1 belegt Exact und Estimate getrennt und
disjunkt. Von 5.436.720.000 Ressourcenmillimetern sind 28,49 % gleisscharf
bestätigt, 63,03 % auf eindeutig orientierten Korridoren geschätzt und 8,48 %
an releasegebundenen Ankern gehalten. Protokoll-, Runtime- und Negativtests
erzwingen die gegenseitige Exklusivität und die einseitige Verbrauchsgrenze.
Die noch offene manuelle Browser- und Spielabnahme bleibt davon getrennt.

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
1:1-Innenraumprojektion. Sichtbare Dialogknoten und Spielerposition laufen über
Snapshot und sequenzierte SSE-Deltas. Verdeckter Fahrberechtigungsstatus,
Dialoggewichte, Polizeireaktion und Buchungen verbleiben serverseitig.

Der Datenfluss ist strikt gerichtet: M10 liefert Nachfrage, M15 nimmt
autorisierte Kommandos an, M8 entscheidet über Konfliktressourcen und
Abfahrtsrecht, M4 propagiert Verspätung, M10 revidiert betroffene Reiseketten
und M6 bucht Forderungen und Folgen. Ein `FareControlHoldV1` ist ein
persistenter Domainzustand und überlebt Browser- oder Sitzungsende. Er schreibt
keine Sonderbelegung, sondern verlängert die tatsächliche Ist-Belegung im
regionalen `CapacityLedger`.

Die API liegt unter
`/worlds/{worldId}/operators/{operatorId}/trains/{trainRunId}/conductor-sessions`.
Jedes Kommando trägt Welt, Sitzung, erwartete Revision und Idempotenzschlüssel.
Asset- und Dialogreleases sind gepinnt; Bild- oder Textgenerierung sowie andere
externe Dienste sind im Laufzeitpfad verboten. Vollständiger Vertrag:
[`schaffnermodus.md`](schaffnermodus.md).

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
  Sekunden seit Weltepoche, Positionen als Millimeter entlang Kante. Fahrdynamik
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
