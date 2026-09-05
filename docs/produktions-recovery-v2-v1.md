# Produktions-Recovery für den attestierten V2→V1-Rückweg

Dieser Vertrag bereitet ausschließlich den kontrollierten Abbruch eines
gescheiterten oder noch nicht endgültig aktivierten Operational-/Runtime-V2-
Kandidaten auf den attestierten V1-Vorgänger vor. Sein Rollbackfenster ist
verbindlich `pre-activation-only`; er ist **kein automatischer Fallback**.
Nach dem endgültigen harten V2-Cutover gibt es keinen produktiven V1-Rückweg
und keine Zustandsübersetzung zurück auf V1. Ohne ein gültiges
`zugfolge-production-recovery-promotion/v1` darf kein Legacy-Prozess starten.

Der Vertrag verändert in der Vorbereitungsphase weder den Karten-Pointer noch
systemd. Compose und der kanonische Wrapper führen den Schema-29-Ausgangsdrill,
die begrenzte 0030/0031-Migration, den kalten Schema-31-Drill, die gekoppelte
Schema-32/33-Zielmigration und den heißen Drill als getrennte One-shots aus. Ein echter
Serverlauf bleibt eine ausdrücklich zu autorisierende Zustandsänderung.

Der einzige Kandidat dieses Laufs ist `infra-deutschland-2026.4`; Vorgänger ist
`infra-deutschland-2026.2`. Der verworfene, bereits signierte `.3`-Kandidat
bleibt ausdrücklich untrusted und darf weder Backup-/Recovery-Paar noch
Aktivierungsquelle sein.

## Sicherheitsgrenzen

- Während Cold-/Hot-Drill dürfen ausschließlich `postgres`, `odoo-postgres`
  und die volumengetrennten `recovery-verify-postgres` sowie
  `recovery-verify-odoo-postgres` laufen; der jeweils prüfende One-shot bindet
  sich zusätzlich an seine eigene Docker-ID. Nur im dazwischenliegenden
  Schema-29-Legacy-Drill starten die drei exakt gepinnten alten Runtimes
  `schema29-game-runtime`, `schema29-keycloak-runtime` und
  `schema29-odoo-runtime` portlos im internen Netz `schema29-recovery`.
  Die beiden Live-Datenbanken sind an dieses Netz nicht angeschlossen. Vor der
  abschließenden Quiescence müssen beide Prüf-Postgres gestoppt sein, sodass
  exakt `postgres` und `odoo-postgres` übrig bleiben.
- Die aktuelle V2-Game- und V2-Odoo-Datenbank werden mit
  `ALLOW_CONNECTIONS=false`, `CONNECTION LIMIT 0` und null verbleibenden
  Client-Sitzungen dauerhaft gefenced. Ein Boolean des Operators genügt nicht.
- Kein bestehendes Live-Datenbankziel wird gedroppt oder überschrieben. Neue
  Ziele heißen ausschließlich `zugfolge_recovery_v1_*` beziehungsweise
  `zugfolge_odoo_recovery_v1_*`.
- Der V1-Game-Dump wird erneut gegen sein Rohmanifest, den
  Backup-Operationsbeleg, das semantische Backup-Manifest, den Restore-Proof
  und den kanonischen v3-Datenbank-Rollback-Proof geprüft. Der neu isolierte
  Restore muss exakt denselben vollständigen autoritativen Kopf besitzen.
- Odoo ist notwendiger Teil derselben Recovery. Datenbankdump,
  Filestorearchiv, autoritativer Odoo-Zustand, vollständiger Filestore-Baum und
  alle referenzierten Zugfolge-Anhänge müssen gemeinsam passen.
- Der pristine Odoo-Filestore liegt als direktes, datenbankgleiches Kind einer
  festen Recovery-Wurzel vor, wird ausschließlich read-only gemountet und
  bleibt bytegleich unverändert. Die getrennte create-new Runtime-Kopie ist
  vor dem Legacy-Start ebenfalls read-only. Erst nach dem kanonischen
  Before-Snapshot prüft ein netzloser Root-One-shot den exakten Owner, alle
  Pfade und den Baseline-Baumhash und öffnet ausschließlich dieses eine
  datenbankbenannte Bind-Mount-Kind mit `0700`/`0600` für den gebundenen
  Nicht-root-Odoo-Owner. Der alte Odoo-Prozess erhält weder die feste
  Recovery-Wurzel noch die pristine Schwesterkopie als RW-Mount.
  Der Aggregate-Qualifier liest zusätzlich die Docker-Mount-Inventur und bindet
  deren physisch aufgelöste `Source` exakt an dieses datenbankbenannte
  Runtime-Kind; eine nur passende Container-Destination oder eine zweite
  Filestore-Bindung genügt nicht.
