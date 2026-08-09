/**
 * Postfach-Grundgerüst (M2.5): Nachrichten, Fristen, Quittierung.
 *
 * Bewusst generisch — `messageType` und `payload` (jsonb) halten offen, was
 * später hineinkommt: Trassenangebote, Ausschreibungen, Störungsmeldungen
 * (`docs/produkt.md` 3, `docs/wirtschaft.md` 5). Dieses Milestone liefert nur
 * das Gerüst, keinen einzigen konkreten Nachrichtentyp.
 */

import { accounts, mailboxMessages, type MailboxMessage } from "@zugfolge/db";
import { AuthorizationError, getAccount, type IdentityDatabase } from "@zugfolge/identity";
import { and, desc, eq } from "drizzle-orm";

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
    return existing;
  }
  return created;
}

/** Das eigene Postfach: alle Nachrichten des anfragenden Kontos, neueste zuerst. */
export async function listInbox(
  db: IdentityDatabase,
  input: { readonly worldId: string; readonly requestingKeycloakSubject: string },
): Promise<readonly MailboxMessage[]> {
  const account = await getAccount(db, {
    worldId: input.worldId,
    keycloakSubject: input.requestingKeycloakSubject,
  });
  if (account === undefined) {
    throw new AuthorizationError(`Kein Konto in Welt '${input.worldId}' — kein Postfach.`);
  }
  return db
    .select()
    .from(mailboxMessages)
    .where(and(eq(mailboxMessages.worldId, input.worldId), eq(mailboxMessages.recipientAccountId, account.id)))
    .orderBy(desc(mailboxMessages.sentAt));
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
    .where(and(eq(mailboxMessages.worldId, input.worldId), eq(mailboxMessages.id, input.messageId)))
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
    .where(eq(mailboxMessages.id, message.id))
    .returning();
  if (updated === undefined) {
    throw new Error("Quittierung konnte nicht gespeichert werden.");
  }
  return updated;
}

/** Ob eine Nachricht zu einem gegebenen Zeitpunkt überfällig ist: Frist verstrichen, noch nicht quittiert. */
export function isOverdue(message: Pick<MailboxMessage, "deadlineAt" | "acknowledgedAt">, asOf: Date): boolean {
  return message.deadlineAt !== null && message.acknowledgedAt === null && message.deadlineAt.getTime() < asOf.getTime();
}
