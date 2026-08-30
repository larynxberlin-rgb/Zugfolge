# Zugfolge — geschlossene Alpha installieren

Diese Anleitung startet den selbst gehosteten Alpha-Stack reproduzierbar.
Odoo steuert Einladungen und Freigaben, Keycloak verwaltet Identitäten, und
ausschließlich das Game hält weltgebundene Konten, Zugänge und kurzlebige
Tutorialinstanzen. Odoo und Keycloak liegen nie im heißen Simulationspfad.

Die öffentlichen Dienste verwenden die bereits vom Host bereitgestellten
externen Netze `zugfolge-proxy` und `zugfolge-mail`. Compose verbindet
Game-Web als `zugfolge-world-web`, die Livemap als
`zugfolge-world-livemap`, Keycloak als `zugfolge-keycloak` und Odoo als
`zugfolge-odoo` mit dem Proxy. Keycloak und Odoo bleiben zugleich am
Mailnetz. Fehlt eines dieser beiden Netze, bricht Compose vor dem Start ab;
es gibt keinen unbemerkten, nur lokal erreichbaren Ersatzpfad.

## Voraussetzungen

- Linux-Host mit Docker Engine und Compose v2, mindestens 16 GiB RAM und
  40 GiB frei;
- Checkout dieses Repositories;
- separat rechtegeprüftes Alpha-Evidenzpaket unter `var/alpha-evidence/` mit
  signiertem `alpha-world-deployment.json`, Fleet-Katalog, InfraRelease und
  PMTiles/Static-Artefakten;
- parallel installierte Kartenpakete `.2` und `.4`, kanonisches Build-Evidence,
  Restore-Proof, tatsächlich wiederhergestellter Buildcache, öffentlicher
  Delivery-Keyring und externe `.2`-Bestandsattestation gemäß
  [`docs/kartenartefakte-installation.md`](docs/kartenartefakte-installation.md);
- in Keycloak unter **Realm settings → Email** eingerichteter SMTP-Server.

## Konfiguration und Start

```bash
cp .env.example .env
chmod 600 .env
$EDITOR .env
pnpm alpha:build
pnpm alpha:up
```

`alpha:build` akzeptiert ausschließlich einen vollständig sauberen Git-Checkout,
leitet den 40-stelligen Quellcommit selbst aus `HEAD` ab und prüft ihn vor und
nach dem Build. Der Alpha-Pfad erlaubt keinen separat eingespielten Deploypatch:
jede Änderung muss zuerst als Commit in `HEAD` gebunden sein, das OCI-Label
`de.zugfolge.deploy-patch` lautet deshalb verbindlich `none`. Danach prüft der
Build die eingebetteten Labels und protokolliert Image-ID beziehungsweise
Registry-Digest. Die ausgegebenen Zeilen
`ZUGFOLGE_GAME_API_IMAGE_REFERENCE=sha256:…` und
`ZUGFOLGE_ODOO_IMAGE_REFERENCE=sha256:…` werden anschließend bytegenau in
`.env` übernommen. `alpha:up` verwendet ausschließlich `--no-build`; alle 13
Game-, Prüf- und Webdienste sowie beide Odoo-Dienste beziehen ihre Images über
genau diese unveränderlichen IDs und mit `pull_policy: never`. Die mutablen
Namen `zugfolge-game-api` und `zugfolge-odoo:alpha` existieren ausschließlich
als Buildausgaben und werden von keinem `run`-/`up`-Pfad verwendet. Beide
Images tragen denselben geprüften Source-Commit und `deploy-patch=none`.

Auf dem Server ist die versionierte Repo-Vorlage vor Build oder Start als
kanonische Betriebsdatei zu installieren. `compose.yml` wird nicht separat
gepflegt oder von Hand geändert:

```bash
install -m 0644 /opt/zugfolge/compose.alpha.yml /opt/zugfolge/compose.yml
install -m 0644 /opt/zugfolge/compose.alpha.rollback.yml /opt/zugfolge/compose.rollback.yml
cmp --silent /opt/zugfolge/compose.alpha.yml /opt/zugfolge/compose.yml
cmp --silent /opt/zugfolge/compose.alpha.rollback.yml /opt/zugfolge/compose.rollback.yml
```

Build, Start, Stop und die Betriebsdrills rufen Compose ausschließlich über
`tools/alpha-ops/compose-with-map-release-env.sh` auf. Der Wrapper lädt zuerst
`/opt/zugfolge/.env` und danach den aktiven Kartenzeiger; letzterer bestimmt
damit als einzige Quelle Release-ID, Release-Mount und beide öffentlichen
Karten-URLs. Ein direkter `docker compose`-Aufruf ist kein freigegebener Start-
oder Rückweg und scheitert ohne die bewusst aus `.env` entfernten Pointerwerte.

Die Vorlage bindet genau ein signiertes Public-Deployment und den unveränderlichen
Kartenrelease `infra-deutschland-2026.4`. Dessen `read-model.sqlite` muss das
SQLite-`user_version` 3 besitzen; die Game API verweigert jedes ältere oder fremde
ReadModel beim Start. Tutorialwelten werden nicht statisch gebootstrapped.

`INFRA_RELEASE_TRUSTED_KEYS_JSON` bleibt der eine kanonische öffentliche
Release-Keyring. Jeder Wert muss exakt ein Ed25519-SPKI-Public-Key-PEM sein;
private PKCS8-Schlüssel, RSA-Schlüssel und nichtkanonische PEM-Serialisierungen
blockieren Preflight, Bootstrap und Game-Start. Der separate Vertrag
`RELEASE_TRUSTED_KEY_SCOPES_JSON` teilt sämtliche Key-IDs disjunkt in
`alphaWorldDeployments` und `mapInfraDeliveries`. Ein Alpha-Schlüssel kann damit
keinen Karten-/Infra-Release autorisieren und ein Map-/Infra-Schlüssel kein
Weltdeployment.
Der bereits signierte Kandidat `infra-deutschland-2026.3` ist verworfen und
nicht vertrauenswürdig; er darf weder Preflight- noch Aktivierungsquelle sein.

