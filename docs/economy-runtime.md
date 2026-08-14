# M6-Runtime und Health-Checks

Der produktive `game-api`-Prozess startet einen überschneidungsfreien
M6-Scheduler im Zehn-Sekunden-Takt. Er lädt alle persistenten Wirtschaftswelten,
holt verpasste Fristen in fachlicher Reihenfolge nach und schreibt neuen Zustand
sowie Outbox atomar mit optimistischer Revisionsprüfung. Die zufällige
Workerzeit wird nicht zur Fachzeit: Open, Close und Mobilisierung tragen stets
den zuvor veröffentlichten Fristzeitpunkt und eine daraus abgeleitete,
idempotente Kommando-ID.

## Autoritativer M5-Flottennachweis

M6 übernimmt keinen angelieferten Mobilisierungssnapshot mehr. Der Server lädt
`ZUGFOLGE_FLEET_AUTHORITY_RELEASE_PATH` beim Start fail-closed als absoluten,
regulären Nicht-Symlink. Der versionierte, weltgebundene Katalog enthält die
serververtrauenswürdigen Quellfakten zu Fahrzeugassets, technischen Daten,
Personalqualifikationen und bestätigten Trassenbelegen. Rust normalisiert,
prüft, friert und hasht diesen Authority-Release beim Initialisieren der
Flottenwelt.

Danach akzeptiert die interne Game-API ausschließlich drei Intent-Kommandos:
Formation aus Fahrzeug-IDs und Trassenbeleg, Personaldienst aus Pool-,
Formations- und Beleg-IDs sowie Trassenreservierung aus einem bestätigten
Beleg. Verfügbarkeit, Beschaffungszustand, abgeleitete Zugcharakteristik,
Personalbereitschaft und Trassenbestätigung sind keine Eingabefelder. Rust
leitet sie aus dem eingefrorenen Zustand mit den M5-Fachregeln ab.

`packages/economy` sperrt die Weltzeile und schreibt jeden Rust-Zustand,
Zustandshash, kompakten Kommando-Beleg und den abgeleiteten
Mobilisierungssnapshot atomar. Ein Retry von Kommando A nach einem späteren
Kommando B lädt den historischen A-Checkpoint, verifiziert Beleg, Zustand und
Snapshot erneut durch Rust und liefert exakt A zurück, ohne den aktuellen
DB-Kopf B zu verändern. Der frühere HTTP-Endpunkt für fertige
Mobilisierungssnapshots existiert nicht mehr.

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

`occurredAt` bleibt dabei die fachliche, gegebenenfalls beschleunigte
Weltsekunde des Effekts. `enqueuedAt` wird getrennt mit der realen Wanduhr des
persistierenden Adapters gesetzt. Alterungs- und Fehlerprüfungen der Queue
werden dadurch nicht von einer gegenüber der Realzeit vorauslaufenden
Simulation verfälscht.

Offene Outboxzeilen werden unabhängig vom Lifecycle der Welt enumeriert. So
bleibt ein vor einem Prozessabbruch bereits committeter Effekt auch nach einer
zwischenzeitlichen Archivierung sichtbar, weltisoliert wiederholbar und bis
zur erfolgreichen Zielquittung auditierbar. Der begrenzte Drainpfad löscht
keine Restzeile und setzt kein Ack vor dem erfolgreichen, idempotenten
Zieladapter-Commit.

Tutorials wechseln vor dem Abschluss dauerhaft in `closing`. Provisionierung,
Vergabe, Mobilisierung und Abrechnung drainieren ihre persistierte Outbox; der
Economy-Abschluss setzt davor eine persistierte fachliche Endmarke, die weitere
Scheduler- und Spielerkommandos abweist. Der Archivierungscommit folgt erst
nach dem anschließenden erfolgreichen Abschluss-Drain. Ein
Adapterfehler lässt die Sitzung deshalb retryfähig in `closing`, während
der globale Recoverylauf auch Altzeilen bereits archivierter Tutorialwelten
über deren persistierten Kontenplan erneut zustellen kann.

Nach Prozessneustart beginnt der Worker beim Datenbankzustand. Damit werden
Ausfälle zwischen Fristen nachgeholt, ohne die veröffentlichte Fachzeit zu
verschieben. Ein nicht vorhandener oder nicht mehr gültiger M5-Nachweis führt
zum vorgesehenen Eigenbetriebs-/Pönalepfad und nicht zu einer stillen
Mobilisierung.

### Serialisierte Cash-Verfügbarkeit

