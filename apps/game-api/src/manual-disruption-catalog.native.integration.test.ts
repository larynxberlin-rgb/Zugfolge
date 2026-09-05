import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createOdooWebhookReceiptStore, processNextOdooCommand, receiveOdooWebhook, signPayload, type OdooWebhookEnvelope } from "@zugfolge/commerce";
import { domainEvents, MIGRATIONS_FOLDER, odooProjectionOutbox, regionalSimulationCommandReceipts, regionalSimulationStates, worlds, type Database } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { OperationsRegistry } from "@zugfolge/dispatch";
import { LivemapRegistry } from "@zugfolge/livemap-stream";
import { loadOperationalSimulationRuntime, OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV, OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY, OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA, type OperationalSimulationState } from "@zugfolge/runtime-native";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createManualDisruptionAdminHandler, type ManualDisruptionAdminContext } from "./manual-disruption-admin.js";
import { ManualDisruptionCommandCatalog } from "./manual-disruption-catalog.js";
import { advanceRegionalSimulations } from "./regional-simulation-scheduler.js";
import { RegionalSimulationWorker } from "./regional-simulation-worker.js";
import { TEST_INFRASTRUCTURE_BINDING } from "./operational-infrastructure.fixture.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const REGION = "manual-native";
const EPOCH = new Date("2026-08-11T00:00:00.000Z");
const at = (milliseconds: number) => new Date(EPOCH.getTime() + milliseconds);
const nativeAvailable = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] !== undefined;

function context(id: string, startsAtMs = 1_000, endsAtMs = 4_000, nowMs = 0): ManualDisruptionAdminContext {
  return { effectIdempotencyKey: id, commandId: id, eventId: `event:${id}`, correlationId: `correlation:${id}`,
    receivedAt: at(nowMs), now: at(nowMs), payload: {
      kind: "admin.manual_disruption_create", worldId: WORLD, actionType: "manual_disruption_create", riskClass: "high",
      requesterReference: "requester", approverReference: "approver", reason: "Freigegebene zeitlich begrenzte Sperre",
      manualDisruption: { startsAt: at(startsAtMs).toISOString(), endsAt: at(endsAtMs).toISOString(), cause: "Betrieblicher Eingriff",
        affectedResourceIds: ["test-track-west"], declaredEffect: { schemaVersion: "zugfolge-manual-disruption-effect/v1",
          kind: "closure", causeCode: 26, fineCauseId: "track.inspection", targets: [{ resourceId: "test-track-west", regionId: REGION }] } },
    } };
}