Der Produktionshost verwendet eine einzige Kartenwurzel. Auf dem aktuellen
Server ist das `/opt/zugfolge/maps`; darunter liegen `releases/` mit `.2` und
`.4`, der atomare Pointer unter `active/` und die externe Rollback-Attestation
unter `attestations/`. Drei zusätzliche, nur lesend in den One-shot-Container
gemountete Pfade werden in `.env` festgelegt:

```dotenv
MAP_RELEASE_DEPLOYMENT_HOST_ROOT=/opt/zugfolge/maps
MAP_RELEASE_PREFLIGHT_HOST_DIR=/opt/zugfolge/map-release-preflight
MAP_RELEASE_RESTORE_HOST_DIR=/opt/zugfolge/map-release-restore/infra-deutschland-2026.4
```

`/opt/zugfolge/maps/active/map-release.env` ist eine kanonische LF-Datei mit
genau den vier vom Evidence-Vertrag geprüften Werten. Für den aktivierten
Kandidaten lautet sie:

```dotenv
MAP_RELEASE_ID=infra-deutschland-2026.4
MAP_RELEASE_HOST_DIR=releases/infra-deutschland-2026.4
MAP_BASEMAP_STYLE_URL=/artifacts/maps/infra-deutschland-2026.4/style.json
MAP_GERMANY_PMTILES_URL=/artifacts/maps/infra-deutschland-2026.4/infra-deutschland-2026.4.pmtiles
```

Diese vier Variablen dürfen weder in `/opt/zugfolge/.env` noch in einem
weiteren Envfile dupliziert werden. Der Wrapper entfernt gleichnamige geerbte
Shellvariablen und ruft Compose stets in dieser Reihenfolge auf:

```bash
docker compose --env-file /opt/zugfolge/.env \
  --env-file /opt/zugfolge/maps/active/map-release.env \
  --project-name zugfolge \
  --project-directory /opt/zugfolge ...
```

Der Wrapper setzt den Projektnamen immer selbst auf `zugfolge` und verweigert
`-p`/`--project-name` sowie jede fremde Compose-Datei. Lokal ist ausschließlich
die Repo-Vorlage `compose.alpha.yml` zulässig, auf dem Server ausschließlich
deren installierte Kopie `/opt/zugfolge/compose.yml`. Damit treffen Build,
Start, Betriebsdrills, Rollback und Stop stets dieselben Container und Volumes.
Vor jedem Aufruf prüft der Wrapper zudem, dass eine verwendete `compose.yml`
bytegleich mit `compose.alpha.yml` ist; eine vergessene oder manuell veränderte
Serverkopie bricht vor Compose ab. Vor einem Rückweg gilt dieselbe Byteprüfung
zusätzlich für `compose.rollback.yml` gegen `compose.alpha.rollback.yml`.

Die Imageidentitäten stehen ausschließlich in `.env`. Der aktuelle Prüfer und
Stack verwenden `ZUGFOLGE_GAME_API_IMAGE_REFERENCE` und
`ZUGFOLGE_ODOO_IMAGE_REFERENCE`; der signierte Rückweg
bindet den nackten Digest in `MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST` und
die ausführbare Referenz in
`MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE`. Das vorherige Odoo-Image wird
getrennt über `PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST` und
`PRODUCTION_RECOVERY_ODOO_IMAGE_REFERENCE` gebunden. Eine Referenz darf entweder
die exakte lokale `sha256:…`-Image-ID oder eine kleingeschriebene
`repository/path@sha256:…`-Referenz sein. Der Wrapper extrahiert aus der
Legacy-Referenzen die Digests und verlangt Bytegleichheit mit den attestierten
Werten. Aktueller und alter Digest müssen je Imagefamilie verschieden sein. Mutable Tags,
Platzhalter, doppelte Einträge und geerbte Shell-Overrides brechen vor Compose
ab. Das aktuelle und das alte Image müssen bereits lokal vorhanden sein; der
Start zieht wegen `pull_policy: never` nichts nach.

`MAP_RELEASE_PREFLIGHT_HOST_DIR` stellt unter festen Namen
`evidence.json`, `restore-proof.json` und `trusted-delivery-keys.json`. Der
Restore-Pfad ist kein beliebiges Archivverzeichnis, sondern der durch den
kanonischen Leerpfadmarker vorbereitete und danach vollständig
wiederhergestellte Cache. Private Signaturschlüssel gehören in keinen dieser
Serverpfade.

Alle `replace-*`-Werte werden durch getrennte, zufällige Geheimnisse ersetzt.
Öffentliche URLs zeigen auf die tatsächlichen HTTPS-Adressen. Es gibt keine
Variable `ALPHA_TUTORIAL_WORLD_ID`, keine statische Tutorialwelt und keine
Phase-2-Startpaketkonfiguration. Der öffentliche Weltbestand enthält keinen
reservierten Startvertrag, kein Startfahrzeug, keine Starttrasse, kein
Startpersonal und kein Startprogramm.

Der öffentliche Geldstart kommt ausschließlich aus der signierten
`StartingCapitalPolicy` des Weltentwurfs. Odoo konfiguriert diesen Entwurf,
bleibt aber nur administrativer Kontrollpunkt; Signaturprüfung, Fachstart und
Ledger bleiben im Game.