- Die alte Odoo-Probe erzeugt im alten Image einen echten
  `ir.attachment`-Blob, flusht die ORM-Transaktion, liest dieselben Bytes über
  Odoo und direkt aus dem Hashpfad und führt für Blob und Verzeichnis `fsync`
  aus. Nach dem Datenbank-Rollback entfernt sie ausschließlich seit dem
  Before-Snapshot neu erschienene reguläre Hashdateien/-verzeichnisse und
  verlangt wieder exakt den Baseline-Baumhash. Symlink, Traversal,
  Owner-Abweichung oder fehlgeschlagenes Cleanup publizieren keinen Beleg.
- Vor der Versiegelung wird die alte Odoo-Runtime gestoppt. Der Root-One-shot
  setzt die Runtime-Kopie auf `0500`/`0400`; erst danach wird Odoo mit demselben
  Nicht-root-Owner gegen den weiterhin als RW deklarierten, tatsächlich aber
  unixseitig read-only Baum neu gestartet. Der Aggregate-Qualifier akzeptiert
  nur die kanonisch verketteten Open-, Attachment-Probe- und Seal-Belege sowie
  den erneut selbst inspizierten Owner-, Modus- und Baseline-Baumzustand. Ein
  Fehler nach dem Öffnen stoppt alle Writer und ruft den Emergency-Reseal auf.
- Auch beide neuen V1-Zieldatenbanken werden nach der Qualifikation gefenced.
  Damit kann zwischen Prüfung und späterem Start kein Writer den Zustand
  verändern.
- Receipt und Promotion werden create-new über vollständig geschriebene
  temporäre Dateien und atomare Hardlinks publiziert. Die Promotion erscheint
  zuletzt. Ein abgebrochener Lauf kann deshalb keinen unvollständigen Zustand
  aktivierbar machen.
- Das bereits signierte Welt-Deployment darf wie im Schema-29-Runtime-Drill
  höchstens 16 MiB groß sein. Die übrigen Recovery-Steuerbelege bleiben auf
  höchstens 4 MiB begrenzt. Beide Grenzen gelten sowohl beim ersten Lesen als
  auch bei der unveränderten Revalidierung unmittelbar vor der Publikation.

## 0. Kanonische Vorbereitung vor dem ersten V1→V2-Cutover

In `.env` müssen drei bereits existierende, symlinkfreie und voneinander
getrennte Wurzeln sowie voneinander verschiedene pristine, Runtime- und
Cold-Restore-Datenbanken gesetzt sein:

```dotenv
PRODUCTION_RECOVERY_BACKUP_HOST_ROOT=./var/production-recovery/rollback-2026.4-001/material
PRODUCTION_RECOVERY_EVIDENCE_HOST_ROOT=./var/production-recovery/rollback-2026.4-001/evidence
PRODUCTION_RECOVERY_ODOO_FILESTORE_HOST_ROOT=./var/production-recovery/rollback-2026.4-001/odoo-filestore
PRODUCTION_COLD_GAME_RESTORE_DATABASE=zugfolge_recovery_v1_verify_2026_4_001
PRODUCTION_RECOVERY_GAME_VERIFY_DATABASE=zugfolge_restore_recovery_2026_4_001
PRODUCTION_COLD_ODOO_RESTORE_DATABASE=zugfolge_odoo_recovery_v1_cold_2026_4_001
PRODUCTION_SCHEMA29_GAME_RESTORE_DATABASE=zugfolge_recovery_v1_schema29_2026_4_001
PRODUCTION_SCHEMA29_ODOO_RESTORE_DATABASE=zugfolge_odoo_recovery_v1_schema29_2026_4_001
PRODUCTION_SCHEMA29_RUNTIME_GAME_RESTORE_DATABASE=zugfolge_recovery_v1_schema29_runtime_2026_4_001
PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_DATABASE=zugfolge_odoo_recovery_v1_schema29_runtime_2026_4_001
MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH=/evidence/alpha-world-deployment.json
```

Die Evidence-Wurzel gehoert auf dem Host `root` und der gebundenen
`PRODUCTION_RECOVERY_ODOO_RUNTIME_GID`; ihr Modus ist `1770`. Das Sticky-Bit
verhindert, dass die nicht-root laufenden Game- und Odoo-Proben fremde Belege
entfernen. Root-One-shots publizieren und lesen die `0600`-Belege; die beiden
Game-Proben behalten ihren Image-User und erhalten nur die gebundene
Zusatzgruppe. Backupmaterial und Filestore-Wurzel bleiben davon getrennt und
werden nicht fuer weitere Benutzer geoeffnet.

