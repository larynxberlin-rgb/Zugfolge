# Keycloak `public` → `keycloak`: versionierter Betriebs-Cutover

Diese Anleitung gilt ausschließlich für die versionierte Ops-Migration
`keycloak-public-to-schema/v1`. Sie verschiebt den vollständigen
Keycloak-26.7.0-Katalog in derselben PostgreSQL-Datenbank atomar aus `public`
nach `keycloak`. Sie ist keine Drizzle-Migration und wird beim normalen
Compose-Start niemals implizit ausgeführt.

## Unveränderlicher Vertrag

- Runtime-Image:
  `quay.io/keycloak/keycloak:26.7.0@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13`;
- PostgreSQL: Major 16;
- Objektkatalog:
  `ops/alpha/keycloak/keycloak-pg16-object-catalog.26.7.0.json`;
- Keycloak-Soll: exakt 100 Tabellen, 614 Spalten, 198 Constraints und 246
  Indizes; keine benutzerdefinierten Trigger, Sequenzen, Views, Enums oder
  Domains;
- OID-Beleg: exakt 544 OIDs für alle 100 Tabellen, 246 Indizes und 198
  Constraints vor und nach `ALTER ... SET SCHEMA`;
- Inhaltsbeleg: exakter Row-Count und kanonischer SHA-256 jeder der 100 Tabellen
  sowie zusammengefasster Identity-Head für Realms, Benutzer, Clients,
  Credentials und Sitzungen.

Der eingecheckte Vertrag wurde aus dem am 25.08.2026 rein lesend erfassten
PG16-`public`-Katalog abgeleitet. Das vollständige Quellartefakt bindet
457333 kanonische JSON-Bytes mit
SHA-256 `2957676c917012447001576138f0e4cafd56276ce8f2fc61b3110581b05d2042`
und den Gzip-Hash
`9013db6b6f04a7453cef7873d2a33aa50b68d72fc1f885a06651db695ad9e291`.
Der Indexfingerabdruck verwendet bewusst die kompakte Ausgabe von
`pg_get_indexdef(..., false)`. PostgreSQL qualifiziert darin die Tabelle
unabhaengig vom `search_path` mit ihrem Schema; die anschliessende
Schema-Neutralisierung bildet daher sowohl den produktionshistorischen
`public`-Katalog als auch einen frischen Keycloak-26.7.0-Aufbau auf denselben
exakten Indexvertrag ab. Die Pretty-Ausgabe ist dafuer ungeeignet, weil sie ein
im `search_path` sichtbares `public`-Schema aus dem Text auslaesst. Anzahl,
Name, Relation, Eindeutigkeit, Primary-Flag, Ready-/Valid-Status und kompletter
Indexausdruck bleiben Bestandteil des SHA-256-Vertrags.
Die Spaltensignatur verwirft weiterhin keine sichtbare Struktur: Name, Typ,
Default, Nullregel, Identity-/Generated-Merkmal, Kollation und die relative
Reihenfolge aller Live-Spalten bleiben gehasht. Nur die physische `attnum` wird
je Tabelle dicht auf die Live-Reihenfolge abgebildet. Damit beeinflussen bereits
durch `not attisdropped` ausgeschlossene PostgreSQL-Tombstones den Vertrag nicht
indirekt ueber Positionsluecken. Der verifizierte Vergleich ergab beim frischen
Keycloak-26.7.0-Aufbau 55 solche Tombstones in 22 Tabellen und dadurch 143
abweichende physische Positionen; alle 614 Live-Spaltendeskriptoren waren sonst
identisch zum produktionshistorischen Capture. Beide Wege ergeben nach dieser
engen Normalisierung weiterhin dessen unveraenderten Spalten-SHA-256
`2c24830b5eadc762bbb1d7189fc05e93cab6ce7136099abf1036b4b97f0b8d06`.
Die Auswahl ist explizit und verlustfrei: 51 bekannte Game-Relationen beim
Produktionsstand mit 28 Drizzle-Einträgen, 100 exakt mit dem offiziellen
Keycloak-26.7.0-Katalog übereinstimmende Relationen und drei über
`pg_depend.deptype = 'e'` eindeutig PostGIS gehörende Relationen. Die
Keycloak-Auswahl wird als vollständige Namensliste eingecheckt; sie beruht
nicht auf einem Präfix oder einer Heuristik.
Dieser historische 51er-Satz ist ein eigener, unveränderlicher
Schema-28-bis-32-Vertrag. Der heutige Schema-33-Laufzeitvertrag umfasst durch
`regional_simulation_command_receipts` exakt 52 autoritative Game-Tabellen und
wird nicht rückwirkend zur Klassifikation des Capture vom 25.08.2026 benutzt.