Vor der Game API laufen drei fail-closed One-shot-Gates. Zuerst verifiziert
`map-release-preflight` beim normalen Compose-Start zwingend den Zustand
`active-candidate` für `.4`: beide installierten Pakete, Evidence, Cache-Restore,
Trust-Keyring, externe `.2`-Attestation und alle vier bereits auf `.4` stehenden
Pointerwerte müssen zusammenpassen. Erst danach wendet `game-migrate` den
vollständigen Drizzle-Migrationsstand an; `game-bootstrap` prüft
genau ein signiertes öffentliches Weltdeployment und legt dessen Welt- und
Planning-Authority-Bindung an. Ein Widerspruch zur bestehenden Datenbank
bricht den Start ab; statische Tutorialdeployments sind verboten.

Keycloak verwendet dieselbe PostgreSQL-Instanz, aber ausschließlich das eigene
Schema `keycloak`. Der normale Start führt keine Schema-DDL aus: Ein separates
`keycloak-schema-preflight` verlangt den exakten Keycloak-26.7.0-PG16-Katalog
und einen installierten Cutover-/Bootstrap-Receipt. Erst danach startet das auf
einen OCI-Digest gepinnte Keycloak mit `KC_DB_SCHEMA=keycloak`; ein
`keycloak-schema-postflight` sperrt den nachfolgenden Weltbootstrap bei jeder
Abweichung. Der Weltbootstrap stabilisiert den v3-Keycloak-Kopf unter einem
begrenzten `SHARE`-Lock aller 100 Tabellen; erst danach darf der Clientabgleich
Realm- oder Clientzeilen verändern. Die einmalige, reversible und vollständig
quieszierte Migration aus `public` läuft im Produktions-Cutover nur über den
kanonischen Wrappermodus `--keycloak-after-schema33`; das darin gekapselte
Compose-Profil `keycloak-schema-migration` ist beschrieben in
[`docs/keycloak-schema-migration.md`](docs/keycloak-schema-migration.md).

Der normale Start setzt einen bereits erzeugten
`zugfolge-database-rollback-proof/v3` voraus. Deshalb werden beim erstmaligen
V1-V2-Cutover zuerst alle Game-, Scheduler-, Keycloak- und Bridge-Writer
gestoppt; die vorhandenen Datenbankcontainer bleiben für die Wartungsbefehle
unter derselben Identität erreichbar. Vor der ersten Schema-32/33-DDL ist ein
**kalter Schema-29-Vollbackup-/Restore- und Legacy-Runtime-Drill** Pflicht. Die drei rootgeschützten
Hostwurzeln `material`, `evidence` und `odoo-filestore` müssen bereits getrennt
und symlinkfrei existieren. `--prepare-v2-schema31` erzeugt create-new einen
vollständigen Game-Dump samt pristinem Restore auf der separaten
`recovery-verify-postgres`-Instanz sowie einen Odoo-Dump mit passendem
Filestore-Restore auf der zweiten Instanz `recovery-verify-odoo-postgres`.
Zusätzliche Runtime-Restores werden vor dem Prozessstart read-only
gesnapshottet. Der aktuelle, digestgebundene Prüfer ersetzt danach ausschließlich
in der create-new Game-Runtime-Kopie die unvalidierte 0029-Constraint durch den
exakten validierten V1/V2-Formvertrag aus 0030; Migrationsledger, Live-Datenbank
und pristiner Restore bleiben dabei unverändert. Der V2-Vorher-Beleg bindet die
Definitionen vor/nach der Änderung, Validierungsstatus und unveränderte
Zeilenzahlen. Erst danach öffnet ein netzloser Root-One-shot ausschließlich
die Odoo-Runtime-Kopie für den gebundenen Nicht-root-Owner; die pristine Kopie
ist nie Teil eines RW-Mounts. Dann starten exakt das attestierte alte
Game-/Odoo-Image und Keycloak 26.7.0 portlos im internen
`schema29-recovery`-Netz. Der echte alte
`apps/game-api/dist/server.js` muss dort Revision, Publishersequenz und
State-Hash dauerhaft fortschreiben; Realm, Clients, OIDC/JWKS und Odoo-Health
werden mitgebunden. Die alte Odoo-Probe muss zusätzlich ein echtes Attachment
in den Filestore schreiben, über Odoo und direkt bytegleich lesen, Blob und
Verzeichnis `fsync`en, ihre Datenbanktransaktion zurückrollen und die neu
erzeugten Hashpfade vollständig entfernen. Danach stoppt Odoo, die
Runtime-Kopie wird wieder read-only auf den Baseline-Baumhash versiegelt und
Odoo für den abschließenden Health-/Qualifier-Beweis mit denselben Rechten neu
gestartet. Der Qualifier bindet dabei die von Docker gemeldete physische
Mount-Quelle exakt an das datenbankbenannte Runtime-Kind; eine gleichlautende
Container-Destination allein reicht nicht. Die pristinen Restores dürfen sich
dabei nicht ändern. Erst danach
wendet derselbe One-shot
ausschließlich 0030 und 0031 auf Live-Game und pristinen Game-Restore an und
publiziert den Schema-31-Vorbereitungsbeleg.

Der echte alte Game-Server führt seinen ersten regionalen 1:1-Nachlauf noch
vor dem HTTP-Listener aus. Dieser isolierte Legacy-Lauf besitzt deshalb ein
festes hartes Zwei-Stunden-Limit; der allgemeine 600-Sekunden-Timeout der
übrigen Recovery-One-shots darf ihn nicht vor dem belegten ersten
Scheduler-/Publisherfortschritt abbrechen. Seine Docker-Health-Startperiode
ist auf dieselben zwei Stunden gebunden: Ein früher erfolgreicher Check beendet
die Startperiode sofort, ein noch rechnender Cold-Catch-up wird jedoch nicht
vor dem Wrapper-Limit als `unhealthy` abgebrochen.

`--prepare-v2-cold` liest diesen Beleg bytegenau erneut, erzeugt und qualifiziert
das gekoppelte Schema-31-Backup-/Restore-Paar. Erst der dritte One-shot darf
danach im selben digestgebundenen Prozess die Migrationen 0032 und 0033 bis
zum exakten Zielkopf 33 anwenden:

