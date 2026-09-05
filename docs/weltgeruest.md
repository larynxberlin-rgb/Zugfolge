# Weltgerüst: Konten, Rollen, Weltzugänge, EVU, Ledger, Postfach, Datenschutz

Abschnitte 1–6 sind Ergebnis von **M2.1**: was das Spielsystem selbst über
Spieler weiß, im Unterschied zu dem, was Keycloak weiß — und warum diese
Grenze so gezogen ist. Abschnitte 7–10 tragen den Rest von M2 — EVU (M2.3),
Ledger-Kern (M2.4), Postfach (M2.5) und Datenschutz (M2.6) —, jeweils auf
demselben Fundament aus Konto und Weltzugang.

---

## 1. Die Grenze zur Identität

Keycloak ist der eigenständige OIDC-Identity-Provider (`architektur.md` 5):
Login, Passwort, E-Mail-Bestätigung, das globale Subject einer Person — das
alles bleibt dort. Das Spielsystem verifiziert nur ein mitgebrachtes
Zugriffstoken und liest daraus, **wer** sich meldet (`sub`, wahlweise
`preferred_username` als Vorschlag).

Alles, wofür das Spielsystem selbst Quelle der Wahrheit ist — Weltzugänge,
Spielerstatus, Rollen —, liegt als Drizzle-Schema in `packages/db`, neben
`worlds` und dem Event-Log aus M2.2 (Invariante 4 gilt für alle Tabellen einer
Welt gleich, nicht nur für die eigene Domäne). Ein Anzeigename im Spiel ist
deshalb eine **Angabe des Spielsystems**, nicht mit Keycloak synchronisiert:
ein Spieler wählt ihn beim ersten Zugang je Welt und kann ihn dort unabhängig
von seinem Keycloak-Konto führen.

## 2. Drei Bausteine

| Baustein | Bezeichner | Trägt |
|----------|------------|-------|
| Weltzugang | `worldAccesses` | ob ein Keycloak-Subject in einer Welt überhaupt auftreten darf — `active` oder `revoked` |
| Konto | `accounts` | das Spielkonto, das aus einem Weltzugang entsteht: Anzeigename, Erstellungszeitpunkt |
| Kontorolle | `accountRoles` | welche Rollen (`player`, `world_admin`) ein Konto in genau einer Welt trägt |

**Weltzugang und Konto sind bewusst getrennt.** Wird ein Zugang entzogen,
bleibt das Konto mit seiner Betriebshistorie bestehen — dieselbe Härte wie bei
der Insolvenz eines EVU (E8: „Der Account bleibt bestehen“). Ein entzogener
Zugang reaktiviert sich nicht von selbst über einen erneuten Beitritt; das
bleibt einer bewussten administrativen Handlung vorbehalten
(`AccessRevokedError`).

Jede der drei Tabellen trägt `world_id` als führende Spalte ihres
Eindeutigkeitsindex und einen Fremdschlüssel auf `worlds` (Invariante 4) —
geprüft vom Wächter `world-id` seit M0.2, nicht erst seit diese Tabellen
existieren.

## 3. Rollen und ihre Vergabe

Zwei Rollen, absichtlich knapp gehalten:

- **`player`** — entsteht automatisch mit jedem Konto.
- **`world_admin`** — verwaltet Zugänge und Rollen innerhalb genau einer Welt.

Weitere Rollen (etwa für Aufsicht, M9.4) kommen erst mit dem Milestone, der
sie tatsächlich braucht — eine Rolle ohne Berechtigung, die sie prüft, ist ein
Etikett ohne Wirkung.

**Der erste Weltverwalter entsteht durch Selbstermächtigung:** Trägt eine Welt
noch keinen `world_admin`, darf ein Konto sich **ausschließlich selbst** diese
Rolle zuweisen. Diese Ausnahme zielt bewusst nicht auf Dritte — sonst könnte
ein beliebiges frisches Konto ein beliebiges anderes zum Verwalter ernennen,
statt nur den einen ersten Verwalter zu ermöglichen. Jede weitere
Rollenvergabe verlangt, dass die handelnde Identität selbst `world_admin`
dieser Welt ist — und, weil die Zielprüfung nach `world_id` **und**
`account_id` geht, kann kein Verwalter einer Welt Rollen in einer anderen
vergeben.