Der erste One-shot ist zwingend noch auf dem realen Produktionskopf 29:

```bash
bash tools/alpha-ops/compose-with-map-release-env.sh \
  --prepare-v2-schema31 -f /opt/zugfolge/compose.yml
```

Der Wrapper stoppt alle bekannten Anwendungswriter, startet die vorhandenen
Game-/Odoo-Postgres-Container mit `--no-recreate` und zusätzlich den separaten
Game- und Odoo-Prüf-Postgres. Danach führt das digestgebundene Odoo-Image nacheinander
`backup-game.sh`, `backup-odoo.sh`, `restore-game-recovery.sh` und
`restore-odoo-recovery.sh` aus. Erst ein vollständiger Vergleich beider
Datenbankquellen mit ihren pristinen Restores und beider Filestore-Bäume
publiziert `$PRODUCTION_RECOVERY_ID.schema29-cold-qualified.json`.

Aus denselben Backupbytes entstehen anschließend zwei weitere create-new
Runtime-Restores. Vor dem ersten Prozessstart bindet
`$PRODUCTION_RECOVERY_ID.schema29-runtime-before.json` deren unveränderten
Zustand und alle V1-Regionalheads. Weil PostgreSQL auch eine `NOT VALID`
0029-Check-Constraint bei jedem neuen Update durchsetzt, bereitet derselbe
digestgebundene One-shot ausschließlich die isolierte Game-Runtime-Kopie auf
den exakten validierten V1/V2-Formvertrag der 0030-Constraint vor. Der
Migrationsledger bleibt bei 29; Live-Datenbank und pristiner Restore werden
nicht verändert. Der V2-Vorher-Beleg bindet Definitionen, Validierungsstatus
und unveränderte V1-/V2-Zeilenzahlen. Dann starten ausschließlich das attestierte
alte Game- und Odoo-Image sowie
`quay.io/keycloak/keycloak:26.7.0@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13`
portlos im internen Netz `schema29-recovery`; die Live-Datenbanken sind dort
nicht auflösbar. Der alte Game-Server rechnet seinen ersten regionalen
Nachlauf noch vor dem HTTP-Listener. Compose wartet dafür höchstens zwei
Stunden; die Health-Startperiode ist exakt gleich lang, damit nur das harte
Wrapper-Limit und nicht ein kürzeres Docker-Retryfenster diesen Drill beendet.
Der Aggregate-Beleg verlangt:

- echten Game-/Odoo-/Keycloak-Health;
- mindestens eine vom echten alten `apps/game-api/dist/server.js` dauerhaft
  erhöhte Revision und Publishersequenz mit neuem State-Hash;
- den tatsächlich signierten Vorgängerpfad
  `/evidence/alpha-world-deployment.json` samt Dateihash und Deployment-Hash;
- den persistierten Keycloak-Realm `zugfolge`, alle fünf Produktionsclients,
  OIDC-/Token-Metadaten, JWKS und die Offline-/Refresh-Sitzungsinventur;
- eine transaktional zurückgerollte Game-Adapter-Probe sowie eine echte alte
  Odoo-ORM-/Attachment-Probe mit Blob-Schreiben, Odoo-/Direktlesen, `fsync`
  und vollständigem Cleanup;
- den verketteten Filestore-Open-/Seal-Vertrag: erst nach dem Before-Snapshot
  owner-writable, vor dem Aggregate-Qualifier wieder read-only und exakt auf
  dem Baseline-Baumhash, einschließlich des exakten physischen Host-Quellpfads;
- unveränderte pristine Game-/Odoo-Restores und den durchgehend read-only
  gemounteten pristine Odoo-Filestore.

Erst danach migriert der begrenzte Teiljournal-Runner sowohl Live-Game als auch
den pristinen Game-Restore ausschließlich mit 0030/0031. Er verweigert einen
bereits teilweise installierten 0032- oder 0033-Marker und publiziert
`$PRODUCTION_RECOVERY_ID.schema31-prepared.json`.

Der zweite One-shot muss diesen Schema-31-Beleg byte- und hashgleich einlesen:

```bash
bash tools/alpha-ops/compose-with-map-release-env.sh \
  --prepare-v2-cold -f /opt/zugfolge/compose.yml
```

Er erzeugt das vollständige Schema-31-Cold-Backup-/Restore-Paar und bindet den
Schema-29-Ausgangsdrill transitiv in
`$PRODUCTION_RECOVERY_ID.cold-qualified.json`.

