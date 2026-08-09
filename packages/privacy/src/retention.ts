/**
 * Aufbewahrungsfristen (M2.6): je Datenkategorie, wie lange sie nach dem
 * auslösenden Ereignis aufbewahrt wird. `purgeExpiredAccountData` setzt die
 * Kontofrist technisch um; der Produktionsserver plant diesen idempotenten
 * Lauf täglich ein. `retentionDeadline` macht jede Frist zusätzlich
 * nachrechenbar und testbar.
 */

export type RetentionCategory = "account" | "worldAccess" | "mailboxMessage" | "domainEvent" | "ledger";

export interface RetentionPolicy {
  readonly category: RetentionCategory;
  /** Aufbewahrungsdauer in Tagen ab dem Bezugsereignis; `null` heißt unbefristet. */
  readonly retentionDays: number | null;
  readonly reason: string;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Datenminimierung ist kein eigener Programmpfad, sondern eine Entwurfsregel,
 * die schon in M2.1–M2.5 wirkt: Der Anzeigename ist eine Angabe des
 * Spielsystems statt eines synchronisierten Keycloak-Feldes
 * (`weltgeruest.md` 1), das Postfach speichert nur `messageType` und
 * `payload`, keine zusätzlichen Profildaten, und der Ledger kennt EVU, nie
 * eine natürliche Person. Diese Tabelle hält fest, was **aufbewahrt** wird —
 * nicht, was zusätzlich erhoben werden könnte.
 */
export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  {
    category: "account",
    retentionDays: 90,
    reason:
      "Übergangsfrist nach einer Löschanfrage (M2.6): 90 Tage, damit eine versehentliche oder erschlichene " +
      "Löschung rückgängig gemacht werden kann, bevor sie endgültig wirkt.",
  },
  {
    category: "worldAccess",
    retentionDays: 90,
    reason: "folgt derselben Übergangsfrist wie das Konto, dem der Zugang zugeordnet ist.",
  },
  {
    category: "mailboxMessage",
    retentionDays: 365,
    reason: "ein Jahr nach Versand oder Quittierung; danach ohne Betriebsrelevanz für Fristen oder Nachweise.",
  },
  {
    category: "domainEvent",
    retentionDays: null,
    reason: "Audit- und Replay-Grundlage der Welt (`architektur.md` 2) — unbefristet, append-only seit M2.2.",
  },
  {
    category: "ledger",
    retentionDays: null,
    reason:
      "gesetzliche Aufbewahrungspflicht für Geschäftsunterlagen; der Ledger ist ohnehin unveränderlich (M2.4) " +
      "und trägt keine natürliche Person, nur EVU.",
  },
];

/** Die konkrete Aufbewahrungsfrist einer Datenkategorie ist nicht definiert. */
export class UnknownRetentionCategoryError extends Error {
  constructor(category: string) {
    super(`Keine Aufbewahrungsfrist für die Kategorie '${category}' definiert.`);
    this.name = "UnknownRetentionCategoryError";
  }
}

export function retentionPolicy(category: RetentionCategory): RetentionPolicy {
  const policy = RETENTION_POLICIES.find((entry) => entry.category === category);
  if (policy === undefined) {
    throw new UnknownRetentionCategoryError(category);
  }
  return policy;
}

/**
 * Der Zeitpunkt, ab dem eine Aufbewahrungsfrist abgelaufen ist — oder `null`,
 * wenn die Kategorie unbefristet aufbewahrt wird.
 */
export function retentionDeadline(category: RetentionCategory, referenceDate: Date): Date | null {
  const policy = retentionPolicy(category);
  if (policy.retentionDays === null) {
    return null;
  }
  return new Date(referenceDate.getTime() + policy.retentionDays * MILLISECONDS_PER_DAY);
}
