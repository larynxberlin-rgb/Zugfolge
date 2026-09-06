import { PGlite } from "@electric-sql/pglite";
import { createOdooWebhookReceiptStore, processNextOdooCommand, receiveOdooWebhook, signPayload,
  type DemandDataUpdatePayload, type OdooWebhookEnvelope, type SigningKey } from "@zugfolge/commerce";
import { domainEvents, gameAdminRequests, MIGRATIONS_FOLDER, odooProjectionOutbox, regionalSimulationStates, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { LivemapRegistry, type LivemapReadModel } from "@zugfolge/livemap-stream";
import type { PlanningInfrastructureRelease } from "@zugfolge/planning-worker";
import { demandRuntimeFromAddon, loadDemandRuntime } from "@zugfolge/runtime-native";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { DemandService, type DemandDeployment } from "./demand-service.js";
import { DemandProgressConsumer } from "./demand-progress.js";
import { DEMAND_POPULATION_EVENT } from "./demand-population-data.js";
import { DemandStore, demandHash, demandList } from "./demand-store.js";
import { adaptOperationalDomainEvents } from "./operational-domain-event-adapter.js";

const WORLD = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const PIN = "a".repeat(64), NOW = new Date("2026-09-06T12:00:00Z");
const KEY: SigningKey = { id: "population-test", secret: "synthetic-odoo-data-test-signing-key", activeFrom: new Date(0) };

it.skipIf(process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] === undefined && process.env["ZUGFOLGE_DEMAND_TEST_BINARY"] === undefined)(
  "übernimmt direkt gespeicherte Odoo-Daten automatisch, ordnet sie vor Haltbelegen ein und restauriert begonnene Reisen",
  async () => {
    const binary = process.env["ZUGFOLGE_DEMAND_TEST_BINARY"];
    const runtime = binary === undefined ? loadDemandRuntime() : demandRuntimeFromAddon({ evaluatePassengerDemand(input) {
      const result = spawnSync(binary, [], { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout;
    } });
    const input = JSON.parse(readFileSync(new URL("../../../crates/zugfolge-demand/examples/population-evaluation.json", import.meta.url), "utf8"));
    input.worldId = WORLD;
    for (const service of input.services) service.worldId = WORLD;
    for (const alternative of input.alternatives) alternative.worldId = WORLD;
    const client = new PGlite(), db = drizzle(client, { schema });
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      await db.insert(worlds).values([WORLD, OTHER].map((id) => ({ id, name: "Odoo-Nachfragefixture", schedulePeriodWeeks: 3, epoch: new Date(0) })));
      const bindings = () => [{ worldId: WORLD, regionId: "region", initializationHash: PIN }];
      const state = (nowMs: number, sequence: number) => ({ world: { worldId: WORLD, regionId: "region", nowMs, eventSequence: sequence },
        commandReceipts: Object.fromEntries(Array.from({ length: sequence }, (_, index) => [`fixture:${index}`, { commandHash: PIN, appliedRevision: index + 1 }])) });
      await db.insert(regionalSimulationStates).values({ worldId: WORLD, regionId: "region", initializationHash: PIN,
        stateSchema: "zugfolge-operational-simulation-state/v2", state: state(0, 0), stateHash: PIN, revision: 0, publisherSequence: 0,
        createdAt: new Date(0), updatedAt: new Date(0) });
      async function region(nowMs: number, sequence = 0) {
        await db.update(regionalSimulationStates).set({ state: state(nowMs, sequence), revision: sequence, publisherSequence: sequence })
          .where(and(eq(regionalSimulationStates.worldId, WORLD), eq(regionalSimulationStates.regionId, "region")));
      }
      const livemap = new LivemapRegistry(); livemap.initializeWorld(WORLD, { at: 0, trains: [] });
      const infrastructure = { worldId: WORLD, releaseId: "infra", stations: input.release.zones.map((zone: any) => ({
        id: zone.stations[0].stationId, name: zone.id, latitudeE7: 510000000, longitudeE7: 120000000,
      })) } as PlanningInfrastructureRelease;
      const readModel = { async getConfig() { return { infrastructureReleaseId: "infra" }; }, async getScheduledCall() { return {}; } } as unknown as LivemapReadModel;
      const deployment: DemandDeployment = { schemaVersion: "zugfolge-demand-deployment/v1", worldId: WORLD, infrastructureReleaseId: "infra", windows: [input] };
      const deps = { db, runtime, deployment, deploymentHash: PIN, infrastructure: [infrastructure], livemap, readModel, operationalRegions: bindings };
      const service = new DemandService(deps);
      const run = () => new DemandProgressConsumer(db, runtime, bindings).advance(input, input.services, PIN, NOW, {});
      const initial = await run();
      function command(sourceRevision: number, factor: number): DemandDataUpdatePayload {
        const populationModel = structuredClone(input.release.populationModel);
        for (const settlement of populationModel.settlements) settlement.population *= factor;
        for (const area of populationModel.stationAreas) {
          for (const allocation of area.populationAllocations) allocation.population *= factor;
          area.demandClass = factor === 0 ? 0 : 1;
        }
        return { kind: "demand.data.update", schemaVersion: "zugfolge-demand-data-update/v1", worldId: WORLD,
          sourceRevision, baseReleaseId: input.release.id, populationModel,
          zonePopulations: input.release.zones.map((zone: any) => ({ zoneId: zone.id, population: zone.population * factor })) };
      }
      async function save(payload: DemandDataUpdatePayload, suffix = String(payload.sourceRevision)) {
        const envelope: OdooWebhookEnvelope = { schemaVersion: "zugfolge-odoo/v1", eventId: `population-event-${suffix}`,
          eventType: "commerce.command", occurredAt: NOW.toISOString(), correlationId: `population-correlation-${suffix}`,
          tenantId: "test", actorReference: "odoo-data-editor", command: payload };
        await receiveOdooWebhook(createOdooWebhookReceiptStore(db), signPayload(envelope, KEY, NOW), {
          tenantId: "test", keys: [KEY], authorizedActors: { "odoo-data-editor": ["demand.data.update"] },
          assertWorldScope(worldId) { if (worldId !== WORLD) throw new Error("foreign world"); },
        }, NOW);
        return processNextOdooCommand(db, NOW, { demandDataHandler: ({ payload, db: tx, now }) => service.updateData(payload, tx, now) });
      }
      await region(150000);
      expect(await save(command(1, 2))).toMatchObject({ outcome: "accepted" });
      expect(await db.select().from(gameAdminRequests)).toHaveLength(0);
      const updates = () => db.select().from(domainEvents).where(and(eq(domainEvents.worldId, WORLD), eq(domainEvents.eventType, DEMAND_POPULATION_EVENT)));
      expect(await updates()).toHaveLength(1);
      await region(150001);
      const corrected = await run();
      expect(corrected.result["releaseHash"]).toBe(initial.result["releaseHash"]);
      expect(corrected.result["populationRevision"]).toMatchObject({ revision: 1, effectiveAtMs: 150000 });
      const historical = demandList(initial.result["cohorts"]).filter((cohort) => Number(cohort["desiredDepartureMs"]) <= 150000);
      expect(historical.length).toBeGreaterThan(0);
      for (const cohort of historical) expect(demandList(corrected.result["cohorts"])).toContainEqual(cohort);
      expect(demandHash(corrected.result["cohorts"])).not.toBe(demandHash(initial.result["cohorts"]));

      const train = input.services[0];
      const receipt = { schemaVersion: "zugfolge-operational-passenger-stop-receipt/v1", worldId: WORLD,
        serviceRunId: "test-service", trainRunId: train.trainRunId, stopId: train.stops[0].stopId, stopSequence: 0,
        stopPlanHash: PIN, routeVersionId: "test-route", formationVersionId: "test-formation", kind: "departure",
        actualTimeMs: train.stops[0].departureMs, receiptId: "test-population-departure" };
      const [event] = adaptOperationalDomainEvents([{ kind: "passenger-stop-departure", atMs: receipt.actualTimeMs,
        subjectId: train.trainRunId, detail: JSON.stringify(receipt), eventSequence: 1, commitSequence: 1 }], [], [], "region", WORLD);
      const sequences = await db.select({ sequence: domainEvents.sequence }).from(domainEvents).where(eq(domainEvents.worldId, WORLD));
      await db.insert(domainEvents).values({ worldId: WORLD, sequence: Math.max(...sequences.map((row) => row.sequence)) + 1,
        eventType: event!.eventType, payload: event!.payload, occurredAt: NOW });
      await region(receipt.actualTimeMs + 1, 1);
      const begun = await run();
      const manifest = demandList(begun.result["manifests"]).find((row) => row["trainRunId"] === train.trainRunId)!;
      expect(demandList(manifest["passengers"]).length).toBeGreaterThan(0);
      await region(700000, 1);
      expect(await save(command(2, 0))).toMatchObject({ outcome: "accepted" });
      await region(700001, 1);
      const after = await run();
      expect(demandList(after.result["manifests"]).find((row) => row["segmentId"] === manifest["segmentId"])?.["passengers"]).toEqual(manifest["passengers"]);
      expect(await new DemandStore(db, runtime).latest(WORLD, PIN)).toEqual(after);
      expect(await run()).toEqual(after);
      const restarted = new DemandService(deps); await restarted.refresh(700001, NOW);
      const overview = await restarted.overview(WORLD);
      expect(overview.populationBasis?.dataRevision).toBe(2);
      expect(overview.items.every((station) => station.populationDemand?.catchmentPopulation === 0)).toBe(true);
      expect(await save(command(2, 0), "2-retry")).toMatchObject({ outcome: "accepted" });
      expect(await updates()).toHaveLength(2);
      expect(await save(command(2, 1), "conflicting")).toMatchObject({ outcome: "rejected" });
      const invalid = command(3, 1); (invalid.populationModel as any).stationAreas[0].stationId = "foreign-station";
      expect(await save(invalid)).toMatchObject({ outcome: "rejected" });
      expect(await updates()).toHaveLength(2);
      expect(await new DemandStore(db, runtime).latest(OTHER)).toBeUndefined();
      const results = await db.select().from(odooProjectionOutbox).where(eq(odooProjectionOutbox.worldId, WORLD));
      expect(results.some((row) => row.messageType === "demand.data.result" && (row.payload as any).sourceRevision === 2)).toBe(true);
      expect(JSON.stringify(overview)).not.toMatch(/passengerKey|fareFact|commandHash|snapshotHash/);
    } finally { await client.close(); }
  }, 60000);