Die Selektion ist mit dem unveränderten Capture reproduzierbar:

```bash
node tools/audits/keycloak-public-catalog-selection.mjs \
  /gesicherter/pfad/keycloak-public-catalog-2026-08-25.json.gz.b64
```

Der Audit prüft zuerst Gzip-, Byte- und JSON-Hash, klassifiziert anschließend
alle 154 Relationen vollständig als 51 Game-, 100 Keycloak- und drei
Extension-Relationen und berechnet die acht eingecheckten Signaturen neu. Eine
nicht klassifizierte Relation oder irgendeine Hashabweichung bricht ab.

## Zustände und harte Sperren

`inspect` akzeptiert nur drei eindeutige Zustände:

- `legacy`: alle 100 Keycloak-Tabellen liegen in `public`, keine in
  `keycloak`;
- `migrated`: alle 100 liegen in `keycloak`, keine in `public`;
- `bootstrap`: beide Sätze sind leer, der Drizzle-Stand ist 0 und das leere
  Zielschema wurde durch
  `ops/alpha/postgres/010-keycloak-schema.sql` für eine neue Datenbank angelegt.

Gemischte oder partielle Sätze, ein unbekannter Game-Relations-/Routinenkatalog,
fremde Zielrelationen oder Zielroutinen, Enums/Domains, Zielkollisionen, ein
anderer PostgreSQL-Major, ein unbekannter Drizzle-Stand, abweichende
Spalten-/Constraint-/Indexhashes und ein aktiver Liquibase-Lock brechen ab.
Keycloak 26.7.0 verwendet dabei keinen einzelnen generischen Liquibase-Datensatz,
sondern exakt die beiden Lock-Namespaces `DATABASE` (`1`) und `KEYCLOAK_BOOT`
(`1000`). Fehlende, zusätzliche oder als aktiv markierte Lockzeilen werden
abgelehnt. Die `ACCESS EXCLUSIVE`-Sperre auf allen 100 Quelltabellen bleibt der
entscheidende Live-Nachweis dafür, dass auch kein transaktionaler Keycloak-Lock
mehr gehalten wird.
Tabellen- und Schemanamen bleiben auf den eingecheckten einfachen Namensraum
begrenzt. Index- und Constraintnamen im ausschließlich gehashten OID-Beleg
dürfen dagegen den vollständigen PostgreSQL-Identifierraum bis 63 UTF-8-Bytes
nutzen; sie werden niemals als SQL zusammengesetzt.
Der Live-Inspector akzeptiert für Extension-Objekte nur zwei explizite Varianten:
plain PG16 ohne Extension-Relationen/-Routinen oder den Produktions-PostGIS-
Fußabdruck aus den drei Relationen `geography_columns`, `geometry_columns` und
`spatial_ref_sys` plus ausschließlich durch `pg_extension` als `postgis`
belegte Routinen. Ein partieller oder fremder Extension-Satz in `public` und
jedes extension-owned Objekt im `keycloak`-Zielschema brechen ab.

