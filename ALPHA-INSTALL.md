# Zugfolge — geschlossene Alpha installieren

Diese Anleitung startet den selbst gehosteten Alpha-Stack reproduzierbar.
Odoo steuert Einladungen und Freigaben, Keycloak verwaltet Identitäten, und
ausschließlich das Game hält weltgebundene Konten, Zugänge und kurzlebige
Tutorialinstanzen. Odoo und Keycloak liegen nie im heißen Simulationspfad.

## Voraussetzungen

- Linux-Host mit Docker Engine und Compose v2, mindestens 16 GiB RAM und
  40 GiB frei;
- Checkout dieses Repositories;
- separat rechtegeprüftes Alpha-Evidenzpaket unter `var/alpha-evidence/` mit
  signiertem `alpha-world-deployment.json`, Fleet-Katalog, InfraRelease und
  PMTiles/Static-Artefakten;
- parallel installierte Kartenpakete `.1` und `.2`, kanonisches Build-Evidence,
  Restore-Proof, tatsächlich wiederhergestellter Buildcache, öffentlicher
  Delivery-Keyring und externe `.1`-Bestandsattestation gemäß
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
Registry-Digest. `alpha:up` verwendet ausschließlich `--no-build`.
Game und Odoo werden dabei unter den festen Image-Namen `zugfolge-game-api`
beziehungsweise `zugfolge-odoo:alpha` gebaut. Insbesondere verwenden
`odoo-upgrade`, `odoo` und der optionale Betriebscontainer dasselbe explizite
Odoo-Image; der anschließende `--no-build`-Start leitet keinen Image-Namen aus
einem wechselnden Compose-Projekt ab.

Auf dem Server ist die versionierte Repo-Vorlage vor Build oder Start als
kanonische Betriebsdatei zu installieren. `compose.yml` wird nicht separat
gepflegt oder von Hand geändert:

```bash
install -m 0644 /opt/zugfolge/compose.alpha.yml /opt/zugfolge/compose.yml
cmp --silent /opt/zugfolge/compose.alpha.yml /opt/zugfolge/compose.yml
```

Build, Start, Stop und die Betriebsdrills rufen Compose ausschließlich über
`tools/alpha-ops/compose-with-map-release-env.sh` auf. Der Wrapper lädt zuerst
`/opt/zugfolge/.env` und danach den aktiven Kartenzeiger; letzterer bestimmt
damit als einzige Quelle Release-ID, Release-Mount und beide öffentlichen
Karten-URLs. Ein direkter `docker compose`-Aufruf ist kein freigegebener Start-
oder Rückweg und scheitert ohne die bewusst aus `.env` entfernten Pointerwerte.

Die Vorlage bindet genau ein signiertes Public-Deployment und den unveränderlichen
Kartenrelease `infra-deutschland-2026.2`. Dessen `read-model.sqlite` muss das
SQLite-`user_version` 3 besitzen; die Game API verweigert jedes ältere oder fremde
ReadModel beim Start. Tutorialwelten werden nicht statisch gebootstrapped.

Der Produktionshost verwendet eine einzige Kartenwurzel. Auf dem aktuellen
Server ist das `/opt/zugfolge/maps`; darunter liegen `releases/` mit `.1` und
`.2`, der atomare Pointer unter `active/` und die externe Rollback-Attestation
unter `attestations/`. Drei zusätzliche, nur lesend in den One-shot-Container
gemountete Pfade werden in `.env` festgelegt:

```dotenv
MAP_RELEASE_DEPLOYMENT_HOST_ROOT=/opt/zugfolge/maps
MAP_RELEASE_PREFLIGHT_HOST_DIR=/opt/zugfolge/map-release-preflight
MAP_RELEASE_RESTORE_HOST_DIR=/opt/zugfolge/map-release-restore/infra-deutschland-2026.2
```

`/opt/zugfolge/maps/active/map-release.env` ist eine kanonische LF-Datei mit
genau den vier vom Evidence-Vertrag geprüften Werten. Für den aktivierten
Kandidaten lautet sie:

