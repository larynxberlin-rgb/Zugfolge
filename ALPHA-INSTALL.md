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
- in Keycloak unter **Realm settings → Email** eingerichteter SMTP-Server.

## Konfiguration und Start

```bash
cp .env.example .env
chmod 600 .env
$EDITOR .env
pnpm alpha:up
```

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

Der Start baut Rust-NAPI und alle Node-/Web-Artefakte, startet nach
Abhängigkeiten und prüft die Health-Endpunkte. PostgreSQL/Keycloak → regionale
Single-Writer/Game API → Scheduler/Livemap → Bridge/Odoo-Projektion ist die
bindende Reihenfolge. PostgreSQL übernimmt die persistente Queue; ein Broker
wird erst nach Messbeweis eingeführt.

## Keycloak und Odoo

Der Realmimport `ops/alpha/keycloak/zugfolge-realm.json` enthält die Clients
`game-web`, `operations-center`, die Audience `game-api`, Rollen sowie
Required Actions. Das Servicekonto `provisioner` benötigt nur `manage-users`,
`view-users` und `query-users`.

In Odoo unter **Einstellungen → Technisch → Systemparameter** setzen:

- `zugfolge_admin.game_webhook_url` =
  `http://game-api:3000/integrations/odoo/webhooks`;
- `zugfolge_admin.actor_reference` = `odoo-alpha-admin`;
- Webhook-Key und Secret passend zu `ODOO_WEBHOOK_KEYS_JSON`;
- Projektions-Key passend zu `ODOO_PROJECTION_SECRET`.

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
