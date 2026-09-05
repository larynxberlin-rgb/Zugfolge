import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { LivemapRegistry, type LivemapReadModel } from "@zugfolge/livemap-stream";
import type { DemandRuntime } from "@zugfolge/runtime-native";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemandService, type DemandDeployment } from "./demand-service.js";
import { demandHash, demandList } from "./demand-store.js";
import { loadCommittedSpfvServices } from "./spfv-demand-projection.js";

vi.mock("./spfv-demand-projection.js", () => ({ loadCommittedSpfvServices: vi.fn() }));

const WORLD = "81111111-1111-4111-8111-111111111111";
const OPERATOR = "8aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// Explicit transport fixture: this suite proves selection and real journal
// restore. Native capacity and reservation authority have separate integration tests.
const runtime: DemandRuntime = { evaluate(input) { return { ...input, stateHash: demandHash(input) }; } };
const provenance = { kind: "forecast" as const, planningRevision: null, planningStateHash: null, referenceTrainIds: [] };

function pool(periodId: string, windowStartMs: number, windowEndMs: number) {
  return { schemaVersion: "zugfolge-demand-evaluation/v1", worldId: WORLD, periodId,
    windowStartMs, windowEndMs, daySliceId: "day", nowMs: 0, revision: 1, seed: "42", release: {}, alternatives: [],
    services: [{ worldId: WORLD, trainRunId: `${periodId}-base`, operatorId: OPERATOR, mode: "spnv", cancelled: false,
      stops: [{ stopId: "a", stationId: "a", passengerStop: true, arrivalMs: windowStartMs + 1000, departureMs: windowStartMs + 1000 },
        { stopId: "b", stationId: "b", passengerStop: true, arrivalMs: windowEndMs, departureMs: windowEndMs }] }] };
}
const windows = [pool("p1", 0, 10_000), pool("p2", 10_000, 30_000)];
const deployment: DemandDeployment = { schemaVersion: "zugfolge-demand-deployment/v1", worldId: WORLD,
  infrastructureReleaseId: "infra", windows };
const readModel = { async getConfig() { return { infrastructureReleaseId: "infra" }; },
  async getScheduledCall() { return { trainId: "explicit-schedule-fixture" }; } } as unknown as LivemapReadModel;

describe("Nachfragehorizont bleibt an wirksame Fahrten und die bisherige Periode gebunden", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  beforeEach(async () => {
    client = new PGlite(); db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({ id: WORLD, name: "Horizontprüfung", schedulePeriodWeeks: 3, epoch: new Date(0) });
    vi.mocked(loadCommittedSpfvServices).mockReset().mockResolvedValue({ services: [], provenance });
  }, 30_000);
  afterEach(async () => { await client.close(); });

  function registry(delaySeconds?: number) {
    const result = new LivemapRegistry();
    result.initializeWorld(WORLD, { at: 0, trains: delaySeconds === undefined ? [] : [{
      id: "p1-base", operatorId: OPERATOR, operator: "Test", trainNumber: "1", category: "spnv",
      positionMm: 0, speedMmPerSecond: 0, delaySeconds, status: "running",
    }] });
    return result;
  }
  function service(livemap: LivemapRegistry) {
    return new DemandService({ db, runtime, deployment, deploymentHash: "pin", readModel, livemap, infrastructure: [] });
  }

  it("erkennt Liveverspätung schon beim Kaltstart und bewahrt sie nach Snapshotentfernung und Restore", async () => {
    const live = registry(10), first = service(live);
    await first.refresh(11_000, new Date(11_000));
    expect((await first.checkpoint(WORLD)).input["periodId"]).toBe("p1");
    live.publishRegionDelta(WORLD, "__single_region__", { at: 12, changed: [], removed: ["p1-base"] });
    const restored = service(live);
    await restored.refresh(19_999, new Date(19_999));
    const retained = await restored.checkpoint(WORLD);
    expect(retained.input["periodId"]).toBe("p1");
    expect(retained.input["revision"]).toBe(1);
    expect(demandList(demandList(retained.input["services"])[0]!["stops"])[1]!["departureMs"]).toBe(20_000);
    await restored.refresh(20_000, new Date(20_000));
    expect((await restored.checkpoint(WORLD)).input).toMatchObject({ periodId: "p2", revision: 2 });
    // The persisted period fence also survives another restart; older releases
    // are not reopened by late retrospective changes to a removed old train.
    vi.mocked(loadCommittedSpfvServices).mockClear();
    await service(live).refresh(21_000, new Date(21_000));
    expect(vi.mocked(loadCommittedSpfvServices).mock.calls.map((call) => call[3]?.windowStartMs)).toEqual([10_000]);
  });

  it.each([false, true])("berücksichtigt neu bestätigten SPFV vor der Poolwahl (vorheriger Checkpoint: %s)", async (hasCheckpoint) => {
    const live = registry(), first = service(live);
    if (hasCheckpoint) await first.refresh(5_000, new Date(5_000));
    const accepted = { ...windows[0]!.services[0]!, trainRunId: "accepted-spfv", mode: "spfv",
      stops: [{ stopId: "start", stationId: "a", passengerStop: true, arrivalMs: 9_000, departureMs: 9_000 },
        { stopId: "end", stationId: "b", passengerStop: true, arrivalMs: 20_000, departureMs: 20_000 }] };
    vi.mocked(loadCommittedSpfvServices).mockImplementation(async (_db, _world, _base, window) => ({
      services: window?.windowStartMs === 0 ? [accepted] : [], provenance,
    }));
    const restored = service(live);
    await restored.refresh(11_000, new Date(11_000));
    const checkpoint = await restored.checkpoint(WORLD);
    expect(checkpoint.input["periodId"]).toBe("p1");
    expect(demandList(checkpoint.input["services"]).map((row) => row["trainRunId"])).toContain("accepted-spfv");
    await restored.refresh(20_000, new Date(20_000));
    expect((await restored.checkpoint(WORLD)).input["periodId"]).toBe("p2");
    expect(vi.mocked(loadCommittedSpfvServices).mock.calls.every((call) => call[3] !== undefined)).toBe(true);
  });

  it("verweigert inkompatible statische Periodenüberlappung weiterhin vor Betriebsbeginn", () => {
    const conflicting = pool("p1", 0, 10_000);
    conflicting.services[0]!.stops[1]!.departureMs = 11_000;
    expect(() => new DemandService({ db, runtime, deployment: { ...deployment, windows: [conflicting, windows[1]!] },
      deploymentHash: "pin", readModel, livemap: registry(), infrastructure: [] })).toThrow("Periodenwechsel");
  });
});