Nur dieser Modus darf danach die initiale 0032/0033-DDL bis Zielkopf 33 starten:

```bash
bash tools/alpha-ops/compose-with-map-release-env.sh \
  --schema35-after-cold -f /opt/zugfolge/compose.yml
```

`game-schema33-migrate` prüft beide Receipt-Hashes, Containerinventar, den unveränderten
Schema-31-Game-Kopf, die Odoo-Datenbank und den Live-Filestore erneut. Erst
danach wird `packages/db/dist/migrate.js` im selben Prozess gestartet und der
Wrapper verlangt exakt 33 Migrationen einschließlich
`0033_operational_command_receipt_ledger`. Dessen weltgebundener Ledger trägt
den unveränderlichen `initialization_hash`; ein eigener BEFORE-UPDATE-Trigger
verweigert jede nachträgliche V2-Reinitialisierung, während der AFTER-Trigger
auch erfolgreiche Schema-31-Altwriter-Kommandos dauerhaft in den Ledger
übernimmt. Ein direktes `run game-migrate` ist gesperrt.

Noch bei gestoppten Schreibern folgt zwingend der Keycloak-Bestands-Cutover.
Vorher müssen die beiden in `.env` gesetzten Keycloak-Evidence-/Backup-
Hostpfade neu, getrennt, nicht verschachtelt und symlinkfrei sein; das
`KEYCLOAK_SCHEMA_RESTORE_DATABASE`-Ziel muss ein eigenes
`zugfolge_restore_*`-Ziel sein:

```bash
bash tools/alpha-ops/compose-with-map-release-env.sh \
  --keycloak-after-schema35 -f /opt/zugfolge/compose.yml
```

Dieser einzige Produktionsmodus prüft erneut den exakten Schema-33-Kopf,
erstellt das vollständige Shared-Database-Backup, stellt es in der isolierten
Keycloak-Prüfdatenbank wieder her und führt anschließend `bind-backup`,
`plan-up`, `up` und `preflight-up` aus. Der letzte Schritt akzeptiert nur einen
zum Live-Endpunkt und Objektkatalog passenden Up- oder Up-Recover-Receipt; ein
Fresh-Bootstrap-Receipt ist hier unzulässig. Bricht der Prozess nach dem
DB-Commit, aber vor dem Receipt ab, wird ausschließlich derselbe Plan über
`--keycloak-recover-after-schema35` wieder aufgenommen. Jeder andere Fehler
lässt alle Writer gestoppt.

Erst danach folgt der Hot-Drill:

```bash
bash tools/alpha-ops/compose-with-map-release-env.sh \
  --prepare-v2-hot -f /opt/zugfolge/compose.yml
```

Vor dem ersten Dump prüft `--prepare-v2-hot` Schema 33 und den installierten
Keycloak-Up-Vertrag erneut. Er erzeugt dann neue Schema-33-Dumps und
Operationsbelege, einen unabhängigen
Game-Prüfrestore, die beiden tatsächlichen create-only V1-Recovery-Ziele samt
Odoo-Filestore sowie `zugfolge-database-backup-manifest/v1`,
`zugfolge-database-restore-proof/v1` und
`zugfolge-database-rollback-proof/v3`. Erst dieser Hot-Beleg gehört in die
offline signierte Runtime-Rollback-Attestation. Der kalte Schema-31-Dump wird
niemals als Hot-Recovery-Beweis umgedeutet.

Die Runtime-Rollback-Attestation bindet dabei ausschließlich das tatsächlich
signierte `zugfolge-alpha-world-deployment/v1` des V1-Vorgängers. Das separate
`zugfolge-alpha-world-deployment/v2` des Kandidaten darf diesen Rückweg weder
ersetzen noch als kompatibler Ersatz akzeptiert werden. Der Prüfer dekodiert
dessen kanonische `$zugfolgeType=bigint`-Hüllen vor derselben Hashbildung wie
der ursprüngliche Runtime-Signaturprüfer; serialisierte Hüllenbytes und
Deployment-Hash bleiben zusätzlich unverändert gebunden. Welt-ID und V1-Schema
werden aus dem signierten `deployment`-Objekt der Hülle gelesen; ein historisches
flaches Testformat ist kein zulässiges Produktionsartefakt.

Nach Installation der signierten Attestation und des Trust-Keyrings wird der
Prüf-Postgres gestoppt. Danach erzeugt der aktuelle digestgebundene Prüfer die
Quiescence und zuletzt das gekoppelte Recovery-/Promotion-Paar:

```bash
bash tools/alpha-ops/compose-with-map-release-env.sh \
  -f /opt/zugfolge/compose.yml stop \
  recovery-verify-postgres recovery-verify-odoo-postgres
bash tools/alpha-ops/compose-with-map-release-env.sh \
  -f /opt/zugfolge/compose.yml run --rm --no-deps production-recovery-action \
  node tools/alpha-ops/create-production-recovery-quiescence.mjs
bash tools/alpha-ops/compose-with-map-release-env.sh \
  -f /opt/zugfolge/compose.yml run --rm --no-deps production-recovery-action \
  node tools/alpha-ops/create-production-recovery.mjs
bash tools/alpha-ops/compose-with-map-release-env.sh \
  -f /opt/zugfolge/compose.yml run --rm --no-deps production-recovery-action \
  node tools/alpha-ops/activate-production-recovery.mjs prepared
```

Die Quiescence sperrt beide Live-Datenbanken; danach darf kein weiterer Backup-
oder Upgrade-Schritt mehr laufen. Der normale `--quiesced-cutover` öffnet die
gekoppelten V2-Quellen erst nach `prepared` wieder. `odoo-upgrade` hängt direkt
an diesem vollständigen Gate und kann daher weder durch den kalten Receipt noch
durch einen bloßen Odoo-Dump freigegeben werden.

Alle Dumps, Restore-Ziele und Receipts sind create-new. Nach Reboot wird ein
vorhandener qualifizierter Receipt nur verifiziert, nicht überschrieben. Ein
abgebrochener Lauf ohne Promotion bleibt gesperrt; fremde oder halbfertige
Datenbanken werden nie automatisch gedroppt.

## 1. Wartungs-Fence erzeugen

Voraussetzung ist ein bereits gestoppter Anwendungsstack, bei dem nur die
beiden Datenbankcontainer weiterlaufen. Die Evidence-Wurzel muss existieren,
symlinkfrei, nicht breit und nur für den Betriebsaccount lesbar sein.

```bash
export PRODUCTION_RECOVERY_ID=rollback-2026.4-001
export PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID=infra-deutschland-2026.4
export PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID=infra-deutschland-2026.2
export PRODUCTION_RECOVERY_DOCKER_PROJECT=zugfolge
export PRODUCTION_RECOVERY_EVIDENCE_ROOT=/opt/zugfolge/recovery/rollback-2026.4-001/evidence
export PRODUCTION_RECOVERY_QUIESCENCE_OUTPUT_PATH="$PRODUCTION_RECOVERY_EVIDENCE_ROOT/quiescence.json"
export PRODUCTION_RECOVERY_GAME_ADMIN_DATABASE_URL='postgresql://…/postgres'
export PRODUCTION_RECOVERY_GAME_LIVE_DATABASE=zugfolge
export PRODUCTION_RECOVERY_ODOO_ADMIN_DATABASE_URL='postgresql://…/postgres'
export PRODUCTION_RECOVERY_ODOO_LIVE_DATABASE=zugfolge_odoo

node tools/alpha-ops/create-production-recovery-quiescence.mjs
```

Der Lauf ist zustandsändernd: Er sperrt beide aktuellen Datenbanken. Bei einem
Fehler bleibt der Zustand fail-closed im Wartungsmodus. Eine spätere
Abort-/Unfence-Prozedur darf die in der Quiescence gebundenen alten
Verbindungslimits nur nach erneuter Prüfung und ausdrücklicher Entscheidung
wiederherstellen.

## 2. Isolierte V1-Ziele create-only restoren

Der Game-Restore verwendet den vor dem Cutover erzeugten Dump und dessen
Rohmanifest. Das Ziel darf noch nicht existieren:

```bash
export PRODUCTION_RECOVERY_EVIDENCE_ROOT=/opt/zugfolge/recovery/rollback-2026.4-001/evidence

sh ops/alpha/restore-game-recovery.sh \
  'postgresql://…/postgres' \
  zugfolge_recovery_v1_2026_4_001 \
  /opt/zugfolge/rollback-material/game.dump \
  /opt/zugfolge/rollback-material/game.manifest.json \
  rollback-2026.4-001 \
  "$PRODUCTION_RECOVERY_EVIDENCE_ROOT/game-restore.json"
```

Odoo wird in eine andere Datenbank und einen neuen Filestore restauriert. Das
Archiv darf nur reguläre Odoo-Hashpfade enthalten; Symlinks, Hardlinks,
Gerätedateien, absolute Pfade und Traversal werden abgelehnt:

```bash
export PRODUCTION_RECOVERY_ODOO_FILESTORE_ROOT=/opt/zugfolge/recovery/rollback-2026.4-001/odoo-filestore

sh ops/alpha/restore-odoo-recovery.sh \
  'postgresql://…/postgres' \
  zugfolge_odoo_recovery_v1_2026_4_001 \
  "$PRODUCTION_RECOVERY_ODOO_FILESTORE_ROOT/zugfolge_odoo_recovery_v1_2026_4_001" \
  /opt/zugfolge/rollback-material/odoo-pre-cutover \
  /opt/zugfolge/rollback-material/odoo-pre-cutover.manifest.json \
  rollback-2026.4-001 \
  "$PRODUCTION_RECOVERY_EVIDENCE_ROOT/odoo-restore.json"
```

Beide Restore-Skripte räumen nur eine von ihnen selbst neu angelegte,
präfixgebundene Datenbank auf, solange diese noch nicht qualifiziert wurde.
Sie enthalten keinen Drop-Pfad für die alten Live-Datenbanken.

## 3. Gekoppeltes Recovery-Receipt und Promotion erzeugen

`create-production-recovery.mjs` benötigt zusätzlich zu den beiden neuen
Restore-Receipts folgende unveränderte Vor-Cutover-Artefakte:

- Game-Dump und `zugfolge-game-backup/v2`-Rohmanifest;
- `zugfolge-game-backup-operation/v1`;
- `zugfolge-database-backup-manifest/v1`;
- `zugfolge-database-restore-proof/v1`;
- `zugfolge-database-rollback-proof/v3`;
- Odoo-Dump, Filestorearchiv und `zugfolge-odoo-backup/v2`-Manifest.

Die Pfade werden über die gleichnamigen Variablen mit dem Präfix
`PRODUCTION_RECOVERY_` gesetzt. Verpflichtend sind insbesondere:

```dotenv
PRODUCTION_RECOVERY_QUIESCENCE_PATH=/opt/zugfolge/recovery/rollback-2026.4-001/evidence/quiescence.json
PRODUCTION_RECOVERY_GAME_DUMP_PATH=/opt/zugfolge/rollback-material/game.dump
PRODUCTION_RECOVERY_GAME_MANIFEST_PATH=/opt/zugfolge/rollback-material/game.manifest.json
PRODUCTION_RECOVERY_GAME_BACKUP_OPERATION_PATH=/opt/zugfolge/rollback-material/game.operation.json
PRODUCTION_RECOVERY_GAME_BACKUP_MANIFEST_PATH=/opt/zugfolge/rollback-material/database-backup-manifest.json
PRODUCTION_RECOVERY_GAME_RESTORE_PROOF_PATH=/opt/zugfolge/rollback-material/database-restore-proof.json
PRODUCTION_RECOVERY_DATABASE_ROLLBACK_PROOF_PATH=/opt/zugfolge/rollback-material/database-rollback-proof.json
PRODUCTION_RECOVERY_GAME_RESTORE_RECEIPT_PATH=/opt/zugfolge/recovery/rollback-2026.4-001/evidence/game-restore.json
PRODUCTION_RECOVERY_GAME_RESTORED_DATABASE_URL=postgresql://…/zugfolge_recovery_v1_2026_4_001
PRODUCTION_RECOVERY_GAME_LIVE_ADMIN_DATABASE_URL=postgresql://…/postgres
PRODUCTION_RECOVERY_GAME_RESTORE_ADMIN_DATABASE_URL=postgresql://…/postgres
PRODUCTION_RECOVERY_ODOO_DATABASE_DUMP_PATH=/opt/zugfolge/rollback-material/odoo-pre-cutover.database.dump
PRODUCTION_RECOVERY_ODOO_FILESTORE_ARCHIVE_PATH=/opt/zugfolge/rollback-material/odoo-pre-cutover.filestore.tar.gz
PRODUCTION_RECOVERY_ODOO_BACKUP_MANIFEST_PATH=/opt/zugfolge/rollback-material/odoo-pre-cutover.manifest.json
PRODUCTION_RECOVERY_ODOO_RESTORE_RECEIPT_PATH=/opt/zugfolge/recovery/rollback-2026.4-001/evidence/odoo-restore.json
PRODUCTION_RECOVERY_ODOO_RESTORED_DATABASE_URL=postgresql://…/zugfolge_odoo_recovery_v1_2026_4_001
PRODUCTION_RECOVERY_ODOO_RESTORED_FILESTORE_PATH=/opt/zugfolge/recovery/rollback-2026.4-001/odoo-filestore/zugfolge_odoo_recovery_v1_2026_4_001
PRODUCTION_RECOVERY_ODOO_LIVE_ADMIN_DATABASE_URL=postgresql://…/postgres
PRODUCTION_RECOVERY_ODOO_RESTORE_ADMIN_DATABASE_URL=postgresql://…/postgres
PRODUCTION_RECOVERY_RECEIPT_OUTPUT_PATH=/opt/zugfolge/recovery/rollback-2026.4-001/evidence/recovery.json
PRODUCTION_RECOVERY_PROMOTION_OUTPUT_PATH=/opt/zugfolge/recovery/rollback-2026.4-001/evidence/promotion.json
```

