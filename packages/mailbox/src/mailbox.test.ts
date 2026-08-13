import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, schema, worlds } from "@zugfolge/db";
import { requestWorldAccess, type IdentityDatabase } from "@zugfolge/identity";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acknowledgeMessage,
  isOverdue,
  listInbox,
  MAILBOX_DUE_SOON_MILLISECONDS,
  MessageNotFoundError,
  RecipientNotFoundError,
  sendMessage,
} from "./mailbox.js";

const WORLD_LHE = "11111111-1111-1111-1111-111111111111";
const WORLD_MIDDLE_GERMANY = "22222222-2222-2222-2222-222222222222";
const AS_OF = new Date("2026-01-02T00:00:00Z");

let client: PGlite;
let db: IdentityDatabase;

beforeEach(async () => {
  client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await migrate(pgliteDb, { migrationsFolder: MIGRATIONS_FOLDER });
  db = pgliteDb;

  await pgliteDb.insert(worlds).values([
    { id: WORLD_LHE, name: "Leipzig–Halle–Erfurt", schedulePeriodWeeks: 4, epoch: new Date("2026-01-01T00:00:00Z") },
    {
      id: WORLD_MIDDLE_GERMANY,
      name: "Mitteldeutschland",
      schedulePeriodWeeks: 4,
      epoch: new Date("2026-01-01T00:00:00Z"),
    },
  ]);
});

afterEach(async () => {
  await client.close();
});