`up` und `down` laufen in genau einer `SERIALIZABLE`-Transaktion. Auf einer
reservierten PostgreSQL-Verbindung wird davor ein nicht wartender Session-
Advisory-Lock genommen; ein paralleler Migrationslauf bricht damit sofort ab.
Innerhalb der Transaktion sperrt die Migration als erstes snapshotrelevantes
Kommando alle 100 Quelltabellen gemeinsam mit `ACCESS EXCLUSIVE`. Erst danach liest sie Zustand,
Identity-Head und Liquibase-Lock und vergleicht sie mit dem freigegebenen Plan.
Dadurch kann kein Snapshot vor einem bereits wartenden Keycloak-Writer
festgeschrieben werden. Erst dann folgen die 100 `ALTER TABLE ... SET SCHEMA`.
Ein Fehler rollt die gesamte Transaktion zurück. `down` entfernt das danach
leere `keycloak`-Schema ohne `CASCADE`.

## Up-Migration im Wartungsfenster

Voraussetzungen:

1. bestätigtes Wartungsfenster mit vollständiger Dienstunterbrechung;
2. neue, leere und nur für den Operator lesbare Verzeichnisse für Backup und
   Evidence;
3. aktualisierte `.env` mit
   `KEYCLOAK_SCHEMA_EVIDENCE_HOST_DIR`,
   `KEYCLOAK_SCHEMA_BACKUP_HOST_DIR` und dem installierten Receipt-Pfad;
4. vorgebautes aktuelles Game-Image, dessen unveränderliche lokale Image-ID
   oder `repository@sha256`-Referenz in
   `ZUGFOLGE_GAME_API_IMAGE_REFERENCE` steht; ein mutabler
   `zugfolge-game-api`-Tag ist nur Buildausgabe und kein Laufzeitvertrag;
5. keine Keycloak-, Game-, Scheduler-, Odoo-Bridge- oder sonstigen Writer auf
   der gemeinsamen Datenbank.

Beispielpfade müssen vor der Ausführung auf einen neuen Cutover-Lauf zeigen:

```bash
install -d -m 0700 -o 1000 -g 1000 /opt/zugfolge/keycloak-schema-migration/up-20260825
install -d -m 0700 -o 1000 -g 1000 /opt/zugfolge/keycloak-schema-backup/up-20260825
systemctl stop zugfolge-alpha.service
docker ps --format '{{.Names}}'
```

UID/GID müssen den in `.env` festgelegten
`KEYCLOAK_SCHEMA_OPERATOR_UID`/`KEYCLOAK_SCHEMA_OPERATOR_GID` entsprechen. Die
One-shot-Container laufen ausdrücklich nicht als root; ein root-eigenes
`0700`-Verzeichnis würde deshalb vor jeder Datenbankänderung fehlschlagen.

Im initialen Produktions-Cutover werden diese Komponenten nicht einzeln
aufgerufen. Nach dem erfolgreichen `--schema33-after-cold` führt ausschließlich
der fail-closed Wrapper die ganze Reihenfolge aus:

```bash
bash tools/alpha-ops/compose-with-map-release-env.sh \
  --keycloak-after-schema33 -f /opt/zugfolge/compose.yml
```

Der Modus stoppt alle Anwendungswriter, startet nur die Datenbank- und
Prüfdatenbankcontainer und verlangt zunächst exakt 33 Drizzle-Migrationen. Dann
erstellt er mit dem gepinnten PostgreSQL-16-Hilfscontainer das vollständige
Shared-Database-Backup; es enthält Game und Keycloak, nicht nur die ausgewählten
Tabellen. Genau dieser Dump wird in das getrennte, ausschließlich mit dem Präfix
`zugfolge_restore_` zugelassene Ziel wiederhergestellt. Der Restore schreibt
create-new einen kanonischen `zugfolge-game-restore/v2`-Receipt, der
Restore-Datenbank, Dump- und Manifest-SHA-256 sowie Drizzle-Stand bindet.

