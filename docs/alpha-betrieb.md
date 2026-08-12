# Geschlossene Alpha — Betrieb und Wiederherstellung

Dieses Runbook ist die betriebliche Ergänzung zu M9.5 und M9.9. Es macht den
technischen Stand prüfbar, ersetzt aber weder die benannte Release-Freigabe aus
Issue #48 noch die Freigabe zum realen Alpha-Start.

## Ziele und Zustände

| Dienst | RPO | RTO | `degraded` | `down` |
|---|---:|---:|---|---|
| autoritatives Game-PostgreSQL | 5 min | 60 min | Replikat/Backup älter als 5 min | keine schreibfähige Primärinstanz |
| Game API und Single-Writer | Eventlog-basiert 0 s | 30 min | Queue wächst, Reads noch konsistent | keine autoritative Kommandoannahme |
| Odoo-Datenbank und Filestore | 15 min | 120 min | Projektion verzögert | Odoo nicht erreichbar |
| Odoo-Bridge | persistente Queue, 0 s Verlust | 60 min | ältester Auftrag über 60 s | wiederholte Zustellung ab drei Versuchen |
| Livemap/Provider | Eventlog-Replay | 30 min | Datenalter über Grenzwert | kein autoritativer Snapshot |

Odoo ist niemals im heißen Spielpfad. Bei Odoo-Ausfall nimmt das Game weiter
Spielerkommandos an; nur neue menschliche Adminanträge und Projektionen warten
in der persistenten Queue. Ein Operator darf die Odoo-Queue nicht durch einen
direkten Game-Adminpfad umgehen.

## Backup und isolierter Restore

`ops/alpha/backup-game.sh` erzeugt einen PostgreSQL-Custom-Dump samt SHA-256-
Manifest. `restore-game.sh` akzeptiert ausschließlich Datenbanken mit Präfix
`zugfolge_restore_`, legt sie neu an und bricht beim ersten Restorefehler ab.
Der autoritative Vergleich erfolgt mit
`tools/alpha-ops/authoritative-state-hash.mjs` über alle öffentlichen Tabellen.

Odoo wird getrennt gesichert: `backup-odoo.sh` schreibt Datenbankdump,
Filestore-Archiv, Artefakthashes sowie kanonische Hashes des Zugfolge-
Fachzustands und des Filestore-Baums. `restore-odoo.sh` prüft alle vier, nimmt
nur eine isolierte `zugfolge_odoo_restore_*`-Datenbank und weigert sich, einen
nichtleeren Ziel-Filestore zu überschreiben. Erst nach Modul-Upgrade,
Odoo-Testlauf und Stichprobe von Anhängen darf ein Restore freigegeben werden.

## Reproduzierbarer Phase-3-Drill

`pnpm alpha:phase3` ist der einzige vollständige M9.4/M9.5/M9.7-Lauf. Er nutzt
den bereits gesunden Compose-Stack und schreibt keine Protokolle vorab. Seine
Reihenfolge ist bindend:

1. ein bereitgestelltes Alpha-Konto über zwei verschiedene Odoo-Benutzer
   entziehen; Odoo-Request, Keycloak-Subject, weltgebundener Zugang und
   Game-Audit müssen in einem Protokoll verbunden sein;
2. Feedback eines anderen aktiven externen Kontos bis in die pseudonymisierte
   Odoo-Projektion verfolgen;
3. laufendes Odoo sichern und isoliert restaurieren, Fachzustands- und
   Filestore-Baumhash vergleichen, danach Modulupgrade, Add-on-Tests und eine
   echte `ir.attachment`-Stichprobe ausführen;
4. Odoo stoppen, bis `ZugfolgeOdooDown` und
   `ZugfolgeSubsystemDegraded` feuern; nach Wiederanlauf Game API stoppen, bis
   `ZugfolgeGameApiDown` feuert;
5. Dashboard-UID `zugfolge-alpha-ops` und die Prometheus-Reihen für Datenalter,
   Queues, Bridge und Markt live abfragen.

Der Drill ist auf Linux im Wartungsfenster auszuführen und kann wegen der
echten `for`-Zeiten der Alert-Regeln mehr als zehn Minuten dauern. Ein
verkürztes Warteintervall oder ein statisch gerendertes Dashboard ersetzt den
Nachweis nicht. Bei Abbruch stellt der Trap Odoo und Game API wieder an; danach
ist trotzdem die normale Readiness- und Reconciliation-Prüfung Pflicht.

## Wichtigste Ausfälle

1. **Game API/Single-Writer:** Ingress stoppen, Schreib-Lease genau einer
   Instanz bestätigen, Eventlog und Checkpoint prüfen, aus letztem guten
   Checkpoint replayen, Hash mit Vorzustand vergleichen, erst dann Ingress
   öffnen. Bei Hashabweichung Restore einleiten und Incident als kritisch
   behandeln.
2. **PostgreSQL:** Schreibverkehr sperren, letzten vollständigen Dump und WAL-
   Ziel bestimmen, isoliert wiederherstellen, Migrationen und Hash prüfen,
   dann kontrollierten Failover. Niemals zwei Primärschreiber starten.
3. **Eventlog/Outbox/Scheduler:** betroffene Queue anhalten, ältesten Auftrag
   und Idempotenzschlüssel prüfen, Ursache beheben, ab derselben Sequenz
   weiterarbeiten. Ein Auftrag wird nicht manuell als verarbeitet markiert.
4. **Livemap/Provider:** Simulation läuft weiter. Providerzustand als
   `degraded` markieren und letzten zulässigen Snapshot halten; Livemap aus dem
   autoritativen Eventlog neu projizieren.
5. **Odoo/Bridge:** Spielbetrieb unangetastet lassen, Queue-Tiefe beobachten,
   Odoo separat wiederherstellen, Reconciliation ausführen und erst danach
   wartende Projektionen zustellen. Adminanträge bleiben bis dahin offen.

## Rollback und Wiederanlauf

Applikationsrollback erfolgt auf das vorherige unveränderte Image bei
vorwärtskompatiblem Schema. Eine Datenbankmigration wird nicht blind
zurückgerollt: zuerst isolierter Restore, Zustands-Hash und fachliche
Kompatibilitätsprüfung. InfraRelease-Aktivierungen dürfen nur am vorgesehenen
Periodenwechsel erfolgen; bei Vorabprüfungsfehler bleibt der alte Release
aktiv. Der Wiederanlauf erfolgt in der Reihenfolge PostgreSQL, Single-Writer,
Game API, Worker/Scheduler, Livemap, Bridge, Odoo-Projektion.

Die versionierten Prometheus-Regeln liegen unter `ops/alpha/alerts.yml`, das
achromatische Grafana-Dashboard unter `ops/alpha/grafana/`. Farbstufen sind dort
nur ein zusätzlicher Kanal; Legenden und Zustandswörter bleiben sichtbar.
