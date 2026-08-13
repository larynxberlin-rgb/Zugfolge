import { PGlite } from "@electric-sql/pglite";
import { economyOutbox, MIGRATIONS_FOLDER, schema, worlds } from "@zugfolge/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EconomyDatabase } from "./ledger.js";
import { buildEconomyRelease } from "./release.js";
import {
  dispatchEconomyOutbox,
  EconomyStateConflictError,
  listEconomyWorldIds,
  listPendingEconomyEffects,
  loadEconomyWorldState,
  persistEconomyTransition,
} from "./state-store.js";
import { closeEconomyWorld, startEconomyWorld } from "./workflow.js";

const WORLD_ID = "33333333-3333-3333-3333-333333333333";
const OTHER_WORLD_ID = "44444444-4444-4444-8444-444444444444";
const release = buildEconomyRelease({
  version: "state-store-1",
  rates: {
    trackPerTrainKmCents: 1n, stationPerStopCents: 1n, facilityPerHourCents: 1n,
    energyPerKwhCents: 1n, personnelPerHourCents: 1n, administrationPerPeriodCents: 1n,
    vehiclePerPeriodCents: 1n, overnightStablingPerPeriodCents: 1n,
    protectionEquipmentPerPeriodCents: 1n, lateInterestBasisPoints: 1,
  },
  rules: {
    qualityBaselinePunctualityBasisPoints: 8_500, pointsPerExtraSeat: 1,
    pointsPerPunctualityBasisPoint: 1, pointsPerAdditionalStop: 1,
    requirementFocusMaximumPoints: 1_000, contractBonusCentsPerPeriod: 1n,
    penaltyRates: { punctuality: 1n, cancellation: 1n, seats: 1n, connections: 1n },
    penaltyFocusMultiplierBasisPoints: 10_000, publicOperationSurchargeBasisPoints: 0,
    failedPackageFeeStepBasisPoints: 0, failedPackageReductionStepBasisPoints: 0,
  },
  tenderProfiles: [
    {
      id: "base", weights: { price: 5_000, quality: 5_000 }, requirementFocus: "capacity",
      penaltyFocus: "punctuality", viabilitySurchargeBasisPoints: 0,
    },
    {
      id: "alternative", weights: { price: 6_000, quality: 4_000 }, requirementFocus: "bicycle",
      penaltyFocus: "connections", viabilitySurchargeBasisPoints: 0,
    },
  ],
});

describe("persistenter M6-Weltzustand und Outbox", () => {
  let client: PGlite;
  let db: EconomyDatabase;

  beforeEach(async () => {
    client = new PGlite();
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
    await database.insert(worlds).values([
      { id: WORLD_ID, name: "M6", schedulePeriodWeeks: 3, epoch: new Date(0) },
      { id: OTHER_WORLD_ID, name: "M6-fremd", schedulePeriodWeeks: 3, epoch: new Date(0) },
    ]);
    db = database;
  });

  afterEach(async () => client.close());

  it("rekonstruiert BigInt/Map/Set und liefert Effekte nach Neustart genau einmal aus", async () => {
    const started = startEconomyWorld({
      worldId: WORLD_ID,
      seed: 42n,
      durationMonths: 6,
      release,
      lots: Array.from({ length: 8 }, (_, index) => ({ id: `lot-${index}`, size: 100 - index, attractiveness: index })),
      authorityBudgets: [{ authorityId: "a", period: 0, availableCents: 10n, committedCents: 0n }],
      accounts: ["account-1", "account-2"],
    });
    await persistEconomyTransition(db, { expectedRevision: null, ...started, committedAt: new Date(1_000) });

    const loaded = await loadEconomyWorldState(db, WORLD_ID);
    expect(loaded?.seed).toBe(42n);
    expect(loaded?.tenders).toBeInstanceOf(Map);
    expect(loaded?.processedCommands).toBeInstanceOf(Set);
    expect(await listPendingEconomyEffects(db, WORLD_ID)).toHaveLength(2);

    const sendNotice = vi.fn(async () => undefined);
    expect(await dispatchEconomyOutbox(db, WORLD_ID, { sendNotice, postJournal: vi.fn() }, new Date(2_000))).toBe(2);
    expect(sendNotice).toHaveBeenCalledTimes(2);
    expect(await dispatchEconomyOutbox(db, WORLD_ID, { sendNotice, postJournal: vi.fn() }, new Date(3_000))).toBe(0);

    const closed = closeEconomyWorld(loaded!, "close");
    await persistEconomyTransition(db, { expectedRevision: 0, state: closed, effects: { notices: [], journal: [] }, committedAt: new Date(4_000) });
    await expect(
      persistEconomyTransition(db, { expectedRevision: 0, state: closed, effects: { notices: [], journal: [] }, committedAt: new Date(5_000) }),
    ).rejects.toBeInstanceOf(EconomyStateConflictError);
  });

  it("rollt Zustand und Rust-Ereignisse bei verletzter Weltisolation gemeinsam zurueck", async () => {
    const started = startEconomyWorld({
      worldId: WORLD_ID,
      seed: 7n,
      durationMonths: 6,
      release,
      lots: Array.from({ length: 8 }, (_, index) => ({ id: `rollback-${index}`, size: 100 - index, attractiveness: index })),
      authorityBudgets: [],
      accounts: [],
    });
    await persistEconomyTransition(db, { expectedRevision: null, ...started, committedAt: new Date(0) });
    const closed = closeEconomyWorld(started.state, "close-with-foreign-event");
    await expect(persistEconomyTransition(db, {
      expectedRevision: 0,
      state: closed,
      effects: {
        notices: [],
        journal: [],
        runtimeEvents: [{
          eventId: "foreign:1",
          worldId: OTHER_WORLD_ID,
          eventType: "operating-transition-completed",
          atS: 1,
          payload: {},
        }],
      },
      committedAt: new Date(1_000),
    })).rejects.toThrow(/Weltisolation/);
    expect((await loadEconomyWorldState(db, WORLD_ID))?.revision).toBe(0);
  });

  it("quittiert keinen Outbox-Effekt, dessen Welt waehrend der Zustellung wechselt", async () => {
    await db.insert(economyOutbox).values({
      worldId: WORLD_ID,
      effectId: "isolation-notice",
      effectType: "notice",
      payload: { id: "isolation-notice", worldId: WORLD_ID, recipientAccountId: "account-1", type: "test", at: 0, payload: {} },
      occurredAt: new Date(0),
      enqueuedAt: new Date(0),
    });
    const [effect] = await listPendingEconomyEffects(db, WORLD_ID);
    expect(effect).toBeDefined();

    await expect(dispatchEconomyOutbox(db, WORLD_ID, {
      async sendNotice() {
        await db.update(economyOutbox).set({ worldId: OTHER_WORLD_ID }).where(and(
          eq(economyOutbox.worldId, WORLD_ID),
          eq(economyOutbox.id, effect!.id),
        ));
      },
      postJournal: async () => undefined,
    }, new Date(2_000))).rejects.toThrow(/gehoert beim Quittieren nicht mehr/);

    const [moved] = await db.select().from(economyOutbox).where(and(
      eq(economyOutbox.worldId, OTHER_WORLD_ID),
      eq(economyOutbox.id, effect!.id),
    ));
    expect(moved?.processedAt).toBeNull();
  });
});