```bash
bash tools/alpha-ops/compose-with-map-release-env.sh \
  --prepare-v2-schema31 -f /opt/zugfolge/compose.yml
bash tools/alpha-ops/compose-with-map-release-env.sh \
  --prepare-v2-cold -f /opt/zugfolge/compose.yml
bash tools/alpha-ops/compose-with-map-release-env.sh \
  --schema33-after-cold -f /opt/zugfolge/compose.yml
bash tools/alpha-ops/compose-with-map-release-env.sh \
  --keycloak-after-schema33 -f /opt/zugfolge/compose.yml
```

Ein direktes `run game-migrate` ist im kanonischen Wrapper gesperrt. Auch
`odoo-upgrade`, Keycloak-Schemamigration/-Restore und `game-bootstrap` dürfen
das automatische Production-Recovery-Gate nicht mit `--no-deps` umgehen. Vor
dem Keycloak-Modus müssen `KEYCLOAK_SCHEMA_EVIDENCE_HOST_DIR` und
`KEYCLOAK_SCHEMA_BACKUP_HOST_DIR` auf zwei neue, getrennte, nicht verschachtelte
und symlinkfreie Operatorverzeichnisse zeigen;
`KEYCLOAK_SCHEMA_RESTORE_DATABASE` muss ein eigenes `zugfolge_restore_*`-Ziel
sein. Der Modus prüft zuerst erneut exakt Schema 33, erstellt dann das
vollständige Shared-Database-Backup, stellt es isoliert wieder her und führt
`bind-backup` → `plan-up` → `up` aus. Erst `preflight-up` akzeptiert den
installierten Up- oder Up-Recover-Receipt gegen den weiterhin gestoppten
Livezustand; ein Fresh-Bootstrap-Receipt ist für diesen Bestands-Cutover
unzulässig. Ein Prozessabbruch nach dem Up-Commit darf nur mit demselben Plan
über `--keycloak-recover-after-schema33` abgeschlossen werden.

Diese vorbereitenden Modi verwenden kein `down`, überschreiben kein vorhandenes
Artefakt und droppen keine Live-Datenbank. Nach dem Keycloak-Postcheck bleiben
die Writer gestoppt. `--prepare-v2-hot` prüft Schema 33 und denselben gültigen
Keycloak-Up-Vertrag nochmals **vor** dem ersten Hot-Backup. Erst dann erzeugt der
Hot-Drill frische Game-/Odoo-Dumps, den erneuten
Game-Restore auf dem Prüf-Postgres, beide produktiven create-only
Recovery-Ziele samt Odoo-Filestore und danach den vollständigen
Backup-/Restore- sowie Datenbank-Rollback-Proof:

```bash
bash tools/alpha-ops/compose-with-map-release-env.sh \
  --prepare-v2-hot -f /opt/zugfolge/compose.yml
```

`create-database-backup-restore-evidence.mjs` qualifiziert diese realen
Ergebnisse zum kanonischen Backup-/Restore-Paar; anschließend vergleicht
`create-database-rollback-proof.mjs` beide weiterhin quieszierten
Datenbanken. Der Beleg bindet dieselbe restaurierbare DB-UUID, das
exakte Ledger, Constraints und Unveränderlichkeits-Guards, den
Welt-/Runtime-/Event-Kopf sowie den vollständigen Keycloak-Identity-Head über
alle 100 Identitätstabellen. Erst dieser Beleg wird in die signierte
Runtime-Rollback-Attestation aufgenommen und nach `/map-preflight` installiert.
Eine fremde, nur strukturgleiche Datenbank ist nicht zulässig.

Erst wenn danach Quiescence, beide Hot-Restore-Receipts, signierte
Runtime-Attestation, `recovery.json` und das zuletzt publizierte
`promotion.json` vollständig vorliegen, kann `production-recovery-action`
`prepared` erfolgreich abschließen. `odoo-upgrade` hängt direkt an genau diesem
One-shot; der kalte Schema-31-Beleg oder ein bloßes Odoo-Backup reichen nicht.
Der vollständige Ablauf und alle create-new Pfade stehen in
[`docs/produktions-recovery-v2-v1.md`](docs/produktions-recovery-v2-v1.md).

Schema 32 installiert keine Schreib-Fence über bereits gestrandetem Queue-
Zustand. Vor der Migration müssen deshalb alle unquittierten Economy-Effekte
und Odoo-Projektionen archivierter Welten unter dem alten Schema erfolgreich
quittiert sein. Findet die Migration noch `economy_outbox.processed_at IS NULL`
oder `odoo_projection_outbox.delivered_at IS NULL` für eine archivierte Welt,
bricht sie atomar ab. Die Zeile wird weder gelöscht noch nachträglich von der
Welt-Autorität ausgenommen: erst unter Schema 31 idempotent zustellen und
quittieren, dann den gekoppelten Schema-32/33-One-shot erneut anwenden. Danach verweigert jede neue
Archivierung den Commit, solange eine der beiden Outboxes noch offen ist.

Die persistente Odoo-Datenbank wird vor dem normalen Odoo-Webprozess durch den
One-shot `odoo-upgrade` aktualisiert. Er führt für bestehende Installationen
explizit `--update=zugfolge_admin --stop-after-init` aus und installiert das
Modul bei einer leeren Datenbank zugleich initial. Erst ein erfolgreicher
Abschluss startet den Dienst `odoo`. Für `19.0.2.0.4` hebt die Migration einen
vorhandenen unveränderten Deployment-Spiegel auf Generation 1 und schreibt
dessen alten Deployment- und Blueprint-Hash als ersten unveränderlichen
Auditbeleg; sie löscht keinen Spiegel und ist wiederholbar. Vor diesem Schritt
ist das Odoo-DB-/Filestore-Backup Pflicht. Dieses Backfill beschreibt nur die
vorhandene Odoo-Spiegelgeneration; es ändert nicht den Vertrag des autorisierten
v1→v2-Hard-Cutovers. Der Hard-Cutover übernimmt die alte `world_id` nicht: Er
archiviert und versiegelt die freigegebene V1-Welt unverändert unter ihrer
bisherigen ID und startet eine neue, zuvor unbenutzte V2-`world_id` mit
`deploymentRevision: 1`. `deploymentRevision: 2` gilt erst für eine spätere,
neu signierte Deploymentgeneration derselben V2-Welt nach ihrer Generation 1.
Normale Monitoringprojektionen können diese Revision nicht erhöhen.

