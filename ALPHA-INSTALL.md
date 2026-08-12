# Zugfolge — geschlossene Alpha installieren (Phase 1 und 2)

Diese Anleitung bringt den selbst gehosteten Alpha-Stack reproduzierbar hoch.
Odoo steuert Einladungen, Keycloak verwaltet Identitäten, und ausschließlich das
Game hält weltgebundene Konten und Zugänge. Odoo und Keycloak liegen nie im
heißen Simulationspfad.

## Voraussetzungen

- Linux-Host mit Docker Engine und Compose v2, mindestens 16 GiB RAM und 40 GiB frei;
- Checkout dieses Repositories;
- das separat rechtegeprüfte Alpha-Evidenzpaket unter `var/alpha-evidence/` mit
  `alpha-world-deployment.json`, Fleet-Katalog, signiertem InfraRelease und
  PMTiles/Static-Artefakten. Diese ODbL-/Source-Available-Daten gehören bewusst
  nicht in Git. Für Phase 2 muss der Weltbestand mit dem aktuellen
  `tools/region-import/build-alpha-world.mjs` neu erzeugt, qualifiziert und
  signiert sein; ein älterer Phase-1-Bestand enthält noch kein Startpaket;
- erreichbarer SMTP-Server, der vor dem Einladungsversand im Realm `zugfolge`
  unter **Realm settings → Email** eingetragen wird.

## Konfiguration und Start

```bash
cp .env.example .env
chmod 600 .env
$EDITOR .env
pnpm alpha:up
```

Der Weltgenerator schreibt neben dem Deployment die Datei
`alpha-world-deployment.json.phase2.json`. Aus ihr werden die beiden kompakten
JSON-Werte `.authority` und `.startPackage` unverändert nach
`ALPHA_JOURNEY_AUTHORITY_JSON` beziehungsweise
`ALPHA_START_PACKAGE_SPEC_JSON` übernommen. `ALPHA_PUBLIC_WORLD_ID` muss mit
dem `worldId` des Deployments und des vorbereiteten Startpaket-Slots
übereinstimmen. Die Ressourcenkennungen werden beim Grant noch einmal gegen
den gepinnten Fleet-Checkpoint geprüft; die Seitendatei kann deshalb keinen
Fahrzeug-, Personal- oder Trassenzustand erfinden.

`ALPHA_TUTORIAL_WORLD_ID` bezeichnet eine getrennte aktive Welt mit
`profileKind=tutorial`, `worldKind=private`, `rankingStatus=unranked` und einem
Beschleunigungsfaktor größer eins. Diese Welt muss vor dem Einladungsversand
mit ihren gepinnten Releases gestartet sein. Die Game API verweigert
Beschleunigung in öffentlichen Welten. Beim ersten Einstieg nimmt der
Tutorial-Reset das nach Weltstart eingeladene Konto im selben Commit in die
persistente Economy-Präqualifikation auf; ein bloßer Identity-Datensatz reicht
für Kapitel eins ausdrücklich nicht.

Alle `replace-*`-Werte müssen durch getrennte, zufällige Geheimnisse ersetzt
werden. Öffentliche URLs müssen die tatsächlichen HTTPS-Adressen tragen. Der
Befehl baut Rust-NAPI und alle Node-/Web-Artefakte, startet nach Abhängigkeiten
und prüft sämtliche Health-Endpunkte. Die autoritative Startreihenfolge ist
PostgreSQL/Keycloak → regionaler Single-Writer in der Game API → Game API und
Scheduler → Livemap → Bridge → Odoo-Projektion. PostgreSQL übernimmt die
persistente Queue; es wird ohne Messbeweis kein Broker eingeführt.

## Keycloak und Odoo verbinden

Der Realmimport `ops/alpha/keycloak/zugfolge-realm.json` enthält die Clients
`game-web`, `operations-center`, die Audience `game-api`, die Rollen `player`
und `world_admin` sowie `VERIFY_EMAIL` und `UPDATE_PASSWORD`. Das vertrauliche
Servicekonto `provisioner` benötigt in Keycloak ausschließlich
`manage-users`, `view-users` und `query-users`. Seine geheime Zeichenfolge steht
nur in `.env`.

In Odoo unter **Einstellungen → Technisch → Systemparameter** setzen:

- `zugfolge_admin.game_webhook_url` = `http://game-api:3000/integrations/odoo/webhooks`;
- `zugfolge_admin.actor_reference` = `odoo-alpha-admin`;
- `zugfolge_admin.webhook_key_id` und `zugfolge_admin.webhook_secret` passend zu
  `ODOO_WEBHOOK_KEYS_JSON`;
- `zugfolge_admin.projection_keys_json` passend zu `ODOO_PROJECTION_SECRET`.

## Alpha-Einladungen

1. **Zugfolge → Alpha-Einladungen → Neu** öffnen.
2. E-Mail, Anzeigename, Zielwelt, Rolle und optionales Startpaket erfassen.
3. **Einladung senden** wählen. Odoo signiert den Antrag; die Commerce-Bridge
   persistiert und reprüft Akteur, Capability, Welt und Fachform.
4. Der autoritative Handler legt idempotent die Keycloak-Identität und danach
   `worldAccesses`/`accounts` samt Rolle für Ziel- und Tutorial-Welt an.
   Keycloak versendet die Required-Actions-Mail. Die Ergebnisprojektion schreibt
   Subject und Spielkontoreferenzen nach Odoo zurück; sie ist nur eine
   Auditprojektion.
5. **Erneut senden** löst die Required Actions erneut aus. **Entziehen**
   deaktiviert die Keycloak-Identität und entzieht den weltgebundenen Zugang.

Bis zu 50 Einladungen werden einzeln über diesen Kontrollpfad verteilt; es gibt
kein produktives Provisionierungsskript und keinen direkten Odoo-DB-Zugriff.
`world_admin` ist eine weltgebundene Spielrolle und keine Keycloak-Fachwahrheit.

## Spielerreise prüfen

Nach Abschluss der Keycloak-Aktionen öffnet die Einladung die Game-Web-App. Sie
verwendet Authorization Code mit PKCE und hält kein Client-Geheimnis im
Browser. Die Web-App führt zunächst durch fünf Tutorial-Kapitel. **Tutorial
zurücksetzen** erzeugt über den regionalen Single Writer eine neue
Tutorial-Sitzung; Evidenz der alten Sitzung zählt danach nicht mehr.

In der öffentlichen Welt fordert **Startpaket übernehmen** genau einmal den
vorbereiteten Slot an. Game API und Economy-Runtime vollziehen dabei den
Operatorwechsel, den befristeten Vertrag, Leasingfahrzeug, Personal,
Trassenfenster und Betriebsprogramm atomar. Erst nach dem Commit werden
Livemap-/Odoo-Projektionen benachrichtigt. Kapazitäts-Heatmap, Glossar und
Assistentenwarnungen lesen nur autoritative Projektionen. Odoo ist weder Quelle
dieses Zustands noch Teil des heißen Pfads.

Für den Phase-2-Abnahmelauf sind mindestens zu protokollieren:

1. Einladung eines externen Testkontos über Odoo und erfolgreiche
   Keycloak-Anmeldung;
2. Abschluss aller fünf Tutorial-Kapitel, Reset und sichtbarer Neubeginn bei
   Kapitel eins;
3. einmalige Startpaketübernahme in der öffentlichen Welt und idempotente
   Wiederholung ohne zweites Fahrzeug oder zweiten Vertrag;
4. aktives Betriebsprogramm sowie passende Fleet-, Economy- und
   Livemap-Projektionen;
5. verständliche Heatmapmuster und Warntexte auch ohne Farbwahrnehmung.

Der Generator stellt für diesen Phase-2-Nachweis einen einzelnen konkreten
Startpaket-Slot bereit. Die spätere reale Alpha mit 20–50 Konten und der
gemischte Mehrperioden-Soak bleiben M9.9 und werden dadurch nicht vorweggenommen.

## Betrieb

```bash
pnpm alpha:down
docker compose -f compose.alpha.yml logs -f game-api odoo keycloak
docker compose -f compose.alpha.yml restart game-api
```

Prometheus läuft auf Port 9090, Grafana auf 3001. Backup/Restore erfolgt mit den
vorhandenen Skripten unter `ops/alpha/`; RPO/RTO und Wiederanlauf stehen in
`docs/alpha-betrieb.md`. Phase 2 führt noch keinen Odoo-Restore- oder
Vier-Augen-Betriebsdrill durch — diese Nachweise gehören ehrlich zu Phase 3.