Economy-Übergang, Journalprojektion und entgeltliche EVU-Kooperation teilen
pro Welt und EVU dieselbe Datenbanksperre. Ein Journal-Debit reserviert Cash
bereits mit dem atomaren Economy-/Outbox-Commit; ein Kauf oder entgeltlicher
Vertrag darf deshalb nur den gebuchten Cash-Saldo abzüglich aller noch nicht
ins Ledger projizierten Netto-Debits verwenden. Noch ungebuchte Journal-Credits
erhöhen die verfügbare Liquidität nicht.

Liegt nach einem Workerabbruch die idempotente Ledger-Transaktion bereits vor,
während die Outboxzeile noch nicht quittiert ist, wird ihr Debit nicht ein
zweites Mal reserviert. Parallele Dispatcher dürfen denselben Effekt bis zum
idempotenten Zieladapter lesen; genau eine welt- und EVU-gebundene
Ledger-Transaktion entsteht, und eine bereits durch einen Konkurrenten
quittierte Outboxzeile gilt für den Verlierer als erfolgreicher Replay.

Die Scheduler-Wanduhr wird nur im Adapter gelesen. Vor der fachlichen
Auswertung lädt der Worker die Weltepoche aus der Datenbank und bildet daraus
eine ganzzahlige Weltsekunde. Fristen und der Rust-Kern erhalten niemals Unix-
Sekunden oder `now()` als Simulationszustand.

Für die Produktion sind neben Datenbank und Keycloak die getrennten
Ingest-Geheimnisse sowie `ECONOMY_LEDGER_ACCOUNTS_JSON` erforderlich. Letzteres
ordnet jeder EVU-ID das Geld-, Erlös- und die benötigten Kostenkonten zu; eine
fehlende Zuordnung lässt den Outbox-Lauf sichtbar fehlschlagen. Vor jeder
Buchung werden Welt, EVU und Kontonamen gegen den versionierten Kontenplan
`economy-ledger-account-plan/v1` geprüft; opaque IDs allein autorisieren keine
Kontenrolle.
Zusätzlich ist `ZUGFOLGE_RUNTIME_NATIVE_PATH` verpflichtend und muss auf das
für die Produktionsplattform gebaute `.node`-Addon zeigen.

## Reproduzierbarer Native-Nachweis

Der CI-Job `Native Runtime ABI (Linux, echtes NAPI)` baut das Addon mit
`cargo build --release --locked -p zugfolge-runtime-napi --features
node-addon`, lädt es über den produktiven TypeScript-Adapter und prüft echte
Initialize-/Apply-Aufrufe, deterministische Hashes und idempotenten Replay.
Ein separater M6-Native-Integrationsfall initialisiert und verändert M5 über
die produktiven HTTP-Routen, beweist historische Replays und führt danach den
Stichtagsablauf über PGlite, Ledger, Postfach und Livemap aus.

Dieser Job ist ein erforderlicher Abnahmebeweis, nicht bloß eine Definition.
Er muss für den abzunehmenden Commit tatsächlich auf Linux grün gelaufen sein.
Auf dem gewählten Windows-GNU-Entwicklungswerkzeug scheitert ein Node-Addon-
Featurebuild an `libnode.dll not found in any search path`; ein TypeScript-
Mock ersetzt deshalb weder den Linux-ABI- noch den komponierten Native-E2E-
Nachweis.

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
| `regional-simulation-scheduler` | fehlgeschlagenen oder über zwei Taktintervalle ausgebliebenen 1:1-Lauf |
| `livemap` | fehlenden beziehungsweise zu alten Simulationsfortschritt |

Der Scheduler-Monitor zählt verarbeitete Fristübergänge und hält Start-,
Abschluss- und Fehlerzeitpunkt. Ein laufender Zyklus über dem Lag-Limit,
ein Fehler ohne nachfolgenden Erfolg oder ein zu alter Abschluss setzt die
Readiness auf `down`. Der erste noch nicht abgeschlossene Zyklus ist
`degraded`, damit ein gerade startender Prozess nicht fälschlich als vollständig
bereit gilt.

Der regionale Monitor wertet auch einen leeren Zyklus als erfolgreichen Takt.
Der erste Fehler ist `degraded`; zwei aufeinanderfolgende Fehler oder mehr als
zwei Intervalle ohne Erfolg sind `down` und damit HTTP 503. Seine Metriken
enthalten nur die begrenzten Labels `success` und `failure`, niemals Welt- oder
Regionskennungen. Noch nicht geöffnete Welten zählen nicht als veralteter
Livemap-Feed.

Diese Checks schließen die Funktionsüberwachung auf Prozessebene. Externe
Alarmierung, Dashboards, SLOs sowie Backup-/Restore-Proben bleiben bewusst Teil
von M9.5; ein Health-Endpunkt allein ersetzt kein Monitoring-System.