```dotenv
MAP_RELEASE_ID=infra-deutschland-2026.2
MAP_RELEASE_HOST_DIR=releases/infra-deutschland-2026.2
MAP_BASEMAP_STYLE_URL=/artifacts/maps/infra-deutschland-2026.2/style.json
MAP_GERMANY_PMTILES_URL=/artifacts/maps/infra-deutschland-2026.2/infra-deutschland-2026.2.pmtiles
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
Serverkopie bricht vor Compose ab.

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
`active-candidate` für `.2`: beide installierten Pakete, Evidence, Cache-Restore,
Trust-Keyring, externe `.1`-Attestation und alle vier bereits auf `.2` stehenden
Pointerwerte müssen zusammenpassen. Erst danach wendet `game-migrate` den
vollständigen Drizzle-Migrationsstand an; `game-bootstrap` prüft
genau ein signiertes öffentliches Weltdeployment und legt dessen Welt- und
Planning-Authority-Bindung an. Ein Widerspruch zur bestehenden Datenbank
bricht den Start ab; statische Tutorialdeployments sind verboten.

Die persistente Odoo-Datenbank wird vor dem normalen Odoo-Webprozess durch den
One-shot `odoo-upgrade` aktualisiert. Er führt für bestehende Installationen
explizit `--update=zugfolge_admin --stop-after-init` aus und installiert das
Modul bei einer leeren Datenbank zugleich initial. Erst ein erfolgreicher
Abschluss startet den Dienst `odoo`. Für `19.0.2.0.3` hebt die Migration einen
vorhandenen unveränderten Deployment-Spiegel auf Generation 1 und schreibt
dessen alten Deployment- und Blueprint-Hash als ersten unveränderlichen
Auditbeleg; sie löscht keinen Spiegel und ist wiederholbar. Vor diesem Schritt
ist das Odoo-DB-/Filestore-Backup Pflicht. Der neu signierte Weltvertrag muss
für dieselbe `world_id` anschließend `deploymentRevision: 2` enthalten. Normale
Monitoringprojektionen können diese Revision nicht erhöhen.

Die vorhandene `.1`-Attestation im Schema
`zugfolge-map-rollback-attestation/v1` bindet nur Kartenbytes. Sie ist daher
ausdrücklich **kein** ausführbares Laufzeit-Rollback: Der normale `.2`-Gate darf
mit `rollbackEligible: false` und dem Grund `runtime-tuple-unbound-v1` starten,
der explizite Modus `pre-activation` verweigert dagegen den Start. Das alte
DB-Volume, die alten Images und die `.1`-Artefakte bleiben forensisch erhalten;
die Rollback-Unit bleibt deaktiviert.

Ein manueller `.1`-Vorlauf ist erst zulässig, wenn eine v2-Attestation zusätzlich
den exakten Source-Commit, OCI-Image-Digest, das Ed25519-signierte
Weltdeployment, ReadModel-Schema und Zeitvertrag sowie Zugprojektionsschema,
Welt-ID und Deployment-Hash koppelt. Der Container muss dieselben drei
Runtimewerte über die `MAP_RELEASE_PREFLIGHT_RUNTIME_*`-Variablen belegen. Der
Image-Digest muss dabei zugleich die unveränderliche
`image: …@sha256:…`-Referenz des gesonderten Legacy-Compose-Vertrags sein; ein
lokaler Tag oder ein bloßer Envwert ist keine Freigabe. Erst dann
kann der Vorlauf im selben Compose-Projekt und mit derselben Compose-Datei
ausgeführt werden:

```bash
bash /opt/zugfolge/tools/alpha-ops/compose-with-map-release-env.sh \
  -f /opt/zugfolge/compose.yml run --rm --no-deps \
  map-release-preflight \
  node tools/alpha-ops/map-release-deployment-preflight.mjs pre-activation