Danach laufen in derselben quieszierten Wrapperausführung genau `bind-backup`,
`plan-up`, `up` und `preflight-up`. `bind-backup` liest den
Keycloak-Identity-Head ausschließlich aus der isoliert wiederhergestellten
Datenbank, niemals nachträglich aus der Live-Datenbank. `plan-up` vergleicht
diesen Dump-Kopf mit dem weiterhin quieszierten Live-Kopf. Ein älterer, formal
gültiger Dump mit gleichem Drizzle-Stand bricht bei jeder Identity-Abweichung ab.
`preflight-up` akzeptiert für diesen Bestands-Cutover keinen Fresh-Bootstrap-
Receipt. Bei jedem Fehler bleiben alle Writer gestoppt; ein bereits vorhandener
Zielpfad wird niemals überschrieben.

Alle Artefakte werden `create-new` mit Modus `0600` geschrieben. Existiert ein
Ziel bereits, wird es nicht überschrieben. Vor dem Neustart müssen
`backup-binding.json`, `plan.json` und `receipt.json` extern kopiert und ihre
  Hashes einschließlich `restore-receipt.json` protokolliert werden. In `.env` bleibt
`KEYCLOAK_SCHEMA_WRITERS_QUIESCED=false`; der normale Start verwendet keinen
Migration-Profile-Service. `keycloak-schema-preflight` muss erfolgreich sein,
danach startet das gepinnte Keycloak mit `KC_DB_SCHEMA=keycloak`, und erst ein
  erfolgreiches `keycloak-schema-postflight` lässt zuerst `game-bootstrap`
  weiter. Dieser nimmt nach den sortierten World-Locks mit einem begrenzten
  10-Sekunden-Locktimeout `SHARE` auf allen 100 Keycloak-Tabellen und liest erst
  danach den v3-Rollbackkopf. Erst nach seinem Commit darf
  `keycloak-reconcile` mutable Realm-/Clientwerte angleichen; anschließend
  startet `game-api`.
Bei jedem normalen Start werden dabei der installierte Up-Receipt, der exakte
Datenbankendpunkt, der freigegebene Objektkatalog und die aktuelle vollständige
Tabellen-/Index-/Constraint-Struktur geprüft. Der im Receipt festgehaltene
Identity-Head belegt die verlustfreie Migration zum Commitzeitpunkt; er ist kein
unveränderlicher Sollwert für spätere legitime Benutzer-, Sitzungs- oder
Credential-Änderungen.

## Recover-Receipt

Wenn `up` committed ist, aber der Prozess vor dem create-new Receipt abbrach,
wird die Migration **nicht** wiederholt. Der laufende Wrapper versucht in genau
diesem Fehlerfall automatisch `recover` gegen denselben Plan. Wurde auch der
Hostprozess unterbrochen, nimmt ausschließlich der enge Recover-Modus die
vorhandenen create-new Artefakte wieder auf. Er verlangt Schema 33, einen
eindeutig migrierten Zustand und denselben unveränderten Plan, erzeugt einen
eigenen Recover-Receipt und prüft Zielzustand, vollständigen Identity-Head und
alle 544 OIDs erneut:

```bash
bash tools/alpha-ops/compose-with-map-release-env.sh \
  --keycloak-recover-after-schema33 -f /opt/zugfolge/compose.yml
```

Ein gemischter/partieller Zustand ist kein Recover-Fall. Dann bleiben alle
Dienste aus; es folgt nur ein Restore des vollständigen gebundenen Backups in
eine isolierte Datenbank und ein dokumentierter Recovery-Entscheid.

## Down-Migration

`down` ist ausschließlich ein bewusst freigegebener Rückweg vor dem
irreversiblen Anwendungs-Cutover. Dazu alle Writer erneut stoppen, neue leere
`down-*`-Evidence-/Backupverzeichnisse verwenden, `inspect` mit erwartetem
`migrated`, ein neues vollständiges Backup erstellen, dieses in eine neue
isolierte `zugfolge_restore_*`-Datenbank wiederherstellen und dann in dieser
Reihenfolge `bind-backup`, `plan-down`, `down` ausführen. Der Down-Receipt muss
`action: "down"` und denselben Identity-/OID-Hash vor und nach der Transaktion
belegen.