## 4. Der Belegungstest

Der Beweis von M2 verlangt: „Zwei Konten derselben Welt sehen einander, zwei
Konten verschiedener Welten sehen einander nachweislich nicht.“ M2.1 liefert
die Kontoseite dieses Beweises, M2.2 die des Event-Logs (`monorepo.md`
Abschnitt 4):

- `listAccountsInWorld` verlangt selbst ein Konto in der angefragten Welt —
  wer keins hat, bekommt `AuthorizationError`, keine leere Liste. Eine leere
  Liste sähe wie eine leere Welt aus; die richtige Antwort ist „das siehst du
  nicht“.
- Die Abfrage selbst ist nach `world_id` geschnitten: Ein Konto einer anderen
  Welt kann in der Ergebnismenge nicht auftauchen, weil es nie Teil der
  Abfrage war — keine Filterung nachträglich, sondern Ausschluss von der
  Quelle her.

`packages/identity/src/accounts.test.ts` und `apps/game-api/src/app.test.ts`
führen genau diesen Test auf zwei Ebenen: einmal gegen die Datenbank direkt,
einmal über die HTTP-Schnittstelle.

## 5. Code und Umsetzung

| Ort | Inhalt |
|-----|--------|
| `packages/db/src/schema/world-accesses.ts`, `accounts.ts`, `account-roles.ts` | die drei Tabellen als Drizzle-Schema, neben `worlds` und `domain_events` (M2.2) |
| `packages/db/drizzle/` | von `drizzle-kit generate` erzeugte SQL-Migration für das gesamte Schema |
| `packages/identity/src/keycloak.ts` | Tokenverifikation gegen einen JWKS — testbar ohne echtes Keycloak |
| `packages/identity/src/accounts.ts` | Weltzugang, Kontoerzeugung, Rollenvergabe, world-geschnittene Abfragen über das Schema aus `packages/db` |
| `apps/game-api/src/app.ts` | Fastify-Anwendung: Authentifizierung, Routen für Zugang, Kontoliste, Rollenvergabe |
| `apps/game-api/src/server.ts` | Produktionseinstieg — echtes PostgreSQL, echter Keycloak-Realm |

**Tests laufen ohne laufendes PostgreSQL oder Keycloak.** Gegen die Datenbank
läuft dieselbe Migration wie im Betrieb, nur über `@electric-sql/pglite` statt
eines Datenbankservers; die Tokenverifikation läuft gegen ein lokal erzeugtes
Schlüsselpaar statt gegen einen echten Realm. Die Produktionsverdrahtung
(`server.ts`, `packages/db/src/client.ts`) verwendet ausschließlich
postgres-js gegen echtes PostgreSQL, wie `architektur.md` es festlegt — die
Testdoppel betreffen nur die Testläufe, nicht das ausgelieferte Verhalten.

## 6. Was M2.1 bewusst **nicht** enthält

- Keine EVU-Entität — das ist M2.3.
- Kein Postfach, kein Ledger — M2.4 und M2.5.
- Keine Einladungen für private Welten (M13.3) — `worldAccesses` trägt bereits
  die nötige Unterscheidung von Konto und Zugang, ihre Erzeugung bleibt aber
  auf den selbstbedienten Beitritt beschränkt, bis geschlossene Welten
  tatsächlich gebraucht werden.
- Keine weiteren Rollen jenseits von `player` und `world_admin`.

---

## 7. EVU als Entität (M2.3)

`packages/operators` bündelt Gründung, Stammdaten und Zuordnung eines EVU
(`Operator`) zu Welt und gründendem Konto — der erste Baustein von
`docs/wirtschaft.md`, der tatsächlich Code trägt. Absichtlich klein: Weder
Insolvenz-Eskalationsleiter (M6.13) noch Fahrzeuge, Personal oder Verträge
gehören hierher, nur was ein EVU *ist*, bevor es irgendetwas *tut*.

**Ein Konto kann mehrere EVU gründen.** Kooperation zwischen EVU
(`wirtschaft.md` 6 — Traktionsleistungen, Fahrzeugvermietung,
Bietergemeinschaften) setzt getrennte Rechtsträger voraus; eine Beschränkung
auf ein EVU je Konto hätte diese Fälle von vornherein ausgeschlossen, ohne
dass M2.3 dafür einen Grund liefert.