Die vorhandene `.2`-Attestation im Schema
`zugfolge-map-rollback-attestation/v1` bindet nur Kartenbytes. Sie ist daher
ausdrücklich **kein** ausführbares Laufzeit-Rollback: Der normale `.4`-Gate darf
mit `rollbackEligible: false` und dem Grund `runtime-tuple-unbound-v1` starten,
der explizite Modus `pre-activation` verweigert dagegen den Start. Das alte
DB-Volume, die alten Images und die `.2`-Artefakte bleiben forensisch erhalten;
die Rollback-Unit bleibt deaktiviert.

Ein manueller `.2`-Vorlauf ist erst zulässig, wenn eine v3-Attestation zusätzlich
den exakten Source-Commit, getrennte OCI-Image-Digests für Game und Odoo, das Ed25519-signierte
Weltdeployment, ReadModel-Schema und Zeitvertrag sowie Zugprojektionsschema,
Welt-ID und Deployment-Hash koppelt. Der aktuelle, separat digestgebundene
Prüfer erhält dieselbe Legacy-Runtimeidentität über die
`MAP_RELEASE_PREFLIGHT_RUNTIME_*`-Variablen und
`PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST`. Der attestierte Game-Image-Digest muss
zugleich der Digest der unveränderlichen
`MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE` im gesonderten
Legacy-Compose-Vertrag sein; ein lokaler Tag oder ein bloßer, nicht an die
Compose-Referenz gekoppelter Envwert ist keine Freigabe. Erst dann kann der
read-only Vorlauf im selben Compose-Projekt mit der aktuellen Compose-Datei
ausgeführt werden:

```bash
bash /opt/zugfolge/tools/alpha-ops/compose-with-map-release-env.sh \
  -f /opt/zugfolge/compose.yml run --rm --no-deps \
  map-release-preflight \
  node tools/alpha-ops/map-release-deployment-preflight.mjs pre-activation
```

Dieses Kommando ist nur erfolgreich, wenn der Pointer exakt die vier `.2`-Werte
enthält, `.4` trotzdem vollständig sowie signiert installiert ist und das
aktuelle Source-/Image-/Welt-/Map-Tuple bytegenau der signierten v3-Attestation
entspricht.
Danach wird der vorbereitete Pointer atomar auf die vier `.4`-Werte gesetzt.
Der reguläre Start stoppt zuerst alle bekannten Anwendungs-Writer, erhält aber
die Identität und Volumes von `postgres` und `odoo-postgres`, startet beide mit
`--no-recreate` und wiederholt den Gate danach ohne Fallback ausschließlich als
`active-candidate`. Dieser quieszierende Schritt ist Pflicht: Ein alter Game-
oder Odoo-Writer darf Migration und atomaren Weltwechsel nicht überleben.

```bash
bash /opt/zugfolge/tools/alpha-ops/compose-with-map-release-env.sh \
  --quiesced-cutover -f /opt/zugfolge/compose.yml up --no-build --wait
```

Das interne Compose-`up --wait` bestaetigt dabei absichtlich nur Container-
und Prozess-Liveness und ist fuer sich allein **kein Aktivierungserfolg**. Der
Wrapper wartet danach innerhalb des Game-Containers separat auf
`/health/ready`. Ein langer Deutschland-Cold-Catch-up darf weiterlaufen,
solange `/metrics` aktuellen Schedulerfortschritt belegt; Stillstand, ein
anderer Down-Check oder das harte Zwei-Stunden-Limit loesen vor der
Erfolgsmarke den fail-closed Cleanup aus. Der Systemd-Start umfasst dieses
Readiness-Gate ebenfalls.

Der Wrapper führt dabei ausdrücklich kein `down` aus. Ein direktes `up` ohne
`--quiesced-cutover` wird verweigert. Schlägt der `.4`-Gate
fehl, starten weder Migration noch Bootstrap oder Game API. `.2` wird im normalen Startpfad niemals automatisch aktiviert.
Im gesperrten Bootstrap wird `proof.source` vor der ersten Weltmutation erneut
mit dem Live-Kopf verglichen. Der V1-Endzustand wird über `final_state_hash`
versiegelt; Weltwechsel und unveränderlicher DB-Cutover-Receipt liegen in
derselben `READ COMMITTED`-Transaktion hinter exklusiven, lexikographisch
geordneten Candidate-/Predecessor-World-Locks. Alle 50 weltgebundenen Tabellen
nehmen bei INSERT, UPDATE und DELETE dauerhaft denselben Shared-Xact-Lock;
damit wird ein bereits schreibender Commit vor dem Receipt sichtbar, während
ein erst nach Beginn des Cutovers fortgesetzter Writer den archivierten Zustand
erneut liest und fail-closed scheitert. Wiederholte V2-Starts akzeptieren nur
den bereits zur Kandidatenwelt passenden Receipt.
Zusätzlich werden die V1-Regionalheads persistent als
`legacy_writer_fenced=true` markiert. Der Datenbanktrigger blockiert dadurch
auch eine fremde, bereits offene Alt-Sitzung nach dem Commit bei Update und
Delete fail-closed. Der finale V1-Hash umfasst den eingecheckten vollständigen
Satz weltgebundener Schema-33-Tabellen einschließlich
`regional_simulation_command_receipts`; dessen Schlüssel und Fremdschlüssel
binden jedes Kommando zusätzlich an den unveränderlichen
`initialization_hash`. Schema 33 verweigert eine nachträgliche Änderung dieser
V2-Initialisierungsbindung; eine Reinitialisierung ist nur als Delete mit
kaskadiertem Ledger und anschließendem neuen Insert zulässig. Der
Retry-Receipt wird aus allen gespeicherten Spalten kanonisch nachgerechnet.

