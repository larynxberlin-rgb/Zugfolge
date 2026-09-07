# Datenschutz-Purge und bestehende Archivbelege

## Schema 37: geprüfte Redaktionsbrücke (Implementierungsvertrag)

Der neue Vertrag `zugfolge-archive-privacy-redaction/v1` erlaubt ausschließlich
die bereits autorisierte Kontolöschung, den fälligen 90-Tage-Kontopurge und den
365-Tage-Postfachpurge einschließlich bestehender Frist-Holds. Er ändert keine
Betriebsereignisse, Ledgerdaten, Cutover-Receipts oder gespeicherten Sollsiegele.
Die folgenden historischen Abschnitte beschreiben den Ausgangskonflikt.

Die Datenbank führt jede Archivredaktion atomar unter dem exklusiven Weltlock
aus. Ein fester Auftrag benennt Welt, Aktion, Objekt und explizite Prüfzeit;
freie Tabellen-, Spalten- oder Ersatzdaten werden nicht angenommen. Die
Auftragsfunktion darf nur die fest beschriebenen persönlichen Felder reduzieren.
Alle übrigen Archivschreibvorgänge bleiben gesperrt. Selbstbedienung bzw.
Weltverwalterrecht wird weiterhin vor einer Löschanfrage geprüft; die täglichen
Retentionjobs dürfen ausschließlich bereits fällige Objekte abarbeiten.

Ein unveränderlicher Datenbankbeleg erfasst vor/nach der erlaubten Änderung
nur kanonische Zeilenhashes und die Kompatibilität zur historischen
Schema-33-Spaltenprojektion. Er enthält weder ursprünglichen Postfachinhalt
noch Keycloak-Subject, Anzeigename, ownerRef oder eine Kopie der gelöschten
Schaffnersitzung. Die vier privaten Tabellen conductor_owners,
conductor_leases, conductor_command_receipts und conductor_snapshots werden
entfernt; synthetische Zug- und Kontrollzustände bleiben bytegleich bestehen.

Die Historiensiegelprüfung validiert zuerst sämtliche aktuellen Zeilen gegen
die aufgezeichneten Nachher-Hashes und rekonstruiert anschließend die früheren
Hashmengen durch die geprüften Übergänge in umgekehrter Reihenfolge. Nur diese
Hashmengen werden rekonstruiert, keine persönlichen Inhalte. Zusätzliche,
veränderte oder fehlende Betriebszeilen bleiben dadurch erkennbare Fehler.
Alte v1-/v4-Sollhashes und Cutover-Receiptidentitäten werden nie ersetzt.

Ein separat aufzubewahrender Export bindet den vollständigen Redaktionsstand
mit SHA-256. Bei Restore muss dessen erwarteter Hash aus dem unabhängigen
Recoveryauftrag stammen, nicht aus dem zu restaurierenden Weltbackup. Ein
älteres Backup durchläuft dieselben festen Redaktionsaktionen, bis sein
Belegstand exakt diesem Pin entspricht. Fehlender Pin, fremde Welt, veränderte
Übergänge oder widersprechende Originalzeilen verhindern die Freigabe.
Ein unveränderter älterer Dump bleibt als ursprünglicher Backupbeleg erhalten;
die wiederhergestellte Datenbank darf dessen persönliche Inhalte erst nach
der verpflichtenden Redaktion wieder verlassen. Eine neue rohe Sicherung
muss den bereits bereinigten Datenbestand und seine Redaktionsbelege enthalten.

Die Integration prüft echte Schema-33- und Schema-36-Archive, originale
Cutover-Receipts, Upgrade, fällige Produktionsjobs, Wiederholung, Fremdwelt,
Manipulation, unveränderte Betriebsdaten sowie Restore aus einem älteren
Backup mit unabhängig gepinntem Redaktionsbeleg. Diese Datenbankbeweise sind
keine Behauptung eines bereits ausgeführten Löschlaufs realer Nutzerdaten.

## Produktiver Restoreablauf und unabhängige Freigabe

`tools/alpha-ops/archive-privacy-recovery.mjs` besitzt drei explizite Modi:

- `export` liest den aktuellen vollständigen Archivstand aus `DATABASE_URL`
  und erstellt `ARCHIVE_PRIVACY_OUTPUT_PATH` ausschließlich neu mit Modus 0600.
  Die Ausgabe nennt den SHA-256 der kanonischen Datei. Diese Datei und ihr
  erwarteter Hash werden unabhängig von älteren Weltbackups im Recoveryauftrag
  aufbewahrt. Nach weiteren Löschungen ist ein neuer vollständiger Export nötig.
- `restore` liest `ARCHIVE_PRIVACY_RECOVERY_PATH` und verlangt den separat
  vorgegebenen `ARCHIVE_PRIVACY_RECOVERY_SHA256`. Es akzeptiert ausschließlich
  Zielnamen `zugfolge_restore_*` oder `zugfolge_recovery_v1_*`, führt die
  eingecheckten Vorwärtsmigrationen aus und redigiert alle betroffenen Welten
  atomar. Jede tatsächlich erzeugte Hashfolge muss dem Pin entsprechen.
