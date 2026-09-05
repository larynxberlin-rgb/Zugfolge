/**
 * Postfach-Grundgerüst (M2.5): Nachrichten, Fristen, Quittierung.
 *
 * Bewusst generisch — `messageType` und `payload` (jsonb) halten offen, was
 * später hineinkommt: Trassenangebote, Ausschreibungen, Störungsmeldungen
 * (`docs/produkt.md` 3, `docs/wirtschaft.md` 5). Dieses Milestone liefert nur
 * das Gerüst, keinen einzigen konkreten Nachrichtentyp.
 */

import { createHash } from "node:crypto";
import { accounts, mailboxMessages, type MailboxMessage } from "@zugfolge/db";
import { AuthorizationError, getAccount, type IdentityDatabase } from "@zugfolge/identity";
import { and, asc, desc, eq, isNull, lte, or } from "drizzle-orm";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function messageHash(input: { readonly messageType: string; readonly payload: unknown; readonly deadlineAt?: Date | null }): string {
  return createHash("sha256").update(canonical({ messageType: input.messageType, payload: input.payload, deadlineAt: input.deadlineAt?.toISOString() ?? null })).digest("hex");
}

export class MessageReplayConflictError extends Error {
  constructor() { super("Postfach-Idempotenzschluessel gehoert zu anderem Inhalt oder einer anderen Frist."); this.name = "MessageReplayConflictError"; }
}

export type MailboxPriority = "overdue" | "due-soon" | "action-required" | "information" | "acknowledged";
export type InboxMessage = MailboxMessage & { readonly priority: MailboxPriority; readonly overdue: boolean };

/** Innerhalb dieses Fensters wird eine offene Frist in der Aufmerksamkeitsschiene hochgestuft. */
export const MAILBOX_DUE_SOON_MILLISECONDS = 48 * 60 * 60 * 1_000;

const PRIORITY_RANK: Readonly<Record<MailboxPriority, number>> = Object.freeze({
  overdue: 0,
  "due-soon": 1,
  "action-required": 2,
  information: 3,
  acknowledged: 4,
});

/** Der Empfänger einer Nachricht hat kein Konto in dieser Welt. */
export class RecipientNotFoundError extends Error {
  constructor(worldId: string, recipientAccountId: string) {
    super(`Konto '${recipientAccountId}' existiert nicht in Welt '${worldId}' — keine Zustellung möglich.`);
    this.name = "RecipientNotFoundError";
  }
}

/** Die angesprochene Nachricht existiert nicht — oder nicht in dieser Welt. */
export class MessageNotFoundError extends Error {
  constructor(messageId: string, worldId: string) {
    super(`Nachricht '${messageId}' existiert nicht in Welt '${worldId}'.`);
    this.name = "MessageNotFoundError";
  }
}

/** Sendet eine Nachricht an ein Konto derselben Welt. */
export async function sendMessage(
  db: IdentityDatabase,
  input: {
    readonly worldId: string;
    readonly recipientAccountId: string;
    readonly messageType: string;
    readonly payload: unknown;
    readonly deadlineAt?: Date;
    readonly sentAt?: Date;
    /** Dauerhafter fachlicher Schlüssel; gleiche Welt/Empfänger/Schlüssel wird exakt einmal zugestellt. */
    readonly idempotencyKey?: string;
  },
): Promise<MailboxMessage> {
  const [recipient] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.worldId, input.worldId), eq(accounts.id, input.recipientAccountId)))
    .limit(1);
  if (recipient === undefined) {
    throw new RecipientNotFoundError(input.worldId, input.recipientAccountId);
  }

  const values = {
    worldId: input.worldId,
    recipientAccountId: input.recipientAccountId,
    messageType: input.messageType,
    payload: input.payload,
    deadlineAt: input.deadlineAt,
    sentAt: input.sentAt,
    idempotencyKey: input.idempotencyKey,
    contentHash: messageHash(input),
  };
  const [created] = input.idempotencyKey === undefined
    ? await db.insert(mailboxMessages).values(values).returning()
    : await db
        .insert(mailboxMessages)
        .values(values)
        .onConflictDoNothing({
          target: [mailboxMessages.worldId, mailboxMessages.recipientAccountId, mailboxMessages.idempotencyKey],
        })
        .returning();
  if (created === undefined) {
    const [existing] = await db
      .select()
      .from(mailboxMessages)
      .where(
        and(
          eq(mailboxMessages.worldId, input.worldId),
          eq(mailboxMessages.recipientAccountId, input.recipientAccountId),
          eq(mailboxMessages.idempotencyKey, input.idempotencyKey!),
        ),
      )
      .limit(1);
    if (existing === undefined) throw new Error("Nachricht konnte nicht zugestellt werden.");
    if ((existing.contentHash ?? messageHash(existing)) !== values.contentHash) throw new MessageReplayConflictError();
    return existing;
  }
  return created;
}