Auf dem Produktionshost übernimmt die mitgelieferte
`ops/alpha/zugfolge-alpha.service` auch den Boot- und Stopppfad. Normal- und
Rollback-Unit werden gemeinsam installiert, danach wird ausschließlich der
Normaldienst aktiviert:

```bash
install -m 0644 /opt/zugfolge/ops/alpha/zugfolge-alpha.service \
  /opt/zugfolge/ops/alpha/zugfolge-alpha-rollback.service \
  /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now zugfolge-alpha.service
```

Auch `ExecStart`, `ExecStop` und der Rollback-`ExecStopPost`
verwenden ausschließlich den Wrapper. Zusätzlich führen Game API und Livemap
den vollständigen read-only `active-candidate`-Preflight bei jedem eigenen
Prozessstart erneut aus. Damit umgehen weder `docker compose restart game-api`,
ein Containerneustart noch ein Host-Reboot Evidence, Pointer, Trust-Keyring
oder Cache-Restore; bei jeder Abweichung bleibt der jeweilige Prozess aus.
Der Stopppfad verwendet den eng begrenzten Wrappermodus `--fixed-stop`. Er darf
ausschließlich mit der externen Aktion `down` gegen `/opt/zugfolge/compose.yml`
und das feste Projekt `zugfolge` aufgerufen werden. Intern stoppt und entfernt
er jedoch nur die kanonischen Runtime-Dienste; `postgres` und `odoo-postgres`
bleiben mit ihren von der Quiescence gebundenen Container-IDs erhalten. Deshalb
bleibt das Abschalten auch bei fehlendem oder beschädigtem Kartenzeiger möglich,
ohne einen späteren Rollback-/Continuation-Start durch neu erzeugte
Datenbankcontainer zu entwerten. Der normale Start- und Rollbackpfad bleibt
weiterhin vollständig pointer- und evidence-geprüft und fail-closed.

Ein durch eine v3-Attestation freigegebener `.2`-Rückweg ist bewusst kein
automatischer Fallback. Dafür wird zusätzlich
`ops/alpha/zugfolge-alpha-rollback.service` installiert. Die
beiden Units schließen einander aus. Ein autorisierter Rückweg stoppt zuerst
den normalen Dienst, tauscht dann den Pointer atomar auf die vier geprüften
`.2`-Werte und aktiviert erst anschließend den persistenten Rollbackdienst:

```bash
systemctl disable --now zugfolge-alpha.service
# maps/active/map-release.env jetzt atomar auf die attestierten .2-Werte setzen
systemctl enable --now zugfolge-alpha-rollback.service
```

Mit der real vorhandenen v1-Bestandsattestation darf dieser Ablauf nicht
ausgeführt werden; die Unit scheitert geschlossen und bleibt deaktiviert. Erst
nach Aufbau und separater Abnahme eines vollständigen Legacy-Images,
Legacy-Weltdeployments und passender `.2`-SQLite-Artefakte darf eine v3-
Attestation erstellt und die Unit autorisiert werden.

Die Rollback-Unit ruft den Wrapper ausschließlich mit
`--attested-rollback` auf. Dieser Modus prüft zuerst beide Compose-Dateien und
beide getrennten Imagebindungen, beendet dann den bekannten Stack und führt
`map-release-preflight` einmalig im **aktuellen** unveränderlichen Prüfer-Image
mit `pre-activation` aus. Fehlt danach der create-new
`<recovery-id>.activate.json`, folgen genau einmal Recovery-`preflight` und
`activate`; der Aktivierungsbeleg wird mit dem
`continuity-000000-origin`-Receipt gekoppelt. Existiert der Beleg bereits, etwa
nach einem legitimen Legacy-Schreibintervall und Stop, ist eine erneute
Erstaktivierung verboten: Der Wrapper verlangt stattdessen die nächste
append-only `continue`-Transition aus demselben Recovery-/Datenbank-/Backend-/
Welt-/Image-/Proof-Ursprung. Fehlender Ursprung, Kopfrücklauf, ein fremder
Ursprung oder eine Teilöffnung versiegeln beide Recovery-Ziele und den
Odoo-Filestore, bevor ein Legacy-Prozess starten kann. Der versiegelte Kopf
bindet zusätzlich den vollständigen autoritativen Game-Zustandshash, den
Keycloak-Identity-Zustandshash sowie Odoos autoritativen Zustandshash und
Anhangszahl. `continue` verlangt diese drei Köpfe exakt; erst ein erfolgreicher
`reseal` darf nach einem legitimen Schreibintervall neue Werte fortschreiben.

Erst nach diesem Erfolg lädt der Wrapper den versionierten Legacy-Override.
Dieser startet das alte Keycloak-Image ausdrücklich mit
`KC_DB_SCHEMA=keycloak`, weil der attestierte Anwendungsrückweg den
unveränderten Schema-33-Hot-Restore verwendet und **keine** Keycloak-
Down-Migration ausführt. `game-api`, `game-web`, `livemap`,
`operations-center` und `static` werden an die attestierte Legacy-Game-
Referenz gebunden; `odoo` verwendet getrennt die attestierte Legacy-Odoo-
Referenz. Game API und Livemap verwenden direkte alte Serverkommandos und sind
deshalb nicht von einem erst im aktuellen Image vorhandenen Startwrapper
abhängig.