**Der Unternehmensname ist je Welt eindeutig** (`operators_world_name_idx`),
nicht global — E6 gibt Unternehmensmarken frei, aber zwei EVU derselben Welt
dürfen nicht denselben Namen tragen; in zwei verschiedenen Welten schon,
denn sie kennen einander nicht.

**Die EVU-Liste einer Welt trägt denselben Belegungstest wie die Kontoliste**
(Abschnitt 4): Nur ein Konto mit eigenem Weltzugang sieht sie. Die
vollständige Transparenz der Livemap (E9) betrifft den laufenden
Zugverkehr, nicht diese interne Verwaltungsschnittstelle — bis M4 eine
öffentliche EVU-Liste tatsächlich braucht, bleibt die engere Regel richtig
und wird nicht auf Vorrat gelockert.

| Funktion | Zweck |
|----------|-------|
| `foundOperator` | gründet ein EVU für ein bestehendes Konto in dieser Welt |
| `listOperatorsInWorld` | alle EVU einer Welt, nur für Mitglieder dieser Welt |
| `listOperatorsForAccount` | alle EVU, die ein Keycloak-Subject je gegründet hat, weltübergreifend |
| `getOperator` | ein einzelnes EVU samt gründendem Konto — Grundlage der Trägerprüfung des Ledger-Kerns |

Code: `packages/db/src/schema/operators.ts` (Tabelle `operators`),
`packages/operators/src/operators.ts`.

---

## 8. Ledger-Kern (M2.4)

`packages/economy` liefert den Ledger-Kern, den `docs/wirtschaft.md` 1
verlangt: „Geld wird ausschließlich als Integer-Cent in einem
unveränderlichen, ausgeglichenen Ledger geführt.“ Drei Tabellen tragen ihn
(`packages/db/src/schema/ledger-*.ts`):

| Tabelle | Trägt |
|---------|-------|
| `ledger_accounts` | ein benanntes Konto in den Büchern genau eines EVU |
| `ledger_transactions` | die Hülle einer Buchung: Beschreibung, Zeitpunkt, EVU — selbst ohne Betrag |
| `ledger_entries` | die einzelnen Buchungsposten einer Transaktion, in Integer-Cent (`bigint`) |

**Ausgeglichen.** `postLedgerTransaction` (`packages/economy/src/ledger.ts`)
weist jede Transaktion zurück, deren Buchungen nicht exakt null Cent
ergeben — geprüft von der reinen Funktion `isBalanced`
(`packages/economy/src/balance.ts`), unabhängig von jeder Datenbank und
deshalb mit `fast-check` property-testbar
(`packages/economy/src/balance.property.test.ts`): Für jede beliebige Menge
von Buchungsbeträgen ist die Menge ausgeglichen, sobald die letzte Buchung
genau den negierten Gegenwert der übrigen trägt — unabhängig von Reihenfolge
und Betrag. `packages/economy/src/ledger.test.ts` führt dieselbe Eigenschaft
zusätzlich gegen eine echte, wenn auch eingebettete Datenbank (PGlite): Nach
jeder Folge zufällig erzeugter, ausgeglichener Transaktionen summieren sich
die Salden aller Konten eines EVU zu null.

**Doppelte Buchführung.** Jede Transaktion braucht mindestens zwei
Buchungen (`IncompleteTransactionError` sonst) auf Ledger-Konten desselben
EVU (`ForeignLedgerAccountError` bei einer Buchung auf ein fremdes Konto —
ein EVU führt nie die Bücher eines anderen).

**Unveränderlich.** Wie das Event-Log aus M2.2 bietet dieses Modul
ausschließlich Einfüge- und Leseoperationen an — kein `update`, kein
`delete`. Kein Code stellt einen Weg dorthin bereit, und das ist die ganze
Durchsetzung: derselbe Mechanismus wie bei `domain_events` (M2.2).

**`postedAt` ist ein expliziter Wert des Aufrufers**, nie aus der
Systemuhr gelesen — `packages/economy/**` unterliegt der Regel
`no-wallclock` (`guards.config.json`, Domäne `economy`), dieselbe
Invariante 2, die im Simulationskern `now()` verbietet, hier auf
Wirtschaftscode ausgedehnt. Nur die Game-API (`apps/game-api`) selbst
liest die Uhr und reicht den Zeitpunkt als Wert hinein.