Danach:

```bash
node tools/alpha-ops/create-production-recovery.mjs
```

Nur das zuletzt erscheinende `promotion.json` ist der promotable Vertrag. Es
bindet das vollständige Recovery-Receipt, beide isolierten Datenbankziele, den
Odoo-Filestore und das Releasepaar über SHA-256 und kanonische Hashes.

## Aktivierung und Rückweg

Der kanonische Wrapper validiert `promotion.json` und das referenzierte Receipt
mit dem aktuellen digestgebundenen Prüfer, übernimmt beim expliziten Rollback
ausschließlich die darin gebundenen Game-/Keycloak- und Odoo-Zieldatenbanken
samt Filestore und startet keine V2-Migration, keinen Welt-Cutover, keinen
Bootstrap und kein Odoo-Upgrade. Die erhaltenen V2-Livequellen bleiben dabei
gefenced.

Der dafür eigene `attested-rollback`-Map-Preflight qualifiziert ausschließlich
den bereits aktiven Vorgängerpointer, dessen vollständiges installiertes
Paketinventar sowie die signierte Source-/Game-Image-/Odoo-Image-/Welt-/Map-/
Datenbank-Rollback-Attestation. Er liest oder akzeptiert keine
Kandidatenartefakte und kann deshalb einen belegten V1-Rückweg auch dann
freigeben, wenn die V2-Kandidatenqualifikation zuvor fail-closed abgebrochen ist.

Das Rollback-Compose bindet Odoos RW-Filestore nicht an die gesamte Recovery-
Wurzel, sondern exakt an das datenbankgleiche Kind
`${PRODUCTION_RECOVERY_ODOO_FILESTORE_HOST_ROOT}/${PRODUCTION_RECOVERY_ODOO_RESTORE_DATABASE}`
und mountet es ausschließlich nach
`/var/lib/odoo/filestore/${PRODUCTION_RECOVERY_ODOO_RESTORE_DATABASE}`. Eine
Root-RW- oder zweite Filestore-Bindung ist unzulässig.

Erstaktivierung und spätere Fortsetzung sind getrennte Zustandsübergänge. Fehlt
`<recovery-id>.activate.json`, führt der Wrapper nach dem aktuellen
`pre-activation`-Gate genau einmal `preflight` und `activate` aus. Dabei werden
der Erstaktivierungsbeleg und
`<recovery-id>.continuity-000000-origin.receipt.json` gekoppelt create-new
publiziert. Ein unvollständiges Paar ist nicht startbar und wird fail-closed
rückversiegelt. Sobald der Erstaktivierungsbeleg existiert, darf `activate`
nicht mehr als Neustartmechanismus dienen; der Wrapper ruft ausschließlich
`continue` auf.

Jeder weitere Stop/Start ist eine streng alternierende, append-only
Continuity-Kette: `origin(0) → reseal(1) → continue(2) → reseal(3) → …`.
Vor jeder Mutation erscheint ein bytegenau an den vorigen Receipt-Kopf
gebundener Intent. Der Abschlussbeleg bindet unverändert Recovery-ID,
Promotion, Datenbank-/Backendidentitäten, Welt, Weltepoche, Legacy-Images,
Runtime-Proof, Schema-, Guard-, Migrations- und Keycloak-Katalogvertrag. Für
alle Zielregionen müssen Revision und Publishersequenz gleich und monoton sein;
der Domain-Event- und die PostgreSQL-WAL-Köpfe dürfen ebenfalls nicht
zurücklaufen. Außerdem bindet jeder Kopf den vollständigen autoritativen
Game-Zustandshash, den vollständigen Keycloak-Identity-Zustandshash sowie Odoos
autoritativen Zustandshash und Anhangszahl. `continue` verlangt diese drei
versiegelten Werte exakt. Eine legitime Legacy-Revision `N → N+1` und dadurch
geänderte Game-/Keycloak-/Odoo-Köpfe oder ein geänderter Odoo-Filestore sind erst
mit dem folgenden `reseal` Teil der Kette. Fehlende,
manipulierte oder geforkte Belege, eine fremde Datenbank/Welt, ein anderer
Image-/Proof-Ursprung, Kopfrücklauf oder Teilöffnung schließen beide
Recovery-Datenbanken und den Filestore; ein nicht bestätigbarer Reseal ist ein
harter Fehler.