describe("sendMessage / listInbox", () => {
  it("stellt eine Nachricht dem richtigen Postfach zu", async () => {
    const anna = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-ben", displayName: "Ben" });

    await sendMessage(db, {
      worldId: WORLD_LHE,
      recipientAccountId: anna.id,
      messageType: "system.willkommen",
      payload: { text: "Willkommen in Leipzig–Halle–Erfurt" },
    });

    const annaInbox = await listInbox(db, { worldId: WORLD_LHE, requestingKeycloakSubject: "kc-anna", asOf: AS_OF });
    const benInbox = await listInbox(db, { worldId: WORLD_LHE, requestingKeycloakSubject: "kc-ben", asOf: AS_OF });

    expect(annaInbox).toHaveLength(1);
    expect(annaInbox[0]?.messageType).toBe("system.willkommen");
    expect(benInbox).toHaveLength(0);
  });

  it("lehnt eine Nachricht an ein Konto einer anderen Welt ab", async () => {
    const clara = await requestWorldAccess(db, {
      worldId: WORLD_MIDDLE_GERMANY,
      keycloakSubject: "kc-clara",
      displayName: "Clara",
    });

    await expect(
      sendMessage(db, {
        worldId: WORLD_LHE,
        recipientAccountId: clara.id,
        messageType: "system.willkommen",
        payload: {},
      }),
    ).rejects.toBeInstanceOf(RecipientNotFoundError);
  });

  it("neueste Nachricht zuerst", async () => {
    const anna = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await sendMessage(db, { worldId: WORLD_LHE, recipientAccountId: anna.id, messageType: "erste", payload: {} });
    await sendMessage(db, { worldId: WORLD_LHE, recipientAccountId: anna.id, messageType: "zweite", payload: {} });

    const inbox = await listInbox(db, { worldId: WORLD_LHE, requestingKeycloakSubject: "kc-anna", asOf: AS_OF });

    expect(inbox.map((message) => message.messageType)).toEqual(["zweite", "erste"]);
  });

  it("priorisiert serverseitig ueberfaellige und binnen 48 Stunden faellige Entscheidungen", async () => {
    const anna = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await sendMessage(db, { worldId: WORLD_LHE, recipientAccountId: anna.id, messageType: "system.info", payload: {}, sentAt: new Date("2026-01-02T00:00:00Z") });
    await sendMessage(db, { worldId: WORLD_LHE, recipientAccountId: anna.id, messageType: "cooperation.answer", payload: {}, sentAt: new Date("2026-01-01T20:00:00Z"), deadlineAt: new Date(AS_OF.getTime() + MAILBOX_DUE_SOON_MILLISECONDS) });
    await sendMessage(db, { worldId: WORLD_LHE, recipientAccountId: anna.id, messageType: "cooperation.expired", payload: {}, sentAt: new Date("2026-01-01T10:00:00Z"), deadlineAt: new Date("2026-01-01T23:59:59Z") });

    const inbox = await listInbox(db, { worldId: WORLD_LHE, requestingKeycloakSubject: "kc-anna", asOf: AS_OF });

    expect(inbox.map(({ messageType, priority, overdue }) => ({ messageType, priority, overdue }))).toEqual([
      { messageType: "cooperation.expired", priority: "overdue", overdue: true },
      { messageType: "cooperation.answer", priority: "due-soon", overdue: false },
      { messageType: "system.info", priority: "information", overdue: false },
    ]);
  });

  it("mischt weder fremde Konten noch andere Welten in die Prioritaetsprojektion", async () => {
    const anna = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    const ben = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-ben", displayName: "Ben" });
    const clara = await requestWorldAccess(db, { worldId: WORLD_MIDDLE_GERMANY, keycloakSubject: "kc-clara", displayName: "Clara" });
    await sendMessage(db, { worldId: WORLD_LHE, recipientAccountId: anna.id, messageType: "anna", payload: {}, deadlineAt: new Date("2026-01-01T00:00:00Z") });
    await sendMessage(db, { worldId: WORLD_LHE, recipientAccountId: ben.id, messageType: "ben", payload: {}, deadlineAt: new Date("2026-01-01T00:00:00Z") });
    await sendMessage(db, { worldId: WORLD_MIDDLE_GERMANY, recipientAccountId: clara.id, messageType: "clara", payload: {}, deadlineAt: new Date("2026-01-01T00:00:00Z") });

    const inbox = await listInbox(db, { worldId: WORLD_LHE, requestingKeycloakSubject: "kc-anna", asOf: AS_OF });
    expect(inbox.map((message) => message.messageType)).toEqual(["anna"]);
  });

  it("ordnet eine vollständige 48h-Offline-Rückkehr serverseitig und weltisoliert", async () => {
    const anna = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    const ben = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-ben", displayName: "Ben" });
    const departure = new Date("2026-01-01T08:00:00Z");
    const returnAfter48Hours = new Date(departure.getTime() + MAILBOX_DUE_SOON_MILLISECONDS);
    const overdue = await sendMessage(db, {
      worldId: WORLD_LHE, recipientAccountId: anna.id, messageType: "cooperation.contract-offer",
      payload: { contractId: "contract-due" }, sentAt: departure,
      deadlineAt: new Date(returnAfter48Hours.getTime() - 1),
    });
    const upcoming = await sendMessage(db, {
      worldId: WORLD_LHE, recipientAccountId: anna.id, messageType: "planning.path-offer",
      payload: { trainId: "train-7" }, sentAt: new Date(departure.getTime() + 1_000),
      deadlineAt: new Date(returnAfter48Hours.getTime() + MAILBOX_DUE_SOON_MILLISECONDS),
    });
    await sendMessage(db, {
      worldId: WORLD_LHE, recipientAccountId: ben.id, messageType: "cooperation.foreign",
      payload: { contractId: "secret" }, sentAt: departure,
      deadlineAt: new Date(returnAfter48Hours.getTime() - 1),
    });

    const returned = await listInbox(db, {
      worldId: WORLD_LHE, requestingKeycloakSubject: "kc-anna", asOf: returnAfter48Hours,
    });
    expect(returned.map(({ id, priority, overdue: isMessageOverdue }) => ({ id, priority, overdue: isMessageOverdue }))).toEqual([
      { id: overdue.id, priority: "overdue", overdue: true },
      { id: upcoming.id, priority: "due-soon", overdue: false },
    ]);

    await acknowledgeMessage(db, {
      worldId: WORLD_LHE, messageId: overdue.id, actingKeycloakSubject: "kc-anna",
      acknowledgedAt: returnAfter48Hours,
    });
    const afterAcknowledgement = await listInbox(db, {
      worldId: WORLD_LHE, requestingKeycloakSubject: "kc-anna", asOf: returnAfter48Hours,
    });
    expect(afterAcknowledgement.map(({ id, priority }) => ({ id, priority }))).toEqual([
      { id: upcoming.id, priority: "due-soon" },
      { id: overdue.id, priority: "acknowledged" },
    ]);
  });
});

