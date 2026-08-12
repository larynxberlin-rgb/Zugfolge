# Zugfolge — geschlossene Alpha installieren (Phase 1)

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
  nicht in Git.
- erreichbarer SMTP-Server, der vor dem Einladungsversand im Realm `zugfolge`
  unter **Realm settings → Email** eingetragen wird.

## Konfiguration und Start

```bash
cp .env.example .env
chmod 600 .env
$EDITOR .env
pnpm alpha:up
```

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
   `worldAccesses`/`accounts` samt Rolle an. Keycloak versendet die Required-
   Actions-Mail. Die Ergebnisprojektion schreibt Subject und Spielkontoreferenz
   nach Odoo zurück; sie ist nur eine Auditprojektion.
5. **Erneut senden** löst die Required Actions erneut aus. **Entziehen**
   deaktiviert die Keycloak-Identität und entzieht den weltgebundenen Zugang.

Bis zu 50 Einladungen werden einzeln über diesen Kontrollpfad verteilt; es gibt
kein produktives Provisionierungsskript und keinen direkten Odoo-DB-Zugriff.
`world_admin` ist eine weltgebundene Spielrolle und keine Keycloak-Fachwahrheit.

## Betrieb

```bash
pnpm alpha:down
docker compose -f compose.alpha.yml logs -f game-api odoo keycloak
docker compose -f compose.alpha.yml restart game-api
```

Prometheus läuft auf Port 9090, Grafana auf 3001. Backup/Restore erfolgt mit den
vorhandenen Skripten unter `ops/alpha/`; RPO/RTO und Wiederanlauf stehen in
`docs/alpha-betrieb.md`. Phase 1 führt noch keinen Odoo-Restore- oder
Vier-Augen-Betriebsdrill durch — diese Nachweise gehören ehrlich zu Phase 3.