Der attestierte V1-Anwendungsrückweg ist keine Keycloak-Down-Migration. Sein
Rollback-Compose startet das alte Keycloak-Image gegen den unveränderten
Schema-33-Hot-Restore deshalb ausschließlich mit `KC_DB_SCHEMA=keycloak`.
`KC_DB_SCHEMA=public` bleibt auf den getrennten, portlosen
`schema29-keycloak-runtime` des realen Schema-29-Ausgangsdrills begrenzt; ein
Rollbackstart mit `public` gegen das Hot-Recovery-Ziel ist vertragswidrig und
wird in den Compose-Vertragstests ausgeschlossen.

Nach dem Start des Legacy-Keycloak, aber noch vor der Legacy-Game-API, erfasst
der aktuelle digestgebundene Prüfer den publishergleichen Regionalrevisionskopf
des Hot-Recovery-Ziels, strikt gefiltert auf die attestierte
`PRODUCTION_RECOVERY_PREVIOUS_WORLD_ID` und einschließlich ihrer exakten
Regionsmenge. Unmittelbar nach dem Game-API-Start wartet derselbe Prüfer
progress-aware auf `/health/ready` **und** eine gegenüber dieser Baseline neue
autoritative Revision in genau dieser Welt. Fortschritt einer fremden Welt oder
ein Wechsel der Regionsmenge darf das Gate nicht erfüllen. Odoo, Web, Livemap
und Operations Center starten erst danach. Jeder Readiness-, Fortschritts-,
Publisher-, Regions- oder Revisionsfehler löst den attestierten Reseal-/Stop-Pfad
aus; bloße Prozess-Liveness ist kein erfolgreicher Rückweg.

Die Rollback-Unit verwendet beim Stoppen und auch nach einem fehlgeschlagenen
Start `ExecStopPost` mit `--attested-rollback-stop`. Dieser Pfad stoppt zuerst
alle Writer, hängt den Continuity-`reseal` an und entfernt nach bestätigter
gekoppelter Versiegelung nur die Runtime-Dienste. `postgres` und
`odoo-postgres` bleiben mit genau den im Quiescence-Receipt gebundenen
Container-IDs bestehen; weder dieser Pfad noch der normale `--fixed-stop` darf
ein projektweites Compose-`down` ausführen. Ein direktes Container-`restart`
oder ein manueller Compose-Start umgeht diesen Vertrag und ist unzulässig.

Der normale Kandidatenstart führt seinerseits `production-recovery-action
prepared` vor jedem mutierenden Gate aus. Ein Reboot aktiviert deshalb weder
eine halbfertige Recovery noch öffnet er V2-Quellen still: Ohne vollständigen
Promotion-/Recovery-Vertrag bleiben alle Anwendungswriter aus.

Auch der Wechsel der persistenten Datenquellen ist append-only. Die erste
V2-Freigabe erzeugt
`<recovery-id>.source-transition-000001-release.{intent,receipt}.json`, der
V1-Rückweg hängt Sequenz 2 als `reseal` an und die Rückkehr zu V2 Sequenz 3
wieder als `release`. Weitere Wechsel alternieren entsprechend. Ein Replay des
bereits erreichten Kopfes ist idempotent; ein anderer Datenbankendpunkt oder
Backend-Ursprung, WAL-Rücklauf, Receipt-/Intent-Fork oder eine gekoppelte
Teilöffnung führt zur Kompensation auf zwei geschlossene V2-Livequellen. Die
statischen Pfade `<recovery-id>.source-release.json`,
`<recovery-id>.source-reseal.json` und ihre Intentvarianten sind nur
create-new-Anker und werden nie als überschreibbarer Zustand benutzt.

Lokal sind diese Verträge und die fehlerhaften/replayten Pfade ohne Docker
testbar. Vor der tatsächlichen Produktionsfreigabe bleiben dennoch ein
autorisierter STRATO-Lauf auf den realen Volumes, der dortige zweite
PostgreSQL-Restore und der echte Odoo-Filestore-Vergleich zwingende externe
Nachweise. Dazu gehört ein echter systemd-Drill mit Legacy-Revision `N → N+1`,
`stop`/Reseal, Reboot oder erneutem `start`/`continue` und anschließendem
Readiness-/Neurevisionsbeleg sowie ein echter
`release(1) → reseal(2) → release(3)`-Quellenwechsel. Die hier beschriebenen
Befehle sind keine Behauptung, dass dieser Serverbeweis bereits ausgeführt
wurde.
