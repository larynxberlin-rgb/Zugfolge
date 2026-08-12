import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, alphaFeedback, alphaWorldProfiles, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AlphaFeedbackService, type AlphaFeedbackProjectionPort } from "./feedback.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-12T10:00:00.000Z");
let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await db.insert(worlds).values({ id: WORLD, name: "Alpha", schedulePeriodWeeks: 4, epoch: NOW });
  await db.insert(alphaWorldProfiles).values({
    worldId: WORLD, profileKind: "public", regionId: "mitteldeutschland-b", regionVariant: "B", worldSeed: 1n,
    accelerationFactor: 1, infraReleaseHash: "a".repeat(64), timetableReleaseHash: "b".repeat(64),
    fleetReleaseHash: "c".repeat(64), economyReleaseHash: "d".repeat(64), blueprint: {}, blueprintHash: "e".repeat(64),
  });
});

afterEach(async () => client.close());

describe("Alpha-Feedbackprojektion", () => {
  it("persistiert Feedback und pseudonymisierte Odoo-Outbox atomar", async () => {
    const enqueue = vi.fn<AlphaFeedbackProjectionPort["enqueue"]>(async (_tx, feedback) => {
      expect(feedback.participantPseudonym).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(feedback)).not.toContain("kc-external-player");
    });
    const service = new AlphaFeedbackService(db, "phase-3-pseudonym-secret-with-32-characters", { enqueue });
    await service.submit({
      worldId: WORLD, keycloakSubject: "kc-external-player", fromS: 10, untilS: 20,
      category: "usability", message: "Die Warteschlange ist nicht klar erklaert.", contactAllowed: false,
    }, NOW);
    expect(await db.select().from(alphaFeedback)).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("rollt den fachlichen Datensatz zurueck, wenn die Outbox nicht geschrieben werden kann", async () => {
    const service = new AlphaFeedbackService(db, "phase-3-pseudonym-secret-with-32-characters", {
      enqueue: async () => { throw new Error("outbox unavailable"); },
    });
    await expect(service.submit({
      worldId: WORLD, keycloakSubject: "kc-external-player", fromS: 10, untilS: 20,
      category: "bug", message: "Der Feedbackpfad soll atomar bleiben.", contactAllowed: false,
    }, NOW)).rejects.toThrow("outbox unavailable");
    expect(await db.select().from(alphaFeedback)).toHaveLength(0);
  });
});
