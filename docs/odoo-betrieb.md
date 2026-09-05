# Odoo-Betrieb und Zugfolge-Administrationsmodul

Dieser Ordner enthält **keine Odoo-Instanz, kein Compose-Stack und keine
kopierten OCA-Quellen**. Odoo wird als eigener, rootless betreibbarer Dienst
mit eigener PostgreSQL-Datenbank, eigenen Zugangsdaten, eigenen Backups und
einem eigenen Betriebsaccount installiert. Das Repository enthält ausschließlich
das Add-on [`../odoo/addons/zugfolge_admin`](../odoo/addons/zugfolge_admin) und
den Game-seitigen Integrationsvertrag in `packages/commerce`.

Die Trennung ist verbindlich durch [ADR-0023](adr/0023-odoo-als-administrativer-kontrollpunkt.md): kein gemeinsames Datenbankkonto, keine Netzwerkfreigabe auf Game-Tabellen, kein Odoo-Client im Simulations-, Planner-, Login- oder Livemap-Pfad.

## Freigegebene externe Versionen

| Bestandteil | Exakter Pin | Lizenz | Verwendung |
|---|---|---|---|
| Odoo Community | Git `19.0` Commit `f8c29412e71af098b2949f485a8011b01b64b368` | LGPL-3.0 | Server und native Apps `base`, `contacts`, `crm`, `account`, `payment`, `mail` |
| Offizielles Odoo-Image | `odoo@sha256:e415f9924395e7521245813135112f264b9222bcde3b1d3c2ee9ff073081540a` | LGPL-3.0 (Odoo-Code) | optionaler, rootless Containerbetrieb |
| OCA `queue` | Commit `d2c1759102f1e0bc8f6244629b5b38c7b7882f36`, Modul `queue_job` 19.0.2.0.3 | LGPL-3.0 | persistente Odoo-seitige Zustellung und Wiederholung |
| Eigenes Add-on | `odoo/addons/zugfolge_admin`, Version `19.0.2.0.3` | PolyForm Shield 1.0.0 / Odoo-Manifesteinstellung `Other proprietary` | Zugfolge-Projektion, Weltkatalog, Portal, Freigabe, Signaturgrenze, Feedback |

Odoo Community ist frei selbst hostbar; die Odoo-19-Dokumentation nennt
Community unter LGPLv3 sowie Python ab 3.10 und PostgreSQL ab 13. Das Add-on
verwendet absichtlich Odoos native Benutzer/Gruppen, Kontakte, CRM,
Rechnungen/Zahlungen, Aktivitäten und Mail-Thread. `queue_job` ist der einzige
freigegebene OCA-Zusatz. Das OCA-Modul `auditlog` und OCA-Helpdesk sind hier
**nicht** zugelassen, weil ihre AGPL-Lizenz nicht in die Source-Available-
Lieferkette aufgenommen wird; die notwendige Zugfolge-Auditansicht bleibt im
eigenen Add-on und im autoritativen Game-Auditlog.