Der Rückweg startet anschließend mit `--no-deps --no-build --force-recreate`
nur die explizite Folge beide PostgreSQL-Dienste → Keycloak → Game API →
Readiness-/Revisionsbeweis → Odoo → Game Web/Livemap/Operations Center/Static →
Prometheus/Grafana.
Unmittelbar vor dem Game-API-Start liest der aktuelle digestgebundene Prüfer die
Summe der publishergleichen Regionalrevisionen ausschließlich für die
attestierte `PRODUCTION_RECOVERY_PREVIOUS_WORLD_ID` und bindet deren exakte
Regionsmenge. Direkt nach dem Start muss derselbe Prüfer `/health/ready`
progress-aware erreichen und in genau dieser Welt mindestens eine neue
autoritative Revision belegen; Fortschritt einer anderen Welt zählt nicht.
Erst danach starten Odoo und die Oberflächen. Ein stagnierender Scheduler, ein
Regionswechsel, ein anderer Readiness-Blocker, eine Publisherlücke oder ein
Timeout löst den bestehenden Reseal-/Stop-Pfad aus.
`world-deployment-cutover-preflight`, `game-migrate`, `game-bootstrap`, beide
Keycloak-Schema-Gates und `keycloak-reconcile` werden gegen die restaurierte
V1-Datenbank ausdrücklich **nicht** ausgeführt. Eine V2-Migration oder ein
erneuter V1→V2-Cutover kann den Rückweg daher nicht verändern. Schlägt eine
Stufe fehl, beendet der Wrapper die bereits gestarteten Legacy-Dienste wieder.
Der Rollback-`ExecStopPost` ruft unabhängig vom Startausgang
`--attested-rollback-stop` auf: erst Writer stoppen, dann die nächste
Continuity-`reseal`-Transition publizieren, anschließend ausschließlich die
Runtime-Dienste entfernen. Beide PostgreSQL-Container bleiben erhalten. Der
Modus bleibt durch die aktivierte Unit auch nach einem Host-Reboot erhalten;
der neue Start verwendet `continue`, nicht erneut `activate`. Ein bloßes
`restart` bestehender Container ist kein Rückweg. Ein fremder
Shellwert kann weder Modus noch Image wechseln. Stimmen Pointer, Evidence,
Legacy-Digest/-Referenz und expliziter Modus nicht überein, startet keine alte
Runtime. Die Datenbank muss davor auf das gebundene, getestete Hot-Recovery-Ziel
umgeschaltet worden sein; dessen Keycloak-Katalog bleibt im Schema `keycloak`.
Nur der getrennte echte Schema-29-Ausgangsdrill verwendet
`schema29-keycloak-runtime` mit `KC_DB_SCHEMA=public`. Der Rollbackdienst selbst
führt weder Restore noch Schemaänderung aus.

Zur Rückkehr auf `.4` wird symmetrisch zuerst die Rollback-Unit gestoppt, dann
der Pointer atomar auf `.4` gesetzt und zuletzt der normale Dienst aktiviert:

```bash
systemctl disable --now zugfolge-alpha-rollback.service
# maps/active/map-release.env jetzt atomar auf die geprüften .4-Werte setzen
systemctl enable --now zugfolge-alpha.service
```

Die Datenquellen werden dabei nicht über einen überschreibbaren Schalter
verwaltet. Der erste `.4`-Start publiziert append-only
`source-transition-000001-release`, der V1-Rückweg Sequenz 2 als `reseal` und
dieser erneute `.4`-Start Sequenz 3 als `release`; spätere Wechsel alternieren
weiter. Replays des erreichten Zustands sind idempotent. Fremde Datenbank- oder
Backendidentitäten, WAL-Rücklauf, Intent-/Receipt-Forks und Teilöffnungen
kompensieren beide V2-Livequellen auf geschlossen.

Vor der Produktionsfreigabe bleibt ein echter systemd-Continuity-Drill Pflicht:
Legacy-Game muss von Revision `N` auf `N+1` fortschreiten, der Unit-Stop muss
Recovery und Quellen bestätigt resealen, und ein Neustart/Reboot muss aus
derselben Linie per `continue` erneut Readiness plus neue Revision erreichen.
Zusätzlich ist der reale Quellenzyklus
`release(1) → reseal(2) → release(3)` gegen die produktiven PostgreSQL-Backends
zu belegen. Lokale Vertragstests ersetzen diese STRATO-Abnahme nicht.

Der Start verwendet die vorgebauten Rust-NAPI- und Node-/Web-Artefakte, startet
nach Abhängigkeiten und prüft die Health-Endpunkte. PostgreSQL →
Keycloak-Schema-Preflight → Keycloak → Keycloak-Schema-Postflight → regionale
Single-Writer/Game API → Scheduler/Livemap → Bridge/Odoo-Projektion ist die
bindende Reihenfolge. PostgreSQL übernimmt die persistente Queue; ein Broker
wird erst nach Messbeweis eingeführt.

Für einen gemeinsamen HTTPS-Ursprung mit Pfadpräfixen werden beim Imagebau
`LIVEMAP_BASE_PATH` und `OPERATIONS_CENTER_BASE_PATH` gesetzt. Das
Operations-Center erhält `OPERATIONS_CENTER_GAME_API_URL`; der statische
Livemap-Dienst injiziert `LIVEMAP_OIDC_CLIENT_ID` zur Laufzeit in beide
PKCE-Aufrufe (Authorization und Token). Mit `LIVEMAP_OIDC_CLIENT_ID=game-web`
kann er denselben öffentlichen Client wie das Game Web verwenden. Der
Standardwert ist `livemap`; diese Werte enthalten keine Geheimnisse.

## Keycloak und Odoo

