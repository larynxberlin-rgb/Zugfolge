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

## Kurzlebige Tutorialwelten

Tutorialinstanzen gehören allein dem Game und erscheinen nicht in Odoo. Der
30-Sekunden-Reaper schließt Sitzungen nach 30 Minuten Inaktivität, spätestens
nach 60 Minuten sowie fünf Minuten nach unbestätigter Ergebnisansicht. Bei
einem Neustart scannt er auch `closing` und setzt die idempotente Archivierung
fort. Erwartete Diagnosefelder sind `tut_…`-Referenz, Templateversion,
Lebenszyklus, Provisionierungsschritt, Kapitel, Abschlussgrund und finaler
Zustandshash.

Ein wiederholt wachsender Bestand aktiver Tutorialwelten ist ein Incident:
zuerst Reaper-Fehler und Datenbank-Unique-Constraint prüfen, dann den ältesten
`idle_expires_at`-Wert. Aktive Welten werden nicht manuell gelöscht. Zulässig
ist nur das erneute Ausführen des idempotenten Reapers; eine spätere
Laufzeitdatenbereinigung braucht ein eigenes, auditiertes Retentionverfahren.
Individuelle Referenzen/UUIDs bleiben aus Prometheus-Labels heraus.

## Backup und isolierter Restore

`ops/alpha/backup-game.sh` erzeugt einen PostgreSQL-Custom-Dump samt SHA-256-
Manifest, Dateigröße und der tatsächlich gesicherten Drizzle-Migrationszahl.
Im explizit quieszierten Rollbackmodus schreibt es zusätzlich create-new einen
`zugfolge-game-backup-operation/v1`-Beleg mit Dump-abgeleiteter Backup-ID und
realer WAL-Spanne. `restore-game.sh` akzeptiert Dump und Manifest ausschließlich
für Datenbanken mit Präfix `zugfolge_restore_`, prüft die Artefaktbindung, legt
das Ziel neu an und verlangt nach dem Restore exakt die im Manifest gebundene
Migrationszahl. Sein `zugfolge-game-restore/v2`-Receipt bindet zusätzlich
Restore-Datenbank sowie Dump- und Manifest-SHA-256 und kann vom Skript selbst
create-new geschrieben werden; die Keycloak-Schemamigration leitet ihren
Backup-Identity-Head ausschließlich aus diesem isolierten Restore ab.

Für den produktiven V2-Cutover qualifiziert
`tools/alpha-ops/create-database-backup-restore-evidence.mjs` genau diese realen
Dump-/Restore-Ergebnisse. Es vergleicht Quelle und Restore vollständig bis auf
den Reihenfingerprint jeder autoritativen Schema-32- und Keycloak-Tabelle,
fordert getrennte Endpunkte und physische Backends und publiziert gemeinsam
`zugfolge-database-backup-manifest/v1` sowie
`zugfolge-database-restore-proof/v1`. Erst dieses Paar darf in den
`zugfolge-database-rollback-proof/v3` eingehen. Damit benötigt der Restore-Drill
nach einer legitimen neuen Migration keine hart codierte Sollwertänderung und
bleibt bei jeder Cross-Binding-Abweichung fail-closed.

Keycloak teilt die PostgreSQL-Instanz, liegt aber nach dem versionierten Cutover
ausschließlich im Schema `keycloak`. Deshalb ist der Custom-Dump vor der
Schema-Migration immer ein vollständiger Shared-Database-Dump: Ein nur auf Game-
oder Keycloak-Tabellen gefiltertes Backup ist als Rückweg unzulässig. Up, Down,
Recover-Receipt, die exakten 100 Tabellen beziehungsweise 544 Tabellen-/Index-/
Constraint-OIDs und der gepinnte Keycloak-26.7.0-Digest stehen im separaten
Runbook [`keycloak-schema-migration.md`](keycloak-schema-migration.md). Der
normale Compose-Start führt keine dieser DDL-Operationen aus.

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

Applikationsrollback erfolgt auf das vorherige unveränderte Image nur bei
nachgewiesen vorwärtskompatiblem Schema. Migration 0030 hält dafür das
`initialization_hash`-Feld gegenüber dem v1-Worker optional, erzwingt es aber
für jeden Operational-v2-Zustand. So kann ein fehlgeschlagener Code-Rollout
vor der ersten v2-Aktivierung das unveränderte v1-Abbild weiterführen, ohne
Migration 0029 aus dem Journal oder Schema zu löschen.

Nach dem ersten v2-Schreibvorgang ist ein Rückfall auf v1 verboten: Der
v2-Zustand wird nicht in v1 transformiert. Der reguläre Betriebsweg ist dann
ein Forward-Fix auf v2. Ein gemeinsamer Restore von Code, Image und Datenbank
aus dem vor dem Cutover isoliert geprüften Backup ist ausschließlich
Disaster-Recovery: Er verwirft alle Änderungen seit diesem Restorepunkt und
muss dieses RPO vor Ausführung ausdrücklich benennen. Der
Aktivierungs-Preflight muss deshalb unmittelbar vor dem Cutover belegen, dass
noch kein v2-Zustand existiert, und den gebundenen Restorepunkt nennen. Eine Datenbankmigration wird nie blind zurückgerollt:
zuerst isolierter Restore, Zustands-Hash und fachliche Kompatibilitätsprüfung.
InfraRelease-Aktivierungen dürfen nur am vorgesehenen Periodenwechsel erfolgen;
bei Vorabprüfungsfehler bleibt der alte Release aktiv. Der Wiederanlauf erfolgt
in der Reihenfolge PostgreSQL, Single-Writer, Game API, Worker/Scheduler,
Livemap, Bridge, Odoo-Projektion.

Der Datenbank-Rollbackbeleg verwendet Schema
`zugfolge-database-rollback-proof/v3`. Quell- und Test-Restore müssen nicht nur
dieselbe persistente Game-Datenbankidentität, dasselbe Schema-32-Ledger und den
autoritativen Game-Kopf besitzen, sondern auch denselben vollständigen
`keycloak-identity-head/v1` über alle 100 Keycloak-Tabellen. Eine nur
strukturgleiche oder mit abweichenden Benutzern, Clients, Credentials oder
Sitzungen restaurierte Datenbank ist kein freigegebener Rückweg.

Die versionierten Prometheus-Regeln liegen unter `ops/alpha/alerts.yml`, das
achromatische Grafana-Dashboard unter `ops/alpha/grafana/`. Farbstufen sind dort
nur ein zusätzlicher Kanal; Legenden und Zustandswörter bleiben sichtbar.