Primärquellen: [Odoo Community/Lizenz](https://www.odoo.com/documentation/19.0/legal/licenses.html), [Odoo-19-Installationsvoraussetzungen](https://www.odoo.com/documentation/19.0/administration/on_premise/source.html), [Odoo-Repository](https://github.com/odoo/odoo/tree/19.0), [OCA queue](https://github.com/OCA/queue/tree/19.0), [queue_job-Manifests](https://github.com/OCA/queue/blob/19.0/queue_job/__manifest__.py).

## Getrennte Installation

1. Einen eigenen unprivilegierten Betriebskonto- und Datenbank-Principal
   anlegen, beispielsweise Datenbank `zugfolge_odoo`; keine Rolle darf Login
   auf die Game-Datenbank besitzen.
2. Odoo exakt auf den oben genannten Pin installieren; OCA `queue` auf den
   genannten Commit auschecken und ausschließlich `queue_job` in
   `addons_path` aufnehmen. Das lokale Add-on aus diesem Repository zusätzlich
   als schreibgeschütztes Volume/Mount einhängen.
3. Erstinstallation und Upgrades ausschließlich mit Odoo-Modulupdate
   im Odoo-Container mit denselben Datenbank-, Add-on- und `queue_job`-
   Parametern wie im Normalbetrieb ausführen, zum Beispiel:
   `odoo -d zugfolge_odoo --db_host=odoo-postgres --db_user=odoo --db_password="$ODOO_DB_PASSWORD" --addons-path=/usr/lib/python3/dist-packages/odoo/addons,/mnt/extra-addons --load=base,web,queue_job -u zugfolge_admin --stop-after-init`.
   Ein Upgrade erfolgt in Staging mit Kopie der Odoo-Datenbank, dann Backup,
   Wartungsfenster, Modulupdate und Health-/Smoke-Test. Game-Migrationen und
   Odoo-Migrationen bleiben getrennte Vorgänge.
4. Einen Liveness-Check auf den Odoo-Prozess und einen Readiness-Check auf die
   separate Odoo-Datenbank einrichten. Die Game-Readiness darf bei
   Odoo-Ausfall höchstens `degraded`, nie `down` werden.
5. Täglich konsistente Odoo-PostgreSQL-Backups erzeugen und regelmäßig in
   einer isolierten Staging-Instanz wiederherstellen. Geheimnisse und
   Datenschutzfristen gehören in den Odoo-Betriebsrunbook, nicht in Git.

Das Administrationsmodul wird im Odoo-Apps-Dialog installiert. Es ersetzt
nicht `res.users`, `res.partner`, CRM-Leads, Rechnungen, Zahlungen, Refunds
oder Aktivitäten; diese bleiben die nativen Odoo-Modelle und -Workflows.
`product.template.zugfolge_product_kind` ordnet einem nativen Odoo-Produkt
einen erlaubten Entitlement-Typ zu. Wenn eine ausgehende Rechnung bezahlt,
storniert oder rückabgewickelt wird, reiht `account.move` ein idempotentes
`entitlement.change`-Kommando über `queue_job` ein. Eine Rechnung darf dabei
höchstens eine solche Produktzeile enthalten; die Game-Event-ID bleibt über
die Rechnungs-Korrelation stabil.

Ein konkretes `zugfolge.world.offer` bindet einen signiert projizierten
Game-Weltsnapshot an Teilnahmebedingungen, optional ein natives Odoo-Produkt
und ein verwaltetes Banner-Attachment. Nach `account.move.payment_state=paid`
erzeugt Odoo eine `zugfolge.world.participation` und stellt
`world.participation.change` per `queue_job` zu. Der Portalzustand wechselt
`pending_payment → paid → provisioning → active/rejected`; Storno und Erstattung
werden als `cancelled` beziehungsweise `refunded` zurückprojiziert. Odoo
erzeugt niemals selbst einen Game-Zugang.

## Upgrade auf 19.0.2.0.3

Das Modulupdate legt Weltangebote/-teilnahmen und Website-Views an. Historische
OAuth-Zeilen werden bewusst **nicht** nachträglich als verifiziert behandelt,
weil der frühere Datensatz den Claim `email_verified` nicht beweist. Bestehende
Portalprofile erhalten ihre stabile Keycloak-`sub` beim nächsten erfolgreich
validierten OIDC-Login. Vor dem Update sind Odoo-Datenbank und Filestore
gemeinsam zu sichern; anschließend sind Modulupdate, Odoo-Tests und die
Banner-Anhangsstichprobe auszuführen.

Die Patchversion `19.0.2.0.3` ergänzt Odoo-19-Privileges und eine startbare
App-Aktion. Dadurch erhalten Systemadministratoren die Basisrolle
`Zugfolge Administration`; Freigabe-, Telemetrie- und Infra-Prüfrechte bleiben
getrennt und müssen weiterhin ausdrücklich vergeben werden. Ein bloßer
Containerneustart oder `--init` aktualisiert eine bereits installierte
Datenbank nicht verlässlich. Nach gemeinsamem Backup von Datenbank und
Filestore deshalb vor dem normalen Start einmalig ausführen:

```bash
odoo -d zugfolge_odoo \
  --db_host=odoo-postgres --db_user=odoo --db_password="$ODOO_DB_PASSWORD" \
  --addons-path=/usr/lib/python3/dist-packages/odoo/addons,/mnt/extra-addons \
  --load=base,web,queue_job -u zugfolge_admin --stop-after-init
```

Danach neu anmelden und die App **Zugfolge** mit Startaktion
**Weltmonitoring** prüfen.

## Keycloak-OIDC und Portalprovisionierung

1. Das offizielle Odoo-Modul `auth_oauth` mit `auth_signup` und `portal`
   installieren (durch das Add-on manifestiert).
2. Einen OAuth-Provider für den Keycloak-Realm anlegen und ausschließlich bei
   diesem Datensatz **Zugfolge Keycloak** aktivieren.
3. Authorization-, Token-/Userinfo-Endpunkt und Client-ID auf den Keycloak-
   Client konfigurieren. Client-Secret und Integrationsschlüssel bleiben im
   Odoo-/Keycloak-Secret-Store.
4. Keycloak muss `sub`, `email` und den booleschen Claim
   `email_verified=true` liefern. Ein unverifizierter oder subject-loser Login
   wird abgelehnt.

Die Erweiterung verwendet für den verifizierten markierten Provider gezielt
Odoos konfiguriertes Portal-Template und erzeugt den Erstnutzer auch dann
automatisch, wenn der globale `auth_signup`-Umfang auf B2B steht. Vor der
Kopie und danach prüft sie fail-closed, dass die Vorlage beziehungsweise der
Benutzer nicht intern ist, und bindet das stabile `sub` einmalig an
`res.partner`.
Keycloak-Rollen und Gruppen werden weder als Weltmitgliedschaft noch als
Spielberechtigung ausgewertet.

## Integrationskonfiguration

Die folgenden Werte sind **Bezeichner**, keine Repository-Geheimnisse. Sie
werden im Secret Store der jeweils getrennten Betriebsumgebung hinterlegt.

```dotenv
# Game API: Odoo -> Game
ODOO_WEBHOOK_TENANT_ID=production-tenant-id
ODOO_WEBHOOK_KEYS_JSON=[{"id":"2026-08","secret":"<secret>","activeFrom":"2026-08-01T00:00:00Z"},{"id":"2026-09","secret":"<next-secret>","activeFrom":"2026-09-01T00:00:00Z"}]
ODOO_WEBHOOK_AUTHORIZED_ACTORS_JSON={"commerce-service":["entitlement.change","world.participation.change"],"admin-service":["admin.world_deploy","admin.world_access_revoke","admin.infra_release_adoption","admin.manual_disruption_create"]}

# Game API: Game -> Odoo
ODOO_PROJECTION_URL=https://odoo.example.invalid/zugfolge/projection
ODOO_PROJECTION_KEY_ID=2026-08
ODOO_PROJECTION_SECRET=<different-direction-secret>
ODOO_RECONCILIATION_URL=https://odoo.example.invalid/zugfolge/reconciliation/snapshot
```

Im Odoo-Systemparameter-Store stehen getrennt `zugfolge_admin.game_world_origins_json`,
`zugfolge_admin.tenant_id`, `zugfolge_admin.webhook_key_id`,
`zugfolge_admin.webhook_secret` und `zugfolge_admin.projection_keys_json` (JSON-Key-ID→Secret, während Rotation mit beiden aktiven IDs).
`zugfolge_admin.actor_reference` muss genau den technischen Akteur des
`ODOO_WEBHOOK_AUTHORIZED_ACTORS_JSON` enthalten, zum Beispiel
`admin-service`; Antragsteller und Freigeber bleiben zusätzlich im signierten
Kommando erhalten. Je Richtung gelten verschiedene Schlüssel. Rotation bedeutet: neuen Schlüssel
zuerst auf der empfangenden Seite zusätzlich aktivieren, Senden umstellen, das
fünfminütige Zeitfenster abwarten und den alten Schlüssel erst danach entfernen.

Das Weltserverregister ist ein JSON-Objekt von Hauptwelt-UUID zu kanonischer
HTTPS-Origin, zum Beispiel
`{"11111111-1111-4111-8111-111111111111":"https://welt-a.example.invalid"}`.
Jede Origin darf genau einmal vorkommen; Pfad, Benutzerinfo und Query sind
unzulässig. Das Add-on sendet an `/api/integrations/odoo/webhooks` dieser
Origin und folgt keinen Weiterleitungen. Damit erreicht der HTTP-Host genau
die an `ZUGFOLGE_WORLD_ID` und `PUBLIC_GAME_URL` gebundene Serverinstanz.
Die bisherige globale `game_webhook_url` wird nicht als Fallback verwendet.
Tutorialwelten besitzen keinen kaufmännischen Eintrag und erhalten weder
Teilnahme- noch Verwaltungsbefehle über diesen Kanal.

Ein zentrales Odoo darf mehrere eigenständige Weltserver verwalten. Odoo-
Mandant und Accounting-Company bezeichnen kaufmännische Zuständigkeiten;
sie sind keine Spielwelt und berechtigen keinen Server zum Betrieb weiterer
Hauptwelten. Konkrete Weltangebote, Rechnungsableitung, Jobs und Rückmeldungen
binden ihre Zielwelt. Kontoweite Entitlements wie Plus/Kosmetik behalten ihren
weltunabhängigen Vertrag und werden mit identischer Event-ID ausdrücklich auf
alle registrierten Hauptweltserver projiziert. Beim Hinzufügen eines Servers
sind bestehende Entitlements vor Verkaufsfreigabe ebenfalls dorthin zu
projizieren; ein automatischer historischer Nachlieferungslauf ist noch nicht
implementiert.

Der Receiver prüft die Zielwelt vor dem Queue-Commit. Der Worker prüft sie
erneut vor jeder Wirkung, auch bei historischen Queue-Einträgen. Ein
`world_deploy`-Kommando trägt die tatsächliche Zielwelt; der globale
Capability-Scope ist dafür keine zulässige Ersatzwelt. Der Reconciliation-
Aufruf trägt die Serverhauptwelt und vergleicht nur deren lokale Belege.
Globale Capabilities/Abschlussquittungen gehören nur bei bekannter lokaler
Message-ID zum Server; andere Welten eines zentralen Odoo werden nicht als
fremde Restore-Belege quarantänisiert.

## Vertrag, Wiederholung und Reconciliation

Jede Nachricht trägt `schemaVersion` `zugfolge-odoo/v1`, stabile Ereignis-ID,
Typ, Zeitstempel, Korrelation, Mandant und — wenn fachlich zutreffend —
`worldId`. Der Game-Receiver speichert eine Replay-Receipt und den Queue-Eintrag
in einer Transaktion. HMAC-SHA-256 über kanonisches JSON plus ISO-Zeitstempel
schützt Signatur, Zeitfenster und Reihenfolge-unabhängige Serialisierung.

Die Game-Outbox wird nach dem Game-Commit gefüllt. Der Bridge-Worker versucht
nicht zugestellte Projektionen erneut; Fehler bleiben als Versuchszähler und
Fehlercode sichtbar. Odoo akzeptiert eine Projektion über
`POST /zugfolge/projection`; das Add-on schreibt sie ausschließlich durch den
signierten Controller in schreibgeschützte Projektionsmodelle.

Der Nachtlauf fragt den nur dafür freigegebenen Odoo-Reconciliation-Snapshot ab,
vergleicht stabile IDs, Korrelation und Hash und
erzeugt bei fehlenden, doppelten oder divergierenden Einträgen eine auditierte
Korrekturaufgabe. Auch bekannte Outboxnachrichten ohne Empfangsbestaetigung
werden verglichen: Ein verlorenes Ack ist kein unbekannter Beleg. Als fehlend
gelten nur bereits vor Beginn der Snapshotanfrage bestaetigte Zustellungen;
spaetere Acks erzeugen keinen falschen Fehlbestand. Beobachtungen ohne Game-ID
kommen dedupliziert in `odoo_projection_quarantine`, auch wenn ihre Welt nach
einem asynchronen Restore nicht mehr existiert. Diese Quarantaene ist ein
administrativer Befund, keine Spielautoritaet. Die Aufloesung ist manuell zu
auditieren; es gibt keine automatische Loeschung oder Uebernahme.
Er überschreibt weder Game- noch Odoo-Daten still. Der
Reconciler ist erst nach einem echten externen Odoo-Testdienst als
Abnahmenachweis ausführbar.

## M9-Steuerung im Add-on

- **M9.2/M9.3:** `world_deploy` ist ein Hochrisikoantrag, der ohne vorhandene
  Weltprojektion angelegt werden darf. Odoo erfasst Weltdefinition und
  `StartingCapitalPolicy`, standardmäßig endliche null Cent, als erste Phase.
  Das schreibgeschützte Feld `signing_configuration` liefert Weltdefinition und
  Policy als exaktes JSON für den externen Generator. Erst dessen vollständiger
  Kandidat wird außerhalb Odoos Ed25519-signiert und danach samt
  Deployment-Hash angehängt. Die HMAC-Signatur des Webhooks schützt nur den
  Transport. Das Game prüft Ed25519, alle Hashes, Weltbindung, Release-Pins und
  identische Policy erneut und startet allein autoritativ. Nach Einreichen sind
  Definition, Policy und Deployment in Odoo unveränderlich; die anschließende
  Game-Projektion von Profil, Policy und Hashes ist read-only. Tutorial und
  öffentliche Welt verwenden getrennte Deployments, und ein Startpaket darf
  nur einer Tutorial-Einladung zugeordnet werden. → [ADR-0028](adr/0028-getrennter-tutorial-und-wettbewerbsstart.md)
- **M9.4:** `zugfolge.admin.request` nutzt native Odoo-Gruppen, Mail-Thread
  und Aktivitäten. Hochrisikoaktionen verlangen eine andere `res.users`-
  Freigabe. Nur `action_dispatch` sendet einen typisierten HMAC-Befehl; kein
  Button schreibt Game-Daten direkt. Auch der Entzug einer Alpha-Einladung
  erzeugt nur einen hochriskanten `world_access_revoke`-Antrag; der frühere
  direkte Standardbefehl ist nicht mehr Bestandteil des produktiven Vertrags.
  Erst das Game deaktiviert nach erneuter Prüfung die Keycloak-Identität und
  entzieht den weltgebundenen Zugang.
- **M9.7:** `zugfolge.world.projection` zeigt nur versionierte,
  frischemarkierte Projektionen. Die Oberfläche trägt Textpräfixe für Zustand
  und Datenstand sowie Tabellenziffern; Farbe ist nicht alleiniger
  Zustandskanal. `zugfolge.feedback` referenziert Welt, Zeitraum, Release,
  Kennzahl, Ereignis oder Bericht. Spielerfeedback wird mit dem fachlichen
  Game-Datensatz atomar in die Outbox gelegt, enthält in Odoo nur ein stabiles
  Pseudonym und ist dort inhaltlich unveränderlich; bearbeitbar bleibt allein
  der native Triagezustand.
- **M9.10:** `infra_release_adoption` ist immer hochriskant, trägt
  Release-Hash und gewünschten Periodenwechsel und endet erst nach der
  Game-seitigen Vorabprüfung. Odoo aktiviert niemals einen Release.

## Vollständige Administration und vorbereitete Fähigkeiten

Die Zielarchitektur lässt alle menschlichen administrativen Game-Wirkungen als
`zugfolge.admin.request` in Odoo beginnen. Die bestehenden M0–M7-Entwicklungs-
und Bootstraprouten werden vor ihrer produktiven Administrationsfreigabe
einzeln überführt; spielereigene, regelgebundene Dispositionsentscheidungen
bleiben ausdrücklich im Game. Odoo erhält dafür keinen Generalschlüssel:
der Aktionskatalog ist im Add-on und im Game-Vertrag fest definiert. Eine
signierte `admin.capability.projection` des Games markiert eine Aktion je Welt
als `available`, `unavailable` oder `prepared`. Ohne diese Projektion zeigt
Odoo `prepared`, lässt Anträge erfassen und vier Augen prüfen, blendet die
Auslieferung aber aus. Das Game lehnt einen extern trotzdem eintreffenden,
nicht registrierten Befehl auditierbar ab.

`manual_disruption_create` bereitet M8.3 vor und ist immer hochriskant. Die
Odoo-Maske verlangt Beginn, Ende, Ursache, stabile Ressourcenbezeichner und
deklarierte Wirkung. Solange der M8-Worktree keinen echten Game-Handler und
dessen Capability-Projektion liefert, entsteht daraus **keine** Störung und
keine Simulations-, Konflikt- oder Dispositionswirkung. M8.3 bleibt daher in
`docs/milestones.md` offen.

## Öffentliche Website, Snippets und Cache

- `/welten` und `/welten/<world_id>` lesen ausschließlich veröffentlichte
  `zugfolge.world.offer`-Datensätze und den Odoo-Projektionscache.
- `/my/worlds` zeigt einem Portalnutzer durch Record Rule nur dessen eigene
  Teilnahmen. `/open` ist nur im Zustand `active` erreichbar.
- Vier Snippets sind im Website-Builder auswählbar: Weltenkarten, einzelnes
  Weltbanner, Live-Weltstatistiken und EVU gesamt/stark aktiv. Welt-UUID oder
  Gruppe (`all`, `active`, `open`) werden in den Snippet-Optionen gewählt.
- Der Browser fragt höchstens alle 60 Sekunden `/zugfolge/public/worlds` ab.
  Odoo antwortet mit ETag, `max-age=60`, `stale-while-revalidate=120` und
  einem 30-Requests-pro-Minute-Bucket. SSE wurde wegen der nur
  minutenaktuellen Aggregation und der höheren Verbindungslast verworfen.
- Mehr als 180 Sekunden alte Daten tragen sichtbar „möglicherweise veraltet“;
  Zeitpunkt und autoritative Bezugszeit bleiben sichtbar. Fehlende, leere,
  Fehler- und Editorzustände zeigen keine Dummy-Zahlen.

Banner werden erst mit Alt-Text, Quelle, Urheber, Lizenz und dokumentierter
Rechtefreigabe veröffentlicht. Bis dahin wird
`static/src/img/world-fallback.svg` ausgeliefert. Responsive Derivate 512,
1024 und 1920 Pixel bleiben verwaltete Odoo-Attachments.

## Forum und Helpdesk

`website_forum` ist ein offizielles Odoo-19-Modul und deshalb manifestierte
Voraussetzung. Helpdesk wird **nicht** stillschweigend vorausgesetzt: Odoo
Community liefert kein gleichwertiges offizielles Helpdesk-Modul in dieser
Installation. Eine spätere OCA-Helpdesk-Aufnahme erfordert eine eigene
Lizenz-/Security-/Wartungsfreigabe (insbesondere AGPL-Auswirkung) und einen
exakten 19.0-Pin. Bis dahin werden Supportbezug und Aktivitäten über CRM,
Kontakte, Mail-Thread und dokumentierte externe Supportkanäle geführt.

## Externer Integrationsnachweis

Vor M13.1-Abnahme ist gegen einen echten getrennten Odoo-19-Testdienst
auszuführen:

```bash
odoo -d zugfolge_odoo_test -i queue_job,zugfolge_admin --test-enable --stop-after-init
```

Dabei ist der End-to-End-Beleg mindestens einmal so auszuführen: natives Odoo-
Produkt mit `zugfolge_product_kind` anlegen → Rechnung mit einer Produktzeile
und Zugfolge-Kontoreferenz bezahlen → `queue_job` sendet den signierten
Webhook → Game-Receiver persistiert Receipt und Queue → Game materialisiert
das Entitlement → Odoo erhält den autoritativen Auditverweis über die Outbox.
Ein Hochrisikoantrag folgt analog: Entwurf → zweite Odoo-Freigabe →
`queue_job`/signierter Befehl → Game-Vorabprüfung → Auditprojektion.

Für `world_deploy` umfasst dieser Beleg zusätzlich zwei getrennte Anträge für
Tutorial und öffentliche Welt: Odoo-Konfiguration → externer Ed25519-Signer →
angehängtes signiertes Deployment → zweite Freigabe → HMAC-Webhook →
Game-Neuprüfung und Start → unveränderliche Odoo-Projektion. Ein negativer Lauf
mit abweichender Policy oder Deployment-Hash muss ohne Weltstart enden.

Für die Weltteilnahme zusätzlich: verifizierter Keycloak-Erstlogin erzeugt
automatisch ein Portalprofil → `/my/worlds` → natives Weltprodukt bezahlen →
doppelten Payment-Webhook zustellen → exakt ein Game-Zugang → Ergebnis in Odoo
`active` → Welt öffnen → Refund → Game-Zugang weltgebunden entzogen und Odoo
`refunded`. Die vier Snippets sind im echten Editor per Drag-and-drop, in
Deutsch und Englisch, mobil sowie per Tastatur/Screenreader zu prüfen.

Danach sind mindestens zu dokumentieren: unabhängiger Start ohne Game-
Datenbankzugriff, Health, Add-on-Tests, Kauf/Refund/Chargeback/Restore,
Doppelwebhook, abgelaufene und rotierte Schlüssel, Odoo-Ausfall, Queue-Neustart,
Bridge-Retry, nächtliche Reconciliation sowie Adminantrag mit Selbstfreigabe-
Ablehnung und Game-Ablehnung. Ohne diesen realen Dienst bleiben M13.1–M13.3 und
die Odoo-seitigen M9-Teile **offen**, auch wenn die lokalen Game-Tests grün
sind.