```

Dieses Kommando ist nur erfolgreich, wenn der Pointer exakt die vier `.1`-Werte
enthält, `.2` trotzdem vollständig sowie signiert installiert ist und das
aktuelle Source-/Image-/Welt-/Map-Tuple bytegenau der signierten v2-Attestation
entspricht.
Danach wird der vorbereitete Pointer atomar auf die vier `.2`-Werte gesetzt.
Der reguläre Start wiederholt den Gate ohne Fallback ausschließlich als
`active-candidate`:

```bash
bash /opt/zugfolge/tools/alpha-ops/compose-with-map-release-env.sh \
  -f /opt/zugfolge/compose.yml up --no-build --wait
```

Schlägt der `.2`-Gate fehl, starten weder Migration noch Bootstrap oder Game
API. `.1` wird im normalen Startpfad niemals automatisch aktiviert.

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

Auch `ExecStart` und `ExecStop`
verwenden ausschließlich den Wrapper. Zusätzlich führen Game API und Livemap
den vollständigen read-only `active-candidate`-Preflight bei jedem eigenen
Prozessstart erneut aus. Damit umgehen weder `docker compose restart game-api`,
ein Containerneustart noch ein Host-Reboot Evidence, Pointer, Trust-Keyring
oder Cache-Restore; bei jeder Abweichung bleibt der jeweilige Prozess aus.
Der Stopppfad verwendet den eng begrenzten Wrappermodus `--fixed-stop`. Er darf
ausschließlich `down` gegen `/opt/zugfolge/compose.yml` und das feste Projekt
`zugfolge` ausführen. Deshalb bleibt das Abschalten auch bei fehlendem oder
beschädigtem Kartenzeiger möglich; der normale Start- und Rollbackpfad bleibt
weiterhin vollständig pointer- und evidence-geprüft und fail-closed.

Ein durch eine v2-Attestation freigegebener `.1`-Rückweg ist bewusst kein
automatischer Fallback. Dafür wird zusätzlich
`ops/alpha/zugfolge-alpha-rollback.service` installiert. Die
beiden Units schließen einander aus. Ein autorisierter Rückweg stoppt zuerst
den normalen Dienst, tauscht dann den Pointer atomar auf die vier geprüften
`.1`-Werte und aktiviert erst anschließend den persistenten Rollbackdienst:

```bash
systemctl disable --now zugfolge-alpha.service
# maps/active/map-release.env jetzt atomar auf die attestierten .1-Werte setzen
systemctl enable --now zugfolge-alpha-rollback.service
```

Mit der real vorhandenen v1-Bestandsattestation darf dieser Ablauf nicht
ausgeführt werden; die Unit scheitert geschlossen und bleibt deaktiviert. Erst
nach Aufbau und separater Abnahme eines vollständigen Legacy-Images,
Legacy-Weltdeployments und passender `.1`-SQLite-Artefakte darf eine v2-
Attestation erstellt und die Unit autorisiert werden.

Die Rollback-Unit ruft den Wrapper ausschließlich mit
`--attested-rollback` auf. Dieser Modus setzt One-shot, Game API und Livemap
explizit auf `pre-activation`, übernimmt die erwartete `.1`-ID ausschließlich
aus dem kanonischen Pointer und erzwingt `up --force-recreate`. Der Modus bleibt
durch die aktivierte Unit auch nach einem Host-Reboot erhalten; ein bloßes
`restart` bestehender Container ist kein Rückweg. Ein fremder Shellwert kann
den Modus nicht ändern. Stimmen Pointer, Evidence und expliziter Modus nicht
überein, starten die Prozesse nicht.

Zur Rückkehr auf `.2` wird symmetrisch zuerst die Rollback-Unit gestoppt, dann
der Pointer atomar auf `.2` gesetzt und zuletzt der normale Dienst aktiviert:

```bash
systemctl disable --now zugfolge-alpha-rollback.service
# maps/active/map-release.env jetzt atomar auf die geprüften .2-Werte setzen
systemctl enable --now zugfolge-alpha.service
```

Der Start verwendet die vorgebauten Rust-NAPI- und Node-/Web-Artefakte, startet
nach Abhängigkeiten und prüft die Health-Endpunkte. PostgreSQL/Keycloak → regionale
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
Required Actions. Das Servicekonto `provisioner` benötigt nur `manage-users`,
`view-users` und `query-users`.

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
