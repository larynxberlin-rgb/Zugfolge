# M6-Runtime und Health-Checks

Der produktive `game-api`-Prozess startet einen überschneidungsfreien
M6-Scheduler im Zehn-Sekunden-Takt. Er lädt alle persistenten Wirtschaftswelten,
holt verpasste Fristen in fachlicher Reihenfolge nach und schreibt neuen Zustand
sowie Outbox atomar mit optimistischer Revisionsprüfung. Die zufällige
Workerzeit wird nicht zur Fachzeit: Open, Close und Mobilisierung tragen stets
den zuvor veröffentlichten Fristzeitpunkt und eine daraus abgeleitete,
idempotente Kommando-ID.

## Ablauf und Wiederanlauf

1. Persistenter `EconomyWorldState` wird samt Revision geladen.
2. Fällige Ausschreibungsschritte werden sortiert ausgewertet.
3. Der neue Zustand und alle Ledger-/Postfacheffekte werden in einer
   Transaktion gespeichert.
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