(nativeAvailable ? describe : describe.skip)("Manuelle Stoerungen mit echter nativer Runtime und persistenter Queue", () => {
  let client: PGlite;
  let db: Database;
  let runtime: ReturnType<typeof loadOperationalSimulationRuntime>;
  let worker: RegionalSimulationWorker;
  let catalog: ManualDisruptionCommandCatalog;
  let initializationHash: string;
  const createCatalog = () => new ManualDisruptionCommandCatalog({ db, runtime,
    base: { at: () => [], *dueBoundaries() {} },
    regions: () => [{ worldId: WORLD, regionId: REGION, initializationHash, nowMs: worker.readyRegions()[0]?.nowMs ?? 0 }],
  });
  const handler = (input: ManualDisruptionAdminContext) => createManualDisruptionAdminHandler({ schedule: (request) => catalog.schedule(request) })(input);
  const advance = (milliseconds: number) => catalog.exclusive(async () => {
    await catalog.refresh();
    return advanceRegionalSimulations(worker, [{ worldId: WORLD, regionId: REGION, initializationHash }], new Map([[WORLD, EPOCH]]), at(milliseconds), catalog);
  });
  const state = async () => {
    const [row] = await db.select().from(regionalSimulationStates).where(eq(regionalSimulationStates.worldId, WORLD));
    return row!.state as OperationalSimulationState & { world: { activeDisruptions: Record<string, unknown> } };
  };
  beforeEach(async () => {
    vi.stubEnv(OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV, JSON.stringify({ [TEST_INFRASTRUCTURE_BINDING.infraReleaseId]:
      fileURLToPath(new URL("../test-infrastructure/operations-v1/", import.meta.url)) }));
    client = new PGlite();
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
    db = database as unknown as Database;
    await db.insert(worlds).values({ id: WORLD, name: "Manuelle Stoerungsabnahme", epoch: EPOCH, schedulePeriodWeeks: 4 });
    runtime = loadOperationalSimulationRuntime();
    worker = new RegionalSimulationWorker(db, runtime, new LivemapRegistry(), new OperationsRegistry());
    const initialized = await worker.initialize({ schemaVersion: OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA, worldId: WORLD, regionId: REGION,
      nowMs: 0, repeatEveryMs: null, protectionModeSelectionPolicy: OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
      infraRelease: TEST_INFRASTRUCTURE_BINDING, vehicleTypes: [], vehicles: [], formations: [], trains: [], movementContinuations: [] }, EPOCH);
    initializationHash = initialized.initializationHash;
    catalog = createCatalog();
  });
  afterEach(async () => { vi.unstubAllEnvs(); await client.close(); });

  it("verknuepft den signierten Odoo-Auftrag mit einem echten Zeitplan und bestaetigt erst dessen Speicherung", async () => {
    const key = { id: "manual-e2e", secret: "manual-e2e-secret", activeFrom: new Date(0) };
    const input = context("transport");
    const envelope: OdooWebhookEnvelope = { schemaVersion: "zugfolge-odoo/v1", eventId: "manual-native-event-0001", eventType: "commerce.command",
      occurredAt: EPOCH.toISOString(), correlationId: "manual-native-correlation-0001", tenantId: "manual-native", actorReference: "odoo-admin",
      command: { ...input.payload, kind: "admin.manual_disruption_create", actionType: "manual_disruption_create", riskClass: "high", effectPreview: {} } };
    const options = { tenantId: "manual-native", keys: [key], authorizedActors: { "odoo-admin": ["admin.manual_disruption_create"] } };
    const signed = signPayload(envelope, key, EPOCH);
    const store = createOdooWebhookReceiptStore(db);
    expect(await receiveOdooWebhook(store, signed, options, EPOCH)).toMatchObject({ accepted: true, duplicate: false });
    expect(await receiveOdooWebhook(store, signed, options, EPOCH)).toMatchObject({ accepted: true, duplicate: true });
    expect(await processNextOdooCommand(db, EPOCH, { claimClock: () => EPOCH, adminHandlers: { manual_disruption_create: handler } })).toMatchObject({ outcome: "accepted" });
    const [projection] = await db.select().from(odooProjectionOutbox).where(eq(odooProjectionOutbox.worldId, WORLD));
    expect(projection?.payload).toMatchObject({ outcome: "accepted", manualDisruptionStatus: "scheduled", effectiveStartsAtMs: 1_000, endsAtMs: 4_000 });
    expect((await state()).world.activeDisruptions).toEqual({});
    await advance(1_000);
    expect(Object.values((await state()).world.activeDisruptions)).toEqual([{ "resource-closed": { resourceId: "test-track-west" } }]);
    await advance(4_000);
    expect((await state()).world.activeDisruptions).toEqual({});
    expect(await db.select().from(domainEvents).where(eq(domainEvents.eventType, "disruption.manual-scheduled"))).toHaveLength(1);
  });

  it("aktiviert erst zum Beginn, ueberlebt zwei Neustarts und hebt nur die abgelaufene von zwei ueberlappenden Sperren auf", async () => {
    const original = context("first");
    const first = await handler(original);
    await handler(context("second", 2_000, 5_000));
    expect(first.result).toMatchObject({ manualDisruptionStatus: "scheduled", effectiveStartsAtMs: 1_000, endsAtMs: 4_000 });
    expect((await state()).world.activeDisruptions).toEqual({});
    await advance(999);
    expect((await state()).world.activeDisruptions).toEqual({});
    worker = new RegionalSimulationWorker(db, runtime, new LivemapRegistry(), new OperationsRegistry());
    catalog = createCatalog();
    await advance(1_000);
    expect(Object.keys((await state()).world.activeDisruptions)).toEqual(["manual:first:0"]);
    await advance(2_000);
    expect(Object.keys((await state()).world.activeDisruptions)).toHaveLength(2);
    worker = new RegionalSimulationWorker(db, runtime, new LivemapRegistry(), new OperationsRegistry());
    catalog = createCatalog();
    await advance(4_000);
    expect(Object.keys((await state()).world.activeDisruptions)).toEqual(["manual:second:0"]);
    await advance(5_000);
    expect((await state()).world.activeDisruptions).toEqual({});
    // Verlorene Transportquittung nach Ablauf darf keinen neuen Zeitplan erzeugen.
    await expect(handler({ ...original, commandId: "retry-transport", now: at(6_000) })).resolves.toEqual(first);
    const events = await db.select().from(domainEvents).where(eq(domainEvents.eventType, "disruption.manual-scheduled"));
    expect(events).toHaveLength(2);
    const receipts = await db.select().from(regionalSimulationCommandReceipts);
    expect(receipts.filter((receipt) => receipt.commandId.startsWith("manual:")).map((receipt) => receipt.commandId).sort()).toEqual([
      "manual:first:0:activate", "manual:first:0:clear", "manual:second:0:activate", "manual:second:0:clear",
    ]);
  });

  it("lehnt unbekannte native Ziele und abgelaufene Erstzustellungen ohne Teilwirkung ab", async () => {
    const input = context("unknown");
    const manual = input.payload.manualDisruption!;
    const before = await state();
    await expect(handler({ ...input, payload: { ...input.payload, manualDisruption: { ...manual,
      affectedResourceIds: ["test-track-west", "missing-resource"], declaredEffect: { ...manual.declaredEffect,
        targets: [{ resourceId: "test-track-west", regionId: REGION }, { resourceId: "missing-resource", regionId: REGION }] } } } })).rejects.toThrow();
    await expect(handler(context("expired", 1_000, 2_000, 2_000))).rejects.toMatchObject({ code: "time" });
    expect(await state()).toEqual(before);
    expect(await db.select().from(domainEvents).where(eq(domainEvents.eventType, "disruption.manual-scheduled"))).toEqual([]);
  });

  it("begrenzt verspaetete Zustellung am aktuellen Single-Writer-Kopf und fuehrt die numerische La exakt aus", async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const cycle = catalog.exclusive(async () => {
      enter(); await released;
      return advanceRegionalSimulations(worker, [{ worldId: WORLD, regionId: REGION, initializationHash }], new Map([[WORLD, EPOCH]]), at(2_000), catalog);
    });
    await entered;
    const original = context("late-speed");
    const scheduled = handler({ ...original, payload: { ...original.payload, manualDisruption: { ...original.payload.manualDisruption!,
      affectedResourceIds: ["test-edge-west"], declaredEffect: { schemaVersion: "zugfolge-manual-disruption-effect/v1", kind: "speed-restriction",
        causeCode: 26, fineCauseId: "track.inspection", targets: [{ resourceId: "test-edge-west", regionId: REGION, maximumSpeedMmps: 5_555 }] } } } });
    release(); await cycle;
    expect((await scheduled).result).toMatchObject({ effectiveStartsAtMs: 2_000, endsAtMs: 4_000 });
    await advance(2_000);
    expect((await state()).world.activeDisruptions).toEqual({ "manual:late-speed:0": { "speed-restriction": { edgeId: "test-edge-west", maximumSpeedMmps: 5_555 } } });
    await advance(4_000);
    expect((await state()).world.activeDisruptions).toEqual({});
  });
});