- `verify` prüft denselben Pin und den vollständigen tatsächlichen DB-Stand
  ausschließlich lesend. Fehlender oder veralteter Pin, fremde Welt, veränderte
  Zeilen und unvollständige Redaktion verhindern die Freigabe. Auch ein leerer
  Archivstand benötigt einen unabhängigen Pin, damit ein Backup aus der Zeit
  vor einer späteren Archivierung keine Löschung verschweigen kann.

Die vorhandenen `restore-game.sh` und `restore-game-recovery.sh` belegen
weiterhin nur den isolierten, identischen **Rohrestore** ihrer Dumpbytes. Sie
aktivieren keinen Spielserver. Anschließend wird der neue `restore`-Modus
gegen den aktuellen unabhängigen Löschauftrag ausgeführt. Seine Ausgabe ist
ein eigener `zugfolge-archive-privacy-recovery-result/v1`-Beleg; alte Dump-,
Restore- und Cutover-Receipts werden nicht umgeschrieben.

Die produktive Recoveryqualifizierung sowie Post-Fence-/Continuity-Prüfung
in `production-recovery-contract.mjs` prüfen den Archivpin im selben
Datenbanksnapshot wie den übrigen Zustand. Compose reicht dafür die beiden
`ARCHIVE_PRIVACY_RECOVERY_*`-Variablen an den vorhandenen Recoverydienst durch;
die Datei liegt beispielsweise im bereits eingebundenen `/recovery-material`.
Die bestehende Gleichheit zum qualifizierten **gesamten** Datenbankkopf bleibt
zwingend. Redaktion verändert diesen Kopf, obwohl die originalen Weltsiegel
gleich bleiben. Ein alter PII-Dump und der bereinigte Restore sind deshalb
keine identischen Rohsicherungen.

Der anschließend nutzbare Weg ist eine neue qualifizierte Sicherungsquelle:
`backup-game.sh` sichert den bereinigten Schema-37-Stand, `restore-game.sh`
restauriert diese neue Sicherung separat, und die vorhandenen Werkzeuge
`create-database-backup-restore-evidence.mjs` sowie
`create-database-rollback-proof.mjs` erzeugen die neuen Quellen-/Restorebelege
und `zugfolge-database-rollback-proof/v7`. Dazu gehört ein mit Schema 37
kompatibles und regulär freigegebenes Runtime-Tuple. Ein altes M9-Tuple wird
nicht nachträglich umgedeutet; dessen neue betriebliche Aktivierung ist eine
eigene Freigabe. Der #520-Nachweis umfasst den tatsächlichen Restore alter
Backupbytes, irreversible Entkopplung und erneut identisch restaurierbare
bereinigte Sicherungen, keine ausgeführte Produktivmigration.

## Historischer Prüfstand vor Schema 37

Am 2026-09-05 funktionierten die Purgejobs für beschreibbare Welten. Für
versiegelte Cutover-Vorgänger fehlte die oben implementierte Redaktionsbrücke.

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
migriert auf den ausdrücklich eingefrorenen Schema-36-Stand vor der
Redaktionsbrücke. Er belegt anschließend:

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

## Historische Anforderungen an den nun umgesetzten Brückenvertrag

Eine historische Redaktion benötigt einen neuen, explizit autorisierten
Brückenvertrag. Dieser muss mindestens Originalbeleg und Originalhash,
betroffene Objekte und erlaubte personenbezogene Felder, den reduzierten
Zustand und seine Prüfmethode sowie einen vertrauenswürdigen
Redaktionsnachweis binden. Originalsignaturen bleiben erhalten; ein
gesonderter Prüfer muss den Übergang verifizieren. Ein solcher
Redaktionsvertrag war zu diesem historischen Prüfstand nicht implementiert.
Vorhandene Rollbackbelege bestätigen
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
neuen Schema-/Recoveryvertrag mitliefern. Die damalige allgemeine
Archiv-Fence unterschied diesen Fall noch nicht. Er darf nicht als Beleg
dafür dienen, vorhandene vollständige Cutover-Siegel pauschal zu umgehen.

## Aktuelle Verhaltenstests

`packages/privacy/src/archive-redaction.test.ts` verwendet echte Migrationen
33 bzw. 36, echte Produktionsjobs und physische PGlite-Sicherungen. Es prüft
90-/365-Tage-Grenzen, Fachfrist-Hold, vier private M15-Tabellen, aktuelle
Autorisierung, Fremdwelt, unveränderte Betriebs-/Cutoverdaten, manipulierte
Trigger, gefälschte Hashübergänge mit atomarem Rollback und unabhängige
Aktivierungspins. Ein zweiter Backup-/Restorelauf des bereinigten Zustands
vergleicht den tatsächlichen vollständigen Game-Datenbankkopf. Der leere
Keycloak-Testtenant ist hierbei separat als Testfixture gekennzeichnet.
`database-rollback-binding.pglite.test.mjs` qualifiziert Schema 37 mit seinen
73 festen Triggern und beiden Redaktionsbelegtabellen als v7-Proof, zusätzlich
zu den unveränderten historischen Schema-33-bis-36-Verträgen.