**Kostenarten und Kostenstellen bleiben M6.2 vorbehalten.** Der Ledger-Kern
kennt nur benannte Konten, keine Klassifikation nach Kostenart — genau die
Reihenfolge, die `docs/milestones.md` für M2.4 vorsieht: „Der Ledger lag
hinter den ersten Kosten — Ledger-Kern nach M2.4 vorgezogen; M6.2 setzt nur
noch Kostenarten darauf.“

Code: `packages/db/src/schema/ledger-accounts.ts`,
`ledger-transactions.ts`, `ledger-entries.ts`,
`packages/economy/src/balance.ts`, `ledger.ts`.

---

## 9. Postfach-Grundgerüst (M2.5)

`packages/mailbox` liefert das Grundgerüst, das `docs/produkt.md` 3 und
`docs/wirtschaft.md` 5 voraussetzen, ohne es selbst zu bauen: Trassenangebote,
Ausschreibungen, Störungsmeldungen und die Eskalationsleiter der Insolvenz
kommen erst mit ihren eigenen Milestones. M2.5 liefert nur, worauf sie alle
aufsetzen.

**Generisch statt vorentschieden.** Eine `mailbox_message`
(`packages/db/src/schema/mailbox-messages.ts`) trägt `messageType` (Text) und
`payload` (`jsonb`) — derselbe Schnitt wie beim Event-Log (M2.2): Ein neuer
Nachrichtentyp ist ein neuer `messageType`, keine neue Tabelle und keine neue
Migration.

**Nachrichten, Fristen, Quittierung** — die drei Felder aus dem Milestone,
wörtlich als Spalten:

| Feld | Trägt |
|------|-------|
| `sentAt` | Zeitpunkt des Versands |
| `deadlineAt` | optionale Frist, bis zu der eine Reaktion erwartet wird |
| `acknowledgedAt` | Zeitpunkt der Quittierung; `null` heißt ungelesen |

`isOverdue` (`packages/mailbox/src/mailbox.ts`) ist überfällig, wenn eine
Frist gesetzt, verstrichen und die Nachricht noch nicht quittiert ist —
eine reine Funktion, unabhängig vom Aufrufzeitpunkt, den der Aufrufer
mitbringt.

**Nur der Empfänger quittiert.** `acknowledgeMessage` verweigert die
Quittierung durch ein fremdes Konto — nicht einmal ein Weltverwalter
quittiert stellvertretend, sonst wäre die Quittierung kein Nachweis mehr,
dass der Empfänger die Nachricht tatsächlich gesehen hat. Wiederholte
Quittierung ist ein Kein-Op: der erste Zeitpunkt bleibt gültig.

**Versand bleibt vorerst eine Weltverwalter-Handlung**
(`POST /worlds/:worldId/accounts/:accountId/mailbox`, `apps/game-api`), weil
noch kein Spielsystem-Ereignis existiert, das automatisch Nachrichten
auslöst — das erste ist die Insolvenz-Eskalationsleiter (M6.13).

Code: `packages/db/src/schema/mailbox-messages.ts`,
`packages/mailbox/src/mailbox.ts`.

---

## 10. Datenschutz (M2.6)

`packages/privacy` trägt die vier Punkte aus `docs/architektur.md` 5 —
„Datenminimierung, Auskunft, Löschung, definierte Aufbewahrungsfristen“ — für
die Personendaten, die das Spielsystem selbst hält: Konto, Weltzugang, EVU
und Postfach. Ledger und Event-Log bleiben bewusst außen vor (siehe unten).

**Datenminimierung ist keine eigene Funktion, sondern eine Entwurfsregel**,
die schon vor M2.6 wirkt: Der Anzeigename ist eine Angabe des Spielsystems,
nicht mit Keycloak synchronisiert (Abschnitt 1); das Postfach speichert nur
`messageType` und `payload`, keine zusätzlichen Profildaten; der Ledger kennt
EVU, nie eine natürliche Person. M2.6 fügt dem nichts hinzu — es macht nur
den Rest der Rechte nach.

