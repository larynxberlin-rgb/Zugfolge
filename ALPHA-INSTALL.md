# Zugfolge — geschlossene Alpha installieren (Phase 1 und 2)

Diese Anleitung bringt den selbst gehosteten Alpha-Stack reproduzierbar hoch.
Odoo steuert Einladungen, Keycloak verwaltet Identitäten, und ausschließlich das
Game hält weltgebundene Konten und Zugänge. Odoo und Keycloak liegen nie im
heißen Simulationspfad.

## Voraussetzungen

- Linux-Host mit Docker Engine und Compose v2, mindestens 16 GiB RAM und 40 GiB frei;
- Checkout dieses Repositories;
- das separat rechtegeprüfte Alpha-Evidenzpaket unter `var/alpha-evidence/` mit
  **zwei getrennten signierten Welt-Deployments** — öffentlich und Tutorial —,
  Fleet-Katalog, signiertem InfraRelease und PMTiles/Static-Artefakten. Diese
  ODbL-/Source-Available-Daten gehören bewusst nicht in Git. Für Phase 2 müssen
  beide Weltbestände mit dem aktuellen `tools/region-import/build-alpha-world.mjs`
  neu erzeugt, qualifiziert und jeweils extern Ed25519-signiert sein. Ein
  älterer Bestand mit einem öffentlichen Startpaket ist nach E28 nicht
  startfähig;
- erreichbarer SMTP-Server, der vor dem Einladungsversand im Realm `zugfolge`
  unter **Realm settings → Email** eingetragen wird.

## Konfiguration und Start

```bash
cp .env.example .env
chmod 600 .env
$EDITOR .env
pnpm alpha:up
```

Der Weltgenerator erhält einen öffentlichen Zielpfad `PUBLIC_OUTPUT`. Er
schreibt den öffentlichen Kandidaten dorthin, den getrennten
Tutorial-Kandidaten nach `${PUBLIC_OUTPUT}.tutorial.json` und dessen Sidecar
nach `${PUBLIC_OUTPUT}.tutorial.config.json`. Aus der Sidecar werden die beiden
kompakten JSON-Werte `.authority` und `.startPackage` unverändert nach
`ALPHA_JOURNEY_AUTHORITY_JSON` beziehungsweise
`ALPHA_START_PACKAGE_SPEC_JSON` übernommen. Der `worldId` jedes vorbereiteten
Startpaket-Slots muss mit `ALPHA_TUTORIAL_WORLD_ID` und dem signierten
Tutorial-Deployment übereinstimmen. Die Ressourcenkennungen werden beim Grant
noch einmal gegen dessen gepinnten Fleet-Checkpoint geprüft; die Seitendatei
kann deshalb keinen Fahrzeug-, Personal- oder Trassenzustand erfinden.

Vor dem Generieren werden in zwei Odoo-`world_deploy`-Entwürfen Public- und
Tutorial-Welt einschließlich Startkapital festgelegt. Das dort angezeigte
`signing_configuration`-JSON wird als `PUBLIC-ODOO-CONFIG.json` beziehungsweise
`TUTORIAL-ODOO-CONFIG.json` gespeichert und dem Generator als siebtes und
achtes optionales Argument übergeben. Der Generator übernimmt diese Werte
unverändert in `worldDefinition` und `startingCapitalPolicy`; ohne Dateien
gelten die dokumentierten Pilotwerte einschließlich Public-Standard null Cent.

Beide Kandidaten werden **separat** signiert; der private Schlüssel bleibt
außerhalb des Repositorys und Odoos:

```bash
node tools/alpha-ops/sign-alpha-deployment.mjs \
  "$PUBLIC_OUTPUT" "$ALPHA_PRIVATE_KEY" "$ALPHA_KEY_ID" \
  "${PUBLIC_OUTPUT}.signed.json"
node tools/alpha-ops/sign-alpha-deployment.mjs \
  "${PUBLIC_OUTPUT}.tutorial.json" "$ALPHA_PRIVATE_KEY" "$ALPHA_KEY_ID" \
  "${PUBLIC_OUTPUT}.tutorial.signed.json"
```

`ALPHA_WORLD_RELEASE_PATHS_JSON` enthält anschließend ein JSON-Array der
absoluten Pfade beider signierter Dateien, zum Beispiel
`["/evidence/alpha-world-deployment.json.signed.json","/evidence/alpha-world-deployment.json.tutorial.signed.json"]`.
Der ältere Einzelwert `ALPHA_WORLD_RELEASE_PATH` bleibt nur als kompatibler
Fallback für genau ein Deployment; er erfüllt den E28-Doppelweltnachweis nicht.

Das getrennte öffentliche Deployment muss `ALPHA_PUBLIC_WORLD_ID`,
`profileKind=public`, Beschleunigungsfaktor eins und eine explizite
`startingCapitalPolicy` tragen. Der Standard ist
`{"mode":"finite","amountCents":"0"}`. Es enthält keinen Startpaket-Slot und
keine für einen neuen Spieler vorbereiteten Verträge oder Betriebsmittel. Die
Game-API startet keinen Bestand, wenn Weltkennung, Profil, Deployment-Hash,
Signatur oder Policy voneinander abweichen.