describe("acknowledgeMessage", () => {
  it("quittiert eine eigene Nachricht", async () => {
    const anna = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    const message = await sendMessage(db, {
      worldId: WORLD_LHE,
      recipientAccountId: anna.id,
      messageType: "system.willkommen",
      payload: {},
    });

    const quittiert = await acknowledgeMessage(db, {
      worldId: WORLD_LHE,
      messageId: message.id,
      actingKeycloakSubject: "kc-anna",
      acknowledgedAt: new Date("2026-01-02T00:00:00Z"),
    });

    expect(quittiert.acknowledgedAt).not.toBeNull();
  });

  it("lehnt die Quittierung einer fremden Nachricht ab", async () => {
    const anna = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-ben", displayName: "Ben" });
    const message = await sendMessage(db, {
      worldId: WORLD_LHE,
      recipientAccountId: anna.id,
      messageType: "system.willkommen",
      payload: {},
    });

    await expect(
      acknowledgeMessage(db, {
        worldId: WORLD_LHE,
        messageId: message.id,
        actingKeycloakSubject: "kc-ben",
        acknowledgedAt: new Date("2026-01-02T00:00:00Z"),
      }),
    ).rejects.toThrow();
  });

  it("meldet eine unbekannte Nachricht", async () => {
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });

    await expect(
      acknowledgeMessage(db, {
        worldId: WORLD_LHE,
        messageId: "33333333-3333-3333-3333-333333333333",
        actingKeycloakSubject: "kc-anna",
        acknowledgedAt: new Date("2026-01-02T00:00:00Z"),
      }),
    ).rejects.toBeInstanceOf(MessageNotFoundError);
  });

  it("hält den ersten Quittierungszeitpunkt bei wiederholter Quittierung", async () => {
    const anna = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    const message = await sendMessage(db, {
      worldId: WORLD_LHE,
      recipientAccountId: anna.id,
      messageType: "system.willkommen",
      payload: {},
    });
    const erste = await acknowledgeMessage(db, {
      worldId: WORLD_LHE,
      messageId: message.id,
      actingKeycloakSubject: "kc-anna",
      acknowledgedAt: new Date("2026-01-02T00:00:00Z"),
    });

    const zweite = await acknowledgeMessage(db, {
      worldId: WORLD_LHE,
      messageId: message.id,
      actingKeycloakSubject: "kc-anna",
      acknowledgedAt: new Date("2026-06-01T00:00:00Z"),
    });

    expect(zweite.acknowledgedAt?.toISOString()).toBe(erste.acknowledgedAt?.toISOString());
  });
});

describe("isOverdue", () => {
  it("ist überfällig, wenn die Frist verstrichen und keine Quittierung erfolgt ist", () => {
    const message = { deadlineAt: new Date("2026-01-01T00:00:00Z"), acknowledgedAt: null };
    expect(isOverdue(message, new Date("2026-01-02T00:00:00Z"))).toBe(true);
  });

  it("ist nicht überfällig, wenn schon quittiert wurde", () => {
    const message = { deadlineAt: new Date("2026-01-01T00:00:00Z"), acknowledgedAt: new Date("2026-01-01T00:00:00Z") };
    expect(isOverdue(message, new Date("2026-01-02T00:00:00Z"))).toBe(false);
  });

  it("ist nicht überfällig ohne Frist", () => {
    const message = { deadlineAt: null, acknowledgedAt: null };
    expect(isOverdue(message, new Date("2026-01-02T00:00:00Z"))).toBe(false);
  });
});
