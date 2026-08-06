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
  (`disruption`, `tiebreak`, `demand`, `failure`, `tender_release`). Ein neuer
  Substream verändert die bestehenden nicht. Der Vergabekalender einer Welt
  entsteht aus `tender_release` und ist dadurch reproduzierbar und im
  Nachhinein prüfbar.
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