**Auskunft.** `exportAccountData` bündelt Konto (samt Rollen), den Status des
Weltzugangs, alle in dieser Welt gegründeten EVU und das vollständige
Postfach zu einem `PersonalDataExport` — was das Spielsystem über ein Konto
in einer Welt weiß, an einer Stelle, maschinenlesbar. Der versionierte
Export `zugfolge-personal-data-export/v2` enthält außerdem eigene
Weltvertragsbestätigungen, Tutorial-Sitzungen und kaufmännische Berechtigungen.
Die authentifizierte Selbst-Auskunft bleibt nach Entzug des Weltzugangs möglich.

**Löschung.** `eraseAccountData` anonymisiert den Anzeigenamen
(`"Gelöschtes Konto"`), setzt `accounts.erasedAt` und entzieht den
Weltzugang (`revokeWorldAccess`). Das Konto selbst — seine `id` und seine
Betriebshistorie — bleibt bestehen, aus demselben Grund wie bei einer
Insolvenz (E8): EVU, Ledger-Konten und Postfach-Nachrichten verweisen auf
die Konto-`id`, und eine physische Löschung risse entweder diese Verweise
oder eine Historie mit, die die Welt weiter braucht. Eine physische Löschung
ist ohnehin nicht der richtige Maßstab, sobald personenbezogene Daten schon
auf das Nötigste reduziert sind (Datenminimierung, oben) — anonymisieren
genügt.

Zwei Wege zur Löschung, kein dritter: die betroffene Identität löscht sich
selbst (`actingKeycloakSubject === targetKeycloakSubject`), oder ein
Weltverwalter löscht auf Anfrage ein fremdes Konto. Dafür trägt
`revokeWorldAccess` (`packages/identity`) seit M2.6 dieselbe
Selbstbedienungs-Ausnahme wie die Rollenvergabe aus Abschnitt 3: Eine
Identität entzieht sich jederzeit selbst den Zugang, unabhängig davon, ob
sie Weltverwalter ist.

**Aufbewahrungsfristen.** `packages/privacy/src/retention.ts` hält je
Datenkategorie eine Frist — oder ausdrücklich keine:

| Kategorie | Frist | Begründung |
|-----------|-------|------------|
| Konto, Weltzugang | 90 Tage nach Löschanfrage | Übergangsfrist gegen eine versehentliche oder erschlichene Löschung |
| Postfach-Nachricht | 1 Jahr nach Versand/Quittierung | ohne Betriebsrelevanz danach |
| Event-Log | unbefristet | Audit- und Replay-Grundlage der Welt (`architektur.md` 2) |
| Ledger | unbefristet | gesetzliche Aufbewahrungspflicht für Geschäftsunterlagen; ohnehin unveränderlich (M2.4) |

Der Produktionsserver führt täglich den Kontopurge nach der 90-Tage-Frist
und den Postfach-Räumlauf nach 365 Tagen aus. Wiederholte Löschanträge
verschieben den ursprünglichen Zeitpunkt nicht. Abgelaufene Postfachinhalte
werden entfernt; ein minimierter technischer Deduplizierungsbeleg verhindert,
dass ein späterer Zustell-Retry den Inhalt wiederherstellt. Fristen und
Räumlauf sind mit expliziter Prüfzeit testbar. Der tatsächliche Betrieb und
die Überwachung dieses Jobs im Zielstack bleiben Teil der M9-Betriebsdrills.

**Warum Ledger und Event-Log nicht Teil der Löschung sind.** Beide sind
unveränderlich (M2.2, M2.4) und tragen keine natürliche Person — der Ledger
kennt EVU, das Event-Log Weltverlauf. Eine Löschanfrage betrifft die Person,
nicht das EVU oder die Welt; „Recht auf Löschung“ hat ohnehin dort eine
Grenze, wo eine gesetzliche Aufbewahrungspflicht oder ein berechtigtes
Interesse besteht (Geschäftsunterlagen, Audit-Grundlage) — dieselbe Grenze,
die diese Tabellen bereits aus anderem Grund unveränderlich macht.

Code: `packages/db/src/schema/accounts.ts` (`erasedAt`),
`packages/identity/src/accounts.ts` (Selbstbedienungs-Ausnahme in
`revokeWorldAccess`), `packages/privacy/src/export.ts`, `erasure.ts`,
`retention.ts`.
