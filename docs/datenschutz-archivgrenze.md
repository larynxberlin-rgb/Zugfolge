# Datenschutz-Purge und bestehende Archivbelege

Prüfstand: 2026-09-05, Issue #520. Der produktive 90-Tage-Kontopurge und
365-Tage-Postfachpurge funktionieren für beschreibbare Welten. Für versiegelte
Cutover-Vorgänger existiert im aktuellen Vertrag keine sichere nachträgliche
Redaktion. Das ist eine offene Implementierungsgrenze, keine umgesetzte
Aufbewahrungsausnahme.

## Nachgewiesener Konflikt

Der historische Vertrag `zugfolge-world-final-history-seal/v1` aus Schema33
verwendet in `tools/alpha-ops/database-rollback-binding.mjs` für jede
weltgebundene Tabelle:

1. SHA-256 über die vollständige kanonische JSONB-Darstellung jeder Zeile.
2. SHA-256 über die sortierte Verkettung dieser Zeilenhashes, zusätzlich die
   Anzahl der Zeilen.
3. Einen kanonischen Welt-Hash über Schema, Weltkennung und diese Tabellenwerte.

Damit sind beispielsweise `accounts.keycloak_subject`,
`world_accesses.keycloak_subject`, Rollen und `mailbox_messages.payload`
Bestandteile des attestierten Zustands. Der unveränderliche
`world_cutover_receipts.predecessor_final_state_hash` bindet genau diesen
Welt-Hash. Der Cutover-Wiederanlauf rekonstruiert und vergleicht ihn.

Für eine Zeile `r` und ihre personenbezogen reduzierte Fassung `r'` gilt
`JSONB(r) != JSONB(r')`. Unter der Kollisionsresistenz des verwendeten
SHA-256-Vertrags können beide Fassungen denselben historischen Zeilenhash
nicht reproduzierbar liefern. Ein erfolgreicher Purge verändert deshalb den
Historienhash. Die Änderung des gespeicherten Sollhashes würde den alten
Receipt umdeuten; dessen Datenbanktrigger verbietet UPDATE und DELETE.

Der explizite Schema34-Kompatibilitätspfad hilft bei dieser Frage nicht:
Er entfernt aus einer historischen v1-Prüfung ausschließlich die nachträglich
hinzugefügten, nachweislich leeren Spalten. Er entfernt keine ursprünglichen
Felder. Sobald der neue Postfachpurge `purged_at` und `content_hash` schreibt,
darf dieser Pfad die neuen Fakten auch nicht mehr ausblenden.

## Reproduzierbarer Integrationstest

Aus dem Repository:

```sh
pnpm --filter @zugfolge/privacy exec vitest run src/archived-retention.test.ts --maxWorkers=1 --no-file-parallelism
```

Der Test erstellt eine echte Schema33-Datenbank mit personenbezogenen
Altzeilen, archiviert die Welt, erzeugt einen kanonischen Cutover-Receipt und
migriert auf Schema34. Er belegt anschließend:

- Das Upgrade erhält den ausdrücklich ausgewählten historischen v1-Seal.
- Die produktiven Purgefunktionen werden durch die Archiv-Fence abgewiesen;
  die historischen Belege bleiben unverändert.
- Der gespeicherte Cutover-Receipt lässt sich nicht überschreiben.
- In einer ausschließlich testinternen, anschließend vollständig
  zurückgerollten Transaktion wird gezeigt, was ein Fence-Bypass bewirken
  würde: Der Kontopurge verändert den historischen Hash; der Postfachpurge
  erzeugt zusätzlich Fakten, die der v1-Kompatibilitätspfad ablehnt.

Der Negativversuch ist kein Produktionspfad. Nach seinem Rollback stimmen
Originaldaten und Originalseal wieder überein.

## Fehlender Vertrag und enger möglicher Ausbau

Eine historische Redaktion benötigt einen neuen, explizit autorisierten
Brückenvertrag. Dieser muss mindestens Originalbeleg und Originalhash,
betroffene Objekte und erlaubte personenbezogene Felder, den reduzierten
Zustand und seine Prüfmethode sowie einen vertrauenswürdigen
Redaktionsnachweis binden. Originalsignaturen bleiben erhalten; ein
gesonderter Prüfer muss den Übergang verifizieren. Ein solcher
Redaktionsvertrag oder eine entsprechende signierte Attestierung ist im
Repository nicht implementiert. Vorhandene Rollbackbelege bestätigen
unveränderte Artefakte und erteilen diese zusätzliche Autorität nicht.

Ein frei beschreibbarer Cache alter Zeilenhashes löst das Problem nicht: Er
könnte zugleich Änderungen nicht personenbezogener Felder verbergen. Das
Aufbewahren der vollständigen ursprünglichen Zeilen zum späteren Nachrechnen
wäre keine irreversible Löschung ihrer personenbezogenen Inhalte.

Davon zu unterscheiden ist der normale fachliche Weltabschluss durch
`WorldEndService`: Sein `zugfolge-world-final-state/v1` bindet Betriebsereignisse,
Ranglisten und Wirtschaftsbelege, nicht unmittelbar die Kontoprofil- oder
Postfachzeilen. Für Archive ohne zusätzlich gebundenen vollständigen
Cutover-Seal ist deshalb ein enger, versionierter Purgepfad grundsätzlich
möglich. Er müsste erlaubte Felder, unveränderte fachliche Belege,
Welt-/Kontobindung, Sperr- und Wiederanlaufverhalten explizit prüfen und seinen
neuen Schema-/Recoveryvertrag mitliefern. Die aktuelle allgemeine
Archiv-Fence unterscheidet diesen Fall noch nicht. Er darf nicht als Beleg
dafür dienen, vorhandene vollständige Cutover-Siegel pauschal zu umgehen.
