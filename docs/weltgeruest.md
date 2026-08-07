# Weltgerüst: Konten, Rollen, Weltzugänge

Ergebnis von **M2.1**. Beschreibt, was das Spielsystem selbst über Spieler
weiß, im Unterschied zu dem, was Keycloak weiß — und warum diese Grenze so
gezogen ist.

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