Nach `down` darf die aktuelle Compose-Vorlage nicht gestartet werden: sie setzt
absichtlich `KC_DB_SCHEMA=keycloak`. Der Wiederanlauf erfolgt nur mit einem
zuvor attestierten alten Image-/Compose-Vertrag, der den zurückverschobenen
Katalog ausdrücklich mit `KC_DB_SCHEMA=public` adressiert, oder durch
vollständigen Restore von Datenbank, Code und Images. Der gesonderte
Operational-V2-Abbruch über `compose.alpha.rollback.yml` führt dagegen keine
Down-Migration aus: Er startet den alten Anwendungsstand gegen den unveränderten
Schema-33-Hot-Restore und muss deshalb weiterhin `KC_DB_SCHEMA=keycloak`
verwenden. Jede Änderung seit dem gebundenen Restorepunkt geht bei einem
Vollrestore verloren und ist vorab als RPO zu benennen.

## Fresh Database

Nur bei einem nachweislich leeren neuen `game-db`-Volume und einem leeren,
neuen Evidence-Verzeichnis darf einmalig
`KEYCLOAK_SCHEMA_BOOTSTRAP_ALLOWED=true` gesetzt werden. Der Init-Hook legt nur
das leere Schema an; Keycloak 26.7.0 initialisiert seinen Katalog selbst direkt
dort und markiert das Schema mit dem exakten Init-Hook-Ursprung
`zugfolge:keycloak-bootstrap-origin/v1`. Ein vorhandener Legacy-, Misch- oder unbekannter Zustand wird dadurch
nicht migriert. Der erste Postflight prüft danach die exakte Struktur und legt
`keycloak-public-to-schema-bootstrap-receipt/v1` kanonisch gehasht sowie
`create-new` am exakt gleichen Pfad wie den installierten Receipt ab. Nur dieser
Postflight erhält das Evidence-Verzeichnis schreibbar; Preflight und alle
normalen Leser bleiben read-only. Bereits der Fresh-Preflight verweigert jeden
vorhandenen Receipt, und der Postflight mintet nur mit dem Init-Hook-Marker und
weiterhin fehlendem Receipt. Ein altes Evidence-Verzeichnis kann daher nicht an
ein neues Volume gekoppelt werden. Unmittelbar danach wird der Bootstrap-Schalter
wieder auf `false` gesetzt. Der initiale Identity-Head im Bootstrap-Receipt
belegt den Erstellungszeitpunkt, ist aber kein unveränderlicher Reihen-Sollwert
für den laufenden Identitätsdienst.

## Testnachweis

`tools/alpha-ops/keycloak-public-to-schema.real-integration.sh` läuft in CI
gegen echtes PostgreSQL 16 und das gepinnte Keycloak-Image. Der Test erzeugt
Realm, Client, Benutzer und Credential in `public`, fordert einen echten Token
an, führt Backup, isolierten Restore und `up`/Recover aus, startet mit
`KC_DB_SCHEMA=keycloak`, fordert erneut
einen Token an, führt Backup/`down` aus und prüft den Token nochmals in
`public`. Der `sub` muss in allen drei Tokens identisch sein; zusätzlich prüfen
die Migrationen alle Reihenhashes und OIDs. Weil der echte Login nach `down`
legitime Sitzungsdaten fortschreiben kann, wird der alte Up-Plan danach bewusst
nicht wiederverwendet: Ein frisches vollständiges Backup, dessen isolierter
Restore und ein neuer exakt gebundener Up-Plan stellen den für den
nachgelagerten Rollbackbeweis benötigten migrierten Endzustand her. Lokal auf
Windows wurde dieser
Container-Test nicht ausgeführt, weil in der Arbeitsumgebung keine Docker Engine
verfügbar war; die Unit-, Negativ- und PGlite-Vertragstests bleiben davon
getrennt.