`ALPHA_TUTORIAL_WORLD_ID` bezeichnet eine getrennte aktive Welt mit
`profileKind=tutorial`, `worldKind=private`, `rankingStatus=unranked` und einem
Beschleunigungsfaktor größer eins. Diese Welt muss vor dem Einladungsversand
mit ihren gepinnten Releases gestartet sein. Die Game API verweigert
Beschleunigung in öffentlichen Welten. Beim ersten Einstieg nimmt der
Tutorial-Reset das nach Weltstart eingeladene Konto im selben Commit in die
persistente Economy-Präqualifikation auf; ein bloßer Identity-Datensatz reicht
für Kapitel eins ausdrücklich nicht.

## Welten in Odoo vorbereiten und signieren

Öffentliche und Tutorial-Welt werden als zwei getrennte `world_deploy`-Anträge
angelegt. In **Zugfolge → Administrationsanträge → Neu** zunächst Weltkennung,
Name, Art, Rankingstatus, Fahrplanperiodenlänge, Weltepoche und
Startkapitalmodus erfassen. `finite` beginnt im deutschen Eingabefeld bei
`0,00`; Odoo serialisiert den Wert als exakten Cent-Dezimalstring. `unlimited`
besitzt keinen Betrag und wird nur als `∞` dargestellt.

Das Formular ist Phase eins, nicht die Signatur: Aus der geprüften Definition
entsteht ein kanonischer Blueprint-Kandidat samt Hash. Dieser exakte Kandidat
wird außerhalb von Odoo mit dem getrennt verwahrten Ed25519-Schlüssel signiert.
Erst danach werden vollständiges signiertes Deployment und Deployment-Hash an
denselben Antrag angehängt. Nach **Einreichen** sind Weltdefinition, Policy und
Deployment unveränderlich; eine andere Odoo-Person gibt den Hochrisikoantrag
frei. **Signiert an Game senden** verwendet anschließend den HMAC-geschützten
Odoo-Webhook. Dieser HMAC authentifiziert nur das Kommando und ersetzt niemals
die Ed25519-Signatur des Deployments.

Das Game prüft Signatur, Hashes, die ebenfalls signierte Weltdefinition,
Weltbindung, Release-Pins und Policy erneut und
ist allein für Persistenz und Start zuständig. Odoo erhält Profil, Policy,
Blueprint- und Deployment-Hash anschließend nur als read-only Projektion.
Fehlt die vom Game signierte `world_deploy`-Fähigkeitsprojektion, bleibt der
Antrag vorbereitet und darf nicht ausgeliefert werden. Ein realer Odoo-19-
Vier-Augen-Lauf ist weiterhin ein externer Abnahmenachweis und wird durch die
Repositorytests nicht ersetzt.

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
2. E-Mail, Anzeigename, Zielwelt und Rolle erfassen. Ein Startpaket darf nur
   für die getrennte Tutorial-Welt ausgewählt werden; bei einer öffentlichen
   Zielwelt weist Odoo die Einladung ab.
3. **Einladung senden** wählen. Odoo signiert den Antrag; die Commerce-Bridge
   persistiert und reprüft Akteur, Capability, Welt und Fachform.
4. Der autoritative Handler legt idempotent die Keycloak-Identität und danach
   `worldAccesses`/`accounts` samt Rolle für Ziel- und Tutorial-Welt an.
   Keycloak versendet die Required-Actions-Mail. Die Ergebnisprojektion schreibt
   Subject und Spielkontoreferenzen nach Odoo zurück; sie ist nur eine
   Auditprojektion.
5. **Erneut senden** löst die Required Actions erneut aus. **Vier-Augen-Entzug
   beantragen** erzeugt dagegen nur einen Hochrisikoantrag. Erst eine andere
   Odoo-Person mit Freigaberolle darf ihn genehmigen und signiert ausliefern;
   das Game reautorisiert Welt und Capability, deaktiviert die
   Keycloak-Identität und entzieht den weltgebundenen Zugang. Der Zustand
   **Entzogen** kommt ausschließlich aus der Game-Ergebnisprojektion zurück.

Bis zu 50 Einladungen werden einzeln über diesen Kontrollpfad verteilt; es gibt
kein produktives Provisionierungsskript und keinen direkten Odoo-DB-Zugriff.
`world_admin` ist eine weltgebundene Spielrolle und keine Keycloak-Fachwahrheit.

## Spielerreise prüfen

Nach Abschluss der Keycloak-Aktionen öffnet die Einladung die Game-Web-App. Sie
verwendet Authorization Code mit PKCE und hält kein Client-Geheimnis im
Browser. Die Web-App führt zunächst durch fünf Tutorial-Kapitel. **Tutorial
zurücksetzen** erzeugt über den regionalen Single Writer eine neue
Tutorial-Sitzung; Evidenz der alten Sitzung zählt danach nicht mehr.

