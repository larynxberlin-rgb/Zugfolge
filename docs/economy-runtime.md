# M6-Runtime und Health-Checks

Der produktive `game-api`-Prozess startet einen überschneidungsfreien
M6-Scheduler im Zehn-Sekunden-Takt. Er lädt alle persistenten Wirtschaftswelten,
holt verpasste Fristen in fachlicher Reihenfolge nach und schreibt neuen Zustand
sowie Outbox atomar mit optimistischer Revisionsprüfung. Die zufällige
Workerzeit wird nicht zur Fachzeit: Open, Close und Mobilisierung tragen stets
den zuvor veröffentlichten Fristzeitpunkt und eine daraus abgeleitete,
idempotente Kommando-ID.

## Rust-Single-Writer am Betriebsübergang

Der Fahrplanstichtag wird nicht mehr durch eine zweite TypeScript-Regel
entschieden. `crates/zugfolge-runtime` verarbeitet den versionierten Befehl
`zugfolge-operating-transition-command/v1` als reinen Rust-Single-Writer. Der
Befehl enthält Welt, Los, explizite Stichtagssekunde, erwartete Revision und
den Hash des gelesenen Zustands. Er nimmt ausschließlich bereits an der
M5-Grenze verifizierte Fahrzeug-, Personal- und Trassennachweise entgegen.

Das Ergebnis `zugfolge-operating-transition-result/v1` enthält den vollständig
revisionierten Betriebszustand, dessen SHA-256, die Zuweisung jeder
materialisierten Zugfahrt und weltgebundene Ereignisse. Eine wiedergewonnene
Ausschreibung setzt den Betrieb nahtlos fort. Ein vollständiger M5-Nachweis
wechselt alle Zugfahrten auf den neuen Betreiber. Fehlt der Nachweis, muss eine
nichtleere öffentliche Ersatzfahrzeugflotte vorhanden sein; Rust weist die
Fahrten dem Eigenbetrieb zu und fordert die Pönale an. Andere Sekunden als der
veröffentlichte Fahrplanstichtag, ein abweichender Zustandshash, eine alte
Revision oder eine wiederverwendete Kommando-ID mit anderen Nutzdaten werden
abgewiesen.

`crates/zugfolge-runtime-napi` ist nur der schmale napi-rs-Adapter.
`packages/runtime-native` lädt in Produktion ausschließlich den absoluten Pfad
aus `ZUGFOLGE_RUNTIME_NATIVE_PATH`; fehlt das Addon oder seine ABI, startet der
Dienst nicht. Es gibt keinen JavaScript-Ersatzpfad. Der Economy-Scheduler
persistiert Rust-Zustand, Hash und Ereignisse gemeinsam mit seiner eigenen
Revision in einer Datenbanktransaktion. Erst nach dem Commit werden die
Ereignisse an flüchtige Projektionen verteilt.

Die Ereignisse `livemap-operation-marked` und
`livemap-operation-cleared` bilden eine zeitgenaue Markerfolge je Zugfahrt.
Beim Prozessstart liest `game-api` diese Marker aus dem weltisolierten
Event-Log erneut ein. Noch nicht in der Livemap materialisierte Fahrten werden
nur vorgemerkt; weder Position noch Fachzeit werden erfunden.

## Ablauf und Wiederanlauf

1. Persistenter `EconomyWorldState` wird samt Revision geladen.
2. Fällige Ausschreibungsschritte werden sortiert ausgewertet.
3. Rust entscheidet fällige Betriebsübergänge; neuer Zustand, Rust-Ereignisse
   und alle Ledger-/Postfacheffekte werden in einer Transaktion gespeichert.
4. Bei einer konkurrierenden Revision lädt der Worker bis zu zweimal neu.
5. Die transaktionale Outbox wird an Ledger und Postfach zugestellt; bereits
   quittierte Effekte werden nicht erneut fachlich gebucht.

Nach Prozessneustart beginnt der Worker beim Datenbankzustand. Damit werden
Ausfälle zwischen Fristen nachgeholt, ohne die veröffentlichte Fachzeit zu
verschieben. Ein nicht vorhandener oder nicht mehr gültiger M5-Nachweis führt
zum vorgesehenen Eigenbetriebs-/Pönalepfad und nicht zu einer stillen
Mobilisierung.

Für die Produktion sind neben Datenbank und Keycloak die getrennten
Ingest-Geheimnisse sowie `ECONOMY_LEDGER_ACCOUNTS_JSON` erforderlich. Letzteres
ordnet jeder EVU-ID das Geld-, Erlös- und die benötigten Kostenkonten zu; eine
fehlende Zuordnung lässt den Outbox-Lauf sichtbar fehlschlagen.
Zusätzlich ist `ZUGFOLGE_RUNTIME_NATIVE_PATH` verpflichtend und muss auf das
für die Produktionsplattform gebaute `.node`-Addon zeigen.

## Reproduzierbarer Native-Nachweis

Der CI-Job `Native Runtime ABI (Linux, echtes NAPI)` baut das Addon mit
`cargo build --release --locked -p zugfolge-runtime-napi --features
node-addon`, lädt es über den produktiven TypeScript-Adapter und prüft echte
Initialize-/Apply-Aufrufe, deterministische Hashes und idempotenten Replay.
Ein separater M6-Native-Integrationsfall führt den Stichtagsablauf über PGlite,
Ledger, Postfach und Livemap aus.

Dieser Job ist ein erforderlicher Abnahmebeweis, nicht bloß eine Definition.
Solange GitHub Actions wegen Issue #29 keine Läufe startet, bleibt der
Linux-Native- und damit der Produktivnachweis blockiert. Auf dem gewählten
Windows-GNU-Entwicklungswerkzeug scheitert der Addon-Build zuvor an
`libnode.dll not found in any search path`; ein TypeScript-Mock ersetzt diesen
Plattformnachweis nicht.

## Überwachungsvertrag

`GET /health` ist ausschließlich Liveness. `GET /health/ready` führt alle
Readiness-Prüfungen parallel mit hartem Timeout aus und liefert bei einem
kritischen Ausfall HTTP 503. Fehlerdetails werden intern protokolliert; die
öffentliche Antwort enthält nur stabile Codes.

| Check | Erkennt unter anderem |
|---|---|
| `database` | Verbindungsfehler und fehlende Pflichttabellen/-spalten |
| `keycloak-jwks` | nicht erreichbare oder ungültige Signaturschlüssel |
| `event-log` | fehlenden Fortschritt der Simulation |
| `economy-outbox` | alte, wiederholt fehlgeschlagene Ledger-/Postfacheffekte |
| `economy-scheduler` | Startphase, Laufzeitüberschreitung, letzten Fehler oder zu alten erfolgreichen Lauf |
| `livemap` | fehlenden beziehungsweise zu alten Simulationsfortschritt |

Der Scheduler-Monitor zählt verarbeitete Fristübergänge und hält Start-,
Abschluss- und Fehlerzeitpunkt. Ein laufender Zyklus über dem Lag-Limit,
ein Fehler ohne nachfolgenden Erfolg oder ein zu alter Abschluss setzt die
Readiness auf `down`. Der erste noch nicht abgeschlossene Zyklus ist
`degraded`, damit ein gerade startender Prozess nicht fälschlich als vollständig
bereit gilt.

Diese Checks schließen die Funktionsüberwachung auf Prozessebene. Externe
Alarmierung, Dashboards, SLOs sowie Backup-/Restore-Proben bleiben bewusst Teil
von M9.5; ein Health-Endpunkt allein ersetzt kein Monitoring-System.
