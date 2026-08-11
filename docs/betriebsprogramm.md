# Betriebsprogramm und Betriebszentrale (M7)

Dieses Dokument beschreibt die ausführbare M7-Architektur. Die fachliche
Definition bleibt in [`betrieb.md`](betrieb.md) Abschnitt 1; hier stehen
Verträge, Persistenz, API, Streaming, Oberfläche und Abnahme.

## 1. Verantwortungsgrenzen

```text
Operations Center
  → authentifizierte Game-API
    → kanonische Programmversion / Simulationskommando
      → Rust-Single-Writer und RuleDispatcher
        → append-only DomainEvent
          → EVU-Projektion, Live-Stream und Tagesbericht
```

`crates/zugfolge-rules` ist die einzige Entscheidungsengine. Sie implementiert
den `Dispatcher` aus M4.4 und erhält `TrainRun`, explizite `SimTime`,
`DispatchTrigger` und bereits geprüfte `DispatchFacts`. Sie kennt weder
Datenbank noch Netzwerk oder Systemuhr. TypeScript validiert nur die
versionierte JSON-Struktur, persistiert sie und projiziert Ereignisse; es
wertet keine Dispositionsregel ein zweites Mal aus.

Die M5-Adapter übertragen reale `OperationsError`-Befunde in
`DispatchLimits`. Der M3-Adapter übernimmt die echte `PathDecision` in die
Kapazitätsgrenze. Ein verworfener Versuch bleibt mit der konkret verletzten
Grenze in `DecisionExplanation.rejected_alternatives` sichtbar.

## 2. Versionierter Kernvertrag

Das kanonische Schema heißt `operating-program/v1`. Jede Version trägt
`world_id`, `operator_id`, eine positive `version`, den Programmstatus und eine
geordnete Regelmenge. Kanonische Reihenfolge ist absteigende Priorität und bei
Gleichstand aufsteigende Regel-ID. Die SHA-256-Prüfsumme wird über das kompakte
kanonische JSON gebildet und stimmt in Rust und TypeScript überein.

| Bestandteil | Ausführbare Werte |
|-------------|-------------------|
| Auslöser | Verspätungsschwelle, Anschlussgefährdung, Fahrzeugausfall, Personaldienstüberschreitung, Streckensperrung, Bahnsteigänderung, Wendezeitunterschreitung, Ad-hoc-Trassenkonflikt |
| Bedingungen | verschachtelte `all`, `any`, `not` und typisierte Ganzzahl-/Bool-Prädikate; höchstens 8 Ebenen und 64 Knoten |
| Maßnahmen | Anschluss halten/brechen, Halt auslassen, kurzwenden, Zug schwächen/verstärken, Fahrt ausfallen lassen, Reserveumlauf, Ersatzfahrzeug, Umleitung, Trassenrückgabe, Schienenersatzverkehr |
| Grenzen | Konfliktfreiheit/Kapazität, Zugcharakteristik, Streckenkenntnis, Zugsicherung, Elektrifizierung, Zuglänge, Fahrzeug, Wartung, Personalqualifikation, Ruhezeit, Umlauf, Vertrag und Kosten |

Jede Entscheidung liefert Regel-ID, geprüfte Bedingungen, jede einschlägige
Grenze, verworfene Alternativen, Ursache, Ressource sowie Auswirkungen auf
Fahrten, Anschlüsse, Umläufe, Personal, Fahrzeuge, Kosten und Vertrag. Fehlt
eine zulässige Regel, fällt ein externes Dispositionsereignis konservativ aus;
Ankunft und Abfahrt behalten das sichere M4.4-Standardverhalten.

Ein manueller Override enthält Maßnahmenwunsch und Begründung, gilt nur für
die adressierte `decision_id` und durchläuft exakt dieselben Grenzen. Er ändert
weder Programmversion noch Folgeentscheidungen.

## 3. Persistenz und Migration

Migration `packages/db/drizzle/0009_early_freak.sql` ergänzt:

- `operating_program_versions`: unveränderliche kanonische Versionen je Welt
  und EVU, eindeutige Versionsnummer, SHA-256, Entwurf/aktiv/abgelöst und
  erzeugendes Konto;
- `daily_operation_reports`: idempotente Tagesprojektion je Welt, EVU und
  Betriebstag samt Quellsequenzbereich.

Alle Schlüssel, Fremdschlüssel und Indizes beginnen fachlich mit `world_id`.
Aktivierung, Rücktest und Override laufen über die vorhandene persistente
`simulation_commands`-Warteschlange. Entscheidungen und Rücktestergebnisse
bleiben im append-only `domain_events`-Log; ein Rücktest schreibt niemals in
den historischen Simulationszustand.

## 4. API

Alle folgenden Routen verlangen ein gültiges Keycloak-Token und das
Gründerkonto des adressierten EVU:

| Methode und Pfad unter `/worlds/:worldId/operators/:operatorId` | Zweck |
|---|---|
| `GET /operating-programs/templates` | drei echte Einsteigervorlagen |
| `POST /operating-programs` | validieren, kanonisieren und als neue Version speichern |
| `GET /operating-programs` | Versionen und Aktivstatus lesen |
| `POST /operating-programs/:version/activate` | atomar aktiv markieren und Single-Writer-Kommando einreihen |
| `POST /operating-programs/backtests` | Rücktest mit Quellsequenzbereich einreihen |
| `GET /operating-programs/backtests` | unveränderliche Ergebnisereignisse lesen |
| `GET /operations` | EVU-gefilterte Betriebsprojektion lesen |
| `GET /operations/events` | authentifizierter SSE-Strom mit Resume |
| `POST /operations/decisions/:decisionId/override` | begründeten Einzelfall einreihen |
| `POST /operations/reports/:serviceDay/generate` | Tagesprojektion aus Event-Log erzeugen |
| `GET /operations/reports` | persistierte Berichte lesen |

