# Odoo-Weltkatalog-, Teilnahme- und Projektionsverträge v1

## Odoo → Game: `world.participation.change`

Die vorhandene signierte Hülle `zugfolge-odoo/v1` bleibt unverändert. `eventId` schützt Transport-Replay; `command.idempotencyKey` schützt zusätzlich gegen doppelte Payment-Webhooks mit neuer Event-ID.

```json
{
  "schemaVersion": "zugfolge-odoo/v1",
  "eventId": "odoo-8d77...:provision",
  "eventType": "commerce.command",
  "occurredAt": "2026-08-13T06:00:00Z",
  "correlationId": "9b7d...",
  "tenantId": "production-tenant-id",
  "actorReference": "commerce-service",
  "command": {
    "kind": "world.participation.change",
    "schemaVersion": "zugfolge-world-participation/v1",
    "action": "provision",
    "worldId": "11111111-1111-4111-8111-111111111111",
    "keycloakSubject": "stable-keycloak-sub",
    "displayName": "Portalname",
    "odooPartnerReference": "42",
    "odooOrderReference": "SO0042",
    "paymentReference": "INV/2026/0042",
    "idempotencyKey": "8d77...:provision",
    "requestedAt": "2026-08-13T06:00:00Z"
  }
}
```

Erlaubte Aktionen sind `provision`, `cancel` und `refund`. Das Game prüft UUID, Weltprofil, Lebenszyklus, signierten Aufnahmevertrag, Kapazität und vorhandene Teilnahme unter Welt-Lock. Ein Ergebnis wird als `world.participation.result` mit `active`, `rejected`, `cancelled` oder `refunded` projiziert. `rejectionCode` ist maschinenlesbar; Fehlertexte enthalten keine Geheimnisse oder Personaldaten.

## Game → Odoo: `public.world.snapshot`

`payload.projectionVersion` ist `zugfolge-public-world-snapshot/v1`. Pflichtfelder:

- `worldId`, `worldName`, `shortDescription`, `phase`;
- `startsAt`, `endsAt`, `authoritativeAsOf`, `remainingRuntimeSeconds`;
- `startingCapitalPolicy` als `{mode:"finite",amountCents:"0"}` oder `{mode:"unlimited"}`;
- `totalOperators`, `stronglyActiveOperators | null`, `activityPolicyStatus`, Erklärung;
- `capacity`, `freePlaces`, `admissionStatus`;
- Region, Regelrelease und vier Release-Hashes;
- Banner-Metadaten ohne Binärdatei;
- `generatedAt`.

Die Datenschutzprüfung verwirft unter anderem `keycloakSubject`, E-Mail, Partner-, Konto-, Spieler- oder EVU-ID, individuelle Aktivitätshistorie sowie Zahlungs-/Bestellreferenzen an jeder Verschachtelungstiefe. Odoo speichert den Snapshot als Cache. Websitebesucher greifen nie auf das Game zu.

## Signatur und Replay

Beide Richtungen verwenden getrennte rotierbare HMAC-Schlüssel. Die Signatur umfasst `timestamp + "." + canonicalJson(payload)`; maximale Abweichung fünf Minuten. Der Game-Receiver prüft Key-ID, aktives Zeitfenster, Mandant, technischen Akteur, Command-Katalog, Schema und Weltbindung, bevor Receipt und Queue atomar geschrieben werden.

## Fehler- und Stale-Semantik

- fehlender Snapshot: leere, verständliche Website-Darstellung;
- älter als 180 Sekunden: `stale` mit letztem Aktualitätszeitpunkt;
- `ActivityPolicy=null`: `stronglyActiveOperators=null`, nicht `0`;
- unbekannte/volle/geschlossene Welt: autoritative Ablehnung ohne Mitgliedschaft;
- Duplicate: HTTP-Annahme mit `duplicate=true`, keine zweite Wirkung.