Der Realmimport `ops/alpha/keycloak/zugfolge-realm.json` enthält die Clients
`game-web`, `livemap`, `operations-center`, die Audience `game-api`, Rollen sowie
Required Actions. Das Servicekonto `provisioner` benötigt `manage-users`,
`view-users`, `query-users`, `manage-realm` und `manage-clients`. Die beiden
Verwaltungsrollen sind für den idempotenten Abgleich der Sitzungslaufzeiten und
Browser-Clients erforderlich; sie ersetzen keinen allgemeinen Bootstrap-Admin.
Bei einer bestehenden Installation müssen diese beiden Rollen dem vorhandenen
Servicekonto vor dem ersten Start von `keycloak-reconcile` einmalig zugewiesen
und mit einem frischen Client-Credentials-Token geprüft werden.

In Odoo unter **Einstellungen → Technisch → Systemparameter** setzen:

- `zugfolge_admin.game_webhook_url` =
  `http://game-api:3000/integrations/odoo/webhooks`;
- `zugfolge_admin.actor_reference` = `odoo-alpha-admin`;
- Webhook-Key und Secret passend zu `ODOO_WEBHOOK_KEYS_JSON`;
- Projektions-Key passend zu `ODOO_PROJECTION_SECRET`.

Bei einer bereits installierten Odoo-Datenbank vor dem Neustart Datenbank und
Filestore gemeinsam sichern und das Add-on einmalig im Odoo-Container mit
denselben DB-, Add-on- und `queue_job`-Parametern wie im Normalbetrieb sowie
`-u zugfolge_admin --stop-after-init` aktualisieren. Der vollständige Befehl
steht in [`docs/odoo-betrieb.md`](docs/odoo-betrieb.md). `--init` im
Compose-Start ersetzt dieses kontrollierte Upgrade nicht.

## Einladungen und persönlicher Tutorialstart

1. In Odoo **Zugfolge → Alpha-Einladungen → Neu** öffnen.
2. E-Mail, Anzeigename, öffentliche Zielwelt und Rolle erfassen.
3. **Einladung senden**. Der signierte Antrag erzeugt idempotent die
   Keycloak-Identität und ausschließlich `worldAccesses`, `accounts` und Rolle
   der öffentlichen Zielwelt. Es entsteht noch keine Tutorialwelt und kein
   Tutorialkonto.
4. Nach Anmeldung ruft Game Web
   `POST /worlds/:publicWorldId/tutorial-sessions` auf. Das Game sperrt das
   öffentliche Weltkonto und setzt eine vorhandene aktive Sitzung fort oder
   erzeugt eine neue private, ungewertete Welt mit UUID und externer
   `tut_…`-Referenz.
5. Die `TutorialWorldFactory` provisioniert Economy, Ledger, Fleet, Planner,
   Operating und Regional Simulation aus dem gehashten Template
   `tutorial-minimal-2026.1`. Vorbereitet sind nur offenes Inventar und ein
   Personalpool; Fahrzeughalterwechsel, Trassenbestätigung und aktives
   Betriebsprogramm erfolgen erst durch die Kapitelhandlungen.

Tutorialprofile sind von Odoo-Weltlisten und Odoo-Projektionen ausgeschlossen.
Ein Versuch erzeugt keinen Weltstartantrag, Odoo-Datensatz oder Outbox-Eintrag.

## Tutoriallebenszyklus und Reaper

```text
provisioning → running → summary → closing → archived
```

- höchstens eine aktive Sitzung pro öffentlichem Weltkonto;
- Reload setzt dieselbe Sitzung fort;
- Neustart archiviert die alte Welt und erzeugt eine neue UUID;
- Idle-TTL: 30 Minuten; maximale Dauer: 60 Minuten;
- Summary-Schonfrist ohne Bestätigung: 5 Minuten;
- Game-API-Reaper: alle 30 Sekunden;
- ab `closing` keine neuen Spielkommandos;
- Archivierung schließt Economy, entzieht Zugang und persistiert finalen Hash,
  Templateversion, Abschluss-/Abbruchgrund und Telemetrie.

Der Reaper ist idempotent. Nach einem Prozessabbruch setzt der nächste Lauf
`provisioning`, eine ausstehende Kapitelaktion oder `closing` anhand
persistenter Schritte fort. Zur Diagnose dienen strukturierte Game-Logs und
Zustandshashes; individuelle Tutorialwelt-IDs werden nicht als Prometheus-
Label verwendet.

## Abnahme

Repository- und CI-Abnahme umfasst:

```bash
pnpm --filter @zugfolge/alpha test
pnpm --filter @zugfolge/game-api test
pnpm --filter @zugfolge/game-web test
cargo test --locked -p zugfolge-rules -p zugfolge-runtime-napi
pnpm guards
node .github/scripts/sync-milestones.mjs check
```

Der Linux-Job **Native Runtime ABI (Linux, echtes NAPI)** baut beide NAPI-
Addons und durchläuft alle fünf Kapitel mit PGlite über echte Economy-, Fleet-,
Planning-, Operating-, Disruption- und Ledgerpfade.

Die Produktabnahme bleibt getrennt offen: externe Testspieler müssen im echten
Browser gegen jeweils neu erzeugte Sitzungen einen Median um zwölf Minuten,
mindestens 90 Prozent unter 15 Minuten und die erste Entscheidung unter
90 Sekunden belegen. M9.1 bleibt bis dahin `in Arbeit`.

## Betrieb und Wiederherstellung

Öffentliche Welten und ihre Backups bleiben vollständig persistent. Die
automatische Archivierung kurzlebiger Tutorialwelten ist eine ausdrückliche,
ungewertete Ausnahme. Ein späterer Cleanup darf umfangreiche Laufzeitdaten
entfernen, aber nicht Sitzungsreferenz, Templateversion, Kapitelzeiten,
Abschlussgrund, finalen Hash und notwendige Auditmetadaten.

Weitere Wiederherstellungs-, Alert- und Odoo-Drills stehen in
[`docs/alpha-betrieb.md`](docs/alpha-betrieb.md). Eine lokale grüne Suite
ersetzt weder GitHub CI noch den realen Odoo-19- und externen Browserlauf.