Der interne Simulations-Ingest publiziert ein angenommenes
`dispatch.decision`, `dispatch.major-event` oder `dispatch.manual-override`
unmittelbar an den passenden Welt-/EVU-Feed. `Last-Event-ID` liefert Replay;
ist die begrenzte Historie überholt, fordert `event: reset` einen Snapshot an.
Pro Verbindung sind höchstens 128 ausstehende Frames erlaubt. Eine langsame
Verbindung wird geschlossen, statt unbegrenzt Speicher zu belegen.

Die versionierte Großstörungsschwelle der M7-Projektion liegt bei drei
betroffenen Zugläufen. Eine vom Kern bereits ausdrücklich als `major`
klassifizierte Entscheidung bleibt ebenfalls ein Großereignis. Unterhalb der
Schwelle bleibt das Ereignis im selben begrenzten EVU-Strom sichtbar, wird aber
nicht im Großereignis-Fenster hervorgehoben.

Der Produktionsprozess führt stündlich einen idempotenten M7-Tagesjob für den
vorherigen Berliner Betriebstag aus. Der Job enumeriert erst Welten und liest
danach ausschließlich weltgebundene EVU- und Event-Log-Abfragen. Der manuelle
Erzeugungsendpunkt nutzt dieselbe Projektion für gezielte Nachberechnungen.

## 5. Operations Center

`apps/operations-center` ist ein eigenständiges Vite-Frontend. Der normale
Produktpfad verlangt `?world=<uuid>&operator=<uuid>` und das Token
`sessionStorage["zugfolge.accessToken"]`; er besitzt keinen impliziten
Demo-Fallback.

Die Oberfläche ist durchgehend dunkel, hochkontrastreich und für große
Informationsdichte gebaut. Regeln lassen sich per Ziehen mit Maus oder Touch,
per sichtbaren Hoch/Runter-Schaltflächen und per `Alt+Pfeil` sortieren. Alle
Funktionen bleiben mit Tastatur erreichbar; Fokus ist sichtbar, Live-Status
und Fehler besitzen semantische Rollen, reduzierte Bewegung wird respektiert.
Bedingungsbaum, Programm- und Regelstatus, Priorität, Trigger, Maßnahme,
Vorlagen, Speichern, Aktivieren und Rücktest liegen im selben Arbeitskontext.

Die Betriebszentrale priorisiert Großereignisse und zeigt daneben Ausfälle,
manuelle Eingriffe und alle übrigen erklärbaren Entscheidungen. Der
Override-Dialog nennt ausdrücklich seine Gültigkeit nur für den Einzelfall und
die unveränderte Grenzprüfung. Tagesberichte zeigen Fahrten, Pünktlichkeit,
Verspätungen, Ausfälle, Ersatzverkehr, Erlös/Kosten/Vertragswirkung sowie
Infrastruktur-, Personal- und Fahrzeugeffekte.
Der Bericht trennt unveränderliche Fakten (Event-Sequenzen, Programmversion,
Regel, Bedingungen, Grenzen, Maßnahme, Ablehnungen, Override und Auswirkung)
von deterministisch abgeleiteten nächsten Hebeln. Jede Entscheidungszeile
verlinkt über ihre Sequenz zur entsprechenden Karte im Ereignisfenster.

## 6. Nachweise und Entwicklung

```powershell
cargo test -p zugfolge-rules --locked
pnpm --filter @zugfolge/dispatch test
pnpm --filter @zugfolge/game-api test
pnpm --filter @zugfolge/operations-center typecheck
pnpm --filter @zugfolge/operations-center test
pnpm --filter @zugfolge/operations-center build
pnpm --filter @zugfolge/m7-e2e build
pnpm --filter @zugfolge/m7-e2e test:e2e
```

`tools/m7-acceptance` lässt den echten Kern 172.800 Simulationssekunden laufen,
injiziert am expliziten Zeitpunkt eine Streckensperrung und gibt ausschließlich
aus echten Kernereignissen abgeleitete Plattformereignisse aus.
`tools/m7-e2e` startet eine migrierte PGlite-Welt und die reale Game-API,
speichert und aktiviert das Betriebsprogramm, führt den Rust-Erzeuger aus,
ingestiert dessen Ereignisse und prüft Betriebszentrale sowie Tagesbericht.
Zustands-, Entscheidungs- und Programmhash werden im Lauf geprüft.
Der Harness startet den Kern zweimal mit identischer gespeicherter Version und
demselben Kommandolog und verlangt byteidentische Ausgabe. Der eigene
`m7-acceptance`-Job in `.github/workflows/ci.yml` führt diesen Beweis auf Linux
bei jedem Push und Pull Request aus.

M8 bleibt für die Entstehung realer und simulierter Störungen verantwortlich.
M7 verarbeitet eine eingespeiste Streckensperrung vollständig, erfindet aber
keinen zweiten Störungsgenerator.
