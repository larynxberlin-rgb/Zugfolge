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
| Eigenes Add-on | `odoo/addons/zugfolge_admin`, Version `19.0.1.0.0` | PolyForm Shield 1.0.0 / Odoo-Manifesteinstellung `Other proprietary` | Zugfolge-Projektion, Freigabe, Signaturgrenze, Feedback |

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
   ausführen: `odoo -d zugfolge_odoo -u zugfolge_admin --stop-after-init`.
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

## Integrationskonfiguration

Die folgenden Werte sind **Bezeichner**, keine Repository-Geheimnisse. Sie
werden im Secret Store der jeweils getrennten Betriebsumgebung hinterlegt.

```dotenv
# Game API: Odoo -> Game
ODOO_WEBHOOK_TENANT_ID=production-tenant-id
ODOO_WEBHOOK_KEYS_JSON=[{"id":"2026-08","secret":"<secret>","activeFrom":"2026-08-01T00:00:00Z"},{"id":"2026-09","secret":"<next-secret>","activeFrom":"2026-09-01T00:00:00Z"}]
ODOO_WEBHOOK_AUTHORIZED_ACTORS_JSON={"commerce-service":["entitlement.change"],"admin-service":["admin.world_access_revoke","admin.infra_release_adoption"]}

# Game API: Game -> Odoo
ODOO_PROJECTION_URL=https://odoo.example.invalid/zugfolge/projection
ODOO_PROJECTION_KEY_ID=2026-08
ODOO_PROJECTION_SECRET=<different-direction-secret>
ODOO_RECONCILIATION_URL=https://odoo.example.invalid/zugfolge/reconciliation/snapshot
```

Im Odoo-Systemparameter-Store stehen getrennt `zugfolge_admin.game_webhook_url`,
`zugfolge_admin.tenant_id`, `zugfolge_admin.webhook_key_id`,
`zugfolge_admin.webhook_secret` und `zugfolge_admin.projection_keys_json` (JSON-Key-ID→Secret, während Rotation mit beiden aktiven IDs).
Je Richtung gelten verschiedene Schlüssel. Rotation bedeutet: neuen Schlüssel
zuerst auf der empfangenden Seite zusätzlich aktivieren, Senden umstellen, das
fünfminütige Zeitfenster abwarten und den alten Schlüssel erst danach entfernen.

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
Korrekturaufgabe. Er überschreibt weder Game- noch Odoo-Daten still. Der
Reconciler ist erst nach einem echten externen Odoo-Testdienst als
Abnahmenachweis ausführbar.

## M9-Steuerung im Add-on

- **M9.4:** `zugfolge.admin.request` nutzt native Odoo-Gruppen, Mail-Thread
  und Aktivitäten. Hochrisikoaktionen verlangen eine andere `res.users`-
  Freigabe. Nur `action_dispatch` sendet einen typisierten HMAC-Befehl; kein
  Button schreibt Game-Daten direkt.
- **M9.7:** `zugfolge.world.projection` zeigt nur versionierte,
  frischemarkierte Projektionen. Die Oberfläche trägt Textpräfixe für Zustand
  und Datenstand sowie Tabellenziffern; Farbe ist nicht alleiniger
  Zustandskanal. `zugfolge.feedback` referenziert Welt, Zeitraum, Release,
  Kennzahl, Ereignis oder Bericht.
- **M9.10:** `infra_release_adoption` ist immer hochriskant, trägt
  Release-Hash und gewünschten Periodenwechsel und endet erst nach der
  Game-seitigen Vorabprüfung. Odoo aktiviert niemals einen Release.

## Externer Integrationsnachweis

Vor M13.1-Abnahme ist gegen einen echten getrennten Odoo-19-Testdienst
auszuführen:

```bash
odoo -d zugfolge_odoo_test -i queue_job,zugfolge_admin --test-enable --stop-after-init
```

Danach sind mindestens zu dokumentieren: unabhängiger Start ohne Game-
Datenbankzugriff, Health, Add-on-Tests, Kauf/Refund/Chargeback/Restore,
Doppelwebhook, abgelaufene und rotierte Schlüssel, Odoo-Ausfall, Queue-Neustart,
Bridge-Retry, nächtliche Reconciliation sowie Adminantrag mit Selbstfreigabe-
Ablehnung und Game-Ablehnung. Ohne diesen realen Dienst bleiben M13.1–M13.3 und
die Odoo-seitigen M9-Teile **offen**, auch wenn die lokalen Game-Tests grün
sind.