/** Das eigene Postfach: alle Nachrichten des anfragenden Kontos, neueste zuerst. */
export async function listInbox(
  db: IdentityDatabase,
  input: { readonly worldId: string; readonly requestingKeycloakSubject: string; readonly asOf: Date },
): Promise<readonly InboxMessage[]> {
  const account = await getAccount(db, {
    worldId: input.worldId,
    keycloakSubject: input.requestingKeycloakSubject,
  });
  if (account === undefined) {
    throw new AuthorizationError(`Kein Konto in Welt '${input.worldId}' — kein Postfach.`);
  }
  const messages = await db
    .select()
    .from(mailboxMessages)
    .where(and(eq(mailboxMessages.worldId, input.worldId), eq(mailboxMessages.recipientAccountId, account.id), isNull(mailboxMessages.purgedAt)))
    .orderBy(desc(mailboxMessages.sentAt));
  return messages
    .map((message) => projectInboxMessage(message, input.asOf))
    .sort((left, right) => {
      const rank = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
      if (rank !== 0) return rank;
      const deadline = (left.deadlineAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (right.deadlineAt?.getTime() ?? Number.MAX_SAFE_INTEGER);
      if (deadline !== 0) return deadline;
      const sent = right.sentAt.getTime() - left.sentAt.getTime();
      return sent !== 0 ? sent : left.id.localeCompare(right.id);
    });
}

/** Erzeugt die serverautoritative, zeitpunktgebundene Postfachprojektion. */
export function projectInboxMessage(message: MailboxMessage, asOf: Date): InboxMessage {
  if (!Number.isFinite(asOf.getTime())) throw new Error("Postfachzeitpunkt ist ungueltig.");
  const overdue = isOverdue(message, asOf);
  const dueSoon = message.deadlineAt !== null
    && message.acknowledgedAt === null
    && message.deadlineAt.getTime() >= asOf.getTime()
    && message.deadlineAt.getTime() <= asOf.getTime() + MAILBOX_DUE_SOON_MILLISECONDS;
  const priority: MailboxPriority = message.acknowledgedAt !== null ? "acknowledged"
    : overdue ? "overdue"
      : dueSoon ? "due-soon"
        : message.messageType.startsWith("system.") ? "information"
          : "action-required";
  return Object.freeze({ ...message, priority, overdue });
}

/**
 * Quittiert eine Nachricht. Nur der Empfänger selbst darf quittieren — nicht
 * einmal ein Weltverwalter quittiert stellvertretend, sonst wäre die
 * Quittierung kein Nachweis mehr, dass der Empfänger sie gesehen hat.
 * Wiederholte Quittierung ist ein Kein-Op: der erste Zeitpunkt bleibt gültig.
 */
export async function acknowledgeMessage(
  db: IdentityDatabase,
  input: {
    readonly worldId: string;
    readonly messageId: string;
    readonly actingKeycloakSubject: string;
    readonly acknowledgedAt: Date;
  },
): Promise<MailboxMessage> {
  const account = await getAccount(db, { worldId: input.worldId, keycloakSubject: input.actingKeycloakSubject });
  if (account === undefined) {
    throw new AuthorizationError(`Kein Konto in Welt '${input.worldId}' — keine Quittierung möglich.`);
  }

  const [message] = await db
    .select()
    .from(mailboxMessages)
    .where(and(eq(mailboxMessages.worldId, input.worldId), eq(mailboxMessages.id, input.messageId), isNull(mailboxMessages.purgedAt)))
    .limit(1);
  if (message === undefined) {
    throw new MessageNotFoundError(input.messageId, input.worldId);
  }
  if (message.recipientAccountId !== account.id) {
    throw new AuthorizationError(`Nachricht '${input.messageId}' gehört nicht diesem Konto.`);
  }
  if (message.acknowledgedAt !== null) {
    return message;
  }

  const [updated] = await db
    .update(mailboxMessages)
    .set({ acknowledgedAt: input.acknowledgedAt })
    .where(and(
      eq(mailboxMessages.worldId, input.worldId),
      eq(mailboxMessages.id, message.id),
      eq(mailboxMessages.recipientAccountId, account.id),
      isNull(mailboxMessages.acknowledgedAt),
    ))
    .returning();
  if (updated === undefined) {
    // Ein paralleler, gleichberechtigter Request darf den ersten Zeitpunkt
    // nicht ueberschreiben. Auch der Wiederholungs-Lesezugriff bleibt dabei
    // vollstaendig an Welt und Empfaenger gebunden.
    const [acknowledged] = await db
      .select()
      .from(mailboxMessages)
      .where(and(
        eq(mailboxMessages.worldId, input.worldId),
        eq(mailboxMessages.id, message.id),
        eq(mailboxMessages.recipientAccountId, account.id),
      ))
      .limit(1);
    if (acknowledged?.acknowledgedAt !== null && acknowledged?.acknowledgedAt !== undefined) return acknowledged;
    throw new Error("Quittierung konnte nicht gespeichert werden.");
  }
  return updated;
}

/** Ob eine Nachricht zu einem gegebenen Zeitpunkt überfällig ist: Frist verstrichen, noch nicht quittiert. */
export function isOverdue(message: Pick<MailboxMessage, "deadlineAt" | "acknowledgedAt">, asOf: Date): boolean {
  return message.deadlineAt !== null && message.acknowledgedAt === null && message.deadlineAt.getTime() < asOf.getTime();
}

/** 365 Tage ab Versand; eine noch laufende fachliche Frist haelt den Inhalt fest. */
export async function purgeExpiredMailboxMessages(db: IdentityDatabase, input: { readonly worldId: string; readonly asOf: Date; readonly batchSize?: number }): Promise<{ readonly purgedMessageIds: readonly string[]; readonly hasMore: boolean }> {
  const batchSize = input.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5_000 || !Number.isFinite(input.asOf.getTime())) throw new Error("Postfach-Raeumlaufparameter sind ungueltig.");
  const eligible = and(eq(mailboxMessages.worldId, input.worldId), isNull(mailboxMessages.purgedAt),
    lte(mailboxMessages.sentAt, new Date(input.asOf.getTime() - 365 * 24 * 60 * 60 * 1_000)),
    or(isNull(mailboxMessages.deadlineAt), lte(mailboxMessages.deadlineAt, input.asOf)));
  const candidates = await db.select().from(mailboxMessages).where(eligible).orderBy(asc(mailboxMessages.sentAt), asc(mailboxMessages.id)).limit(batchSize + 1);
  const purgedMessageIds: string[] = [];
  for (const candidate of candidates.slice(0, batchSize)) {
    const [purged] = await db.update(mailboxMessages).set({
      payload: {}, messageType: "system.retention-purged", contentHash: candidate.contentHash ?? messageHash(candidate), purgedAt: input.asOf,
    }).where(and(eligible, eq(mailboxMessages.id, candidate.id))).returning({ id: mailboxMessages.id });
    if (purged !== undefined) purgedMessageIds.push(purged.id);
  }
  return { purgedMessageIds, hasMore: candidates.length > batchSize };
}