Nur in der Tutorial-Welt fordert **Tutorial-Startpaket übernehmen** genau einmal
den vorbereiteten Slot an. Game API und Economy-Runtime vollziehen dort den
Operatorwechsel, den befristeten Vertrag, Leasingfahrzeug, Personal,
Trassenfenster und Betriebsprogramm atomar. Erst nach dem Commit werden
Livemap-/Odoo-Projektionen benachrichtigt.

In der öffentlichen Welt gründet der Spieler dagegen sein EVU regulär. Im
selben Commit werden dessen Ledgerkonten und — bei `finite` einschließlich null
Cent — die ausgeglichene Eröffnungsbuchung aus dem signierten Blueprint
angelegt. Die Oberfläche zeigt die Policy und den veröffentlichten
Vergabekalender. Ein erstes Gebot darf das signierte Eigenbetriebs-Konzept nur
unter Zuschlagsbedingung kalkulieren; vor Zuschlag entstehen weder Asset,
Nutzungsrecht noch Buchung. Am Mobilisierungsstichtag werden Formation, Personal
und Trasse erneut belegt. Die Oberfläche verspricht beim Beitritt weder Vertrag
noch Fahrzeug, Trasse, Personal oder
Betriebsprogramm. Kapazitäts-Heatmap, Glossar und Assistentenwarnungen lesen nur
autoritative Projektionen. Odoo ist weder Quelle dieses Zustands noch Teil des
heißen Pfads.

Für den Phase-2-Abnahmelauf sind mindestens zu protokollieren:

1. Einladung eines externen Testkontos über Odoo und erfolgreiche
   Keycloak-Anmeldung;
2. Abschluss aller fünf Tutorial-Kapitel, Reset und sichtbarer Neubeginn bei
   Kapitel eins;
3. einmalige Startpaketübernahme **in der Tutorial-Welt** und idempotente
   Wiederholung ohne zweites Fahrzeug oder zweiten Vertrag; öffentliche
   Startpaketabfragen müssen vor jeder Writer-Mutation abgewiesen werden;
4. öffentliche EVU-Gründung mit exakt einmal angelegten Ledgerkonten und der
   gehashten Eröffnungs-Policy sowie ein nachvollziehbarer erster Weg über
   Ausschreibung, zuschlagsgebundene Betriebsbereitstellung und erneute
   M5-Mobilisierungsprüfung;
5. aktives Tutorial-Betriebsprogramm sowie passende Fleet-, Economy- und
   Livemap-Projektionen;
6. verständliche Heatmapmuster und Warntexte auch ohne Farbwahrnehmung.

Der Generator stellt für diesen Phase-2-Nachweis einen einzelnen konkreten
Startpaket-Slot ausschließlich im Tutorial-Deployment bereit. Das öffentliche
Deployment weist stattdessen seine Eröffnungs-Policy und den normalen
Nullstartpfad nach. Die spätere reale Alpha mit 20–50 Konten und der gemischte
Mehrperioden-Soak bleiben M9.9 und werden dadurch nicht vorweggenommen.

## Betrieb

```bash
pnpm alpha:down
docker compose -f compose.alpha.yml logs -f game-api odoo keycloak
docker compose -f compose.alpha.yml restart game-api
```

Prometheus läuft auf Port 9090, Grafana auf 3001. Backup/Restore erfolgt mit den
vorhandenen Skripten unter `ops/alpha/`; RPO/RTO und Wiederanlauf stehen in
`docs/alpha-betrieb.md`.

## Phase-3-Betriebsabnahme

Vor dem Lauf müssen eine weiterhin aktive externe Spielersitzung für den
Feedbackfall sowie eine getrennte, bereits bereitgestellte Einladung für den
Entzugsfall vorliegen. In `.env` werden deren Referenz bzw. Token und zwei
verschiedene Odoo-Logins gesetzt (`PHASE3_*` aus `.env.example`). Der Lauf ist
ein angekündigter Wartungsdrill: Er stoppt Odoo und Game API kontrolliert, bis
die versionierten Alert-Regeln wirklich feuern, und startet beide wieder.

```bash
pnpm alpha:phase3
```

Der Befehl führt zusammenhängend aus:

1. Odoo-Vier-Augen-Entzug → signierter Webhook → Game-Queue → Keycloak-
   Deaktivierung → Weltzugang → Game-Audit und Ergebnisprojektion;
2. pseudonymisiertes Spielerfeedback bis zum laufenden Odoo;
3. Live-Backup und isolierten `zugfolge_odoo_restore_*`-Restore mit identischem
   Odoo-Fachzustands- und Filestore-Baumhash;
4. Modul-Upgrade, echte Odoo-19-Add-on-Tests und Anhangsstichprobe;
5. `degraded`-/`down`-Alertfälle und die live befragten Grafana-/Prometheus-
   Metriken für Welt, Queue, Bridge und Markt.

Nur ein Protokoll mit `"status": "passed"` unter
`var/alpha-ops/phase3/protocols/` ist ein Betriebsnachweis. Vorher bleiben
M9.4, M9.5 und M9.7 in der Statusmatrix offen beziehungsweise blockiert.
