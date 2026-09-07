import { describe, expect, it, vi } from "vitest";
import { GameApiClient } from "./api.js";

const hash = "a".repeat(64);
const passport = () => ({
  schemaVersion: "zugfolge-vehicle-register/v1", worldId: "world/1", vehicleId: "asset/1",
  authorityReleaseId: "fleet-v1", classDesignation: "442", ownerOperatorId: "public", holderOperatorId: "public",
  introducedAtS: 0, retiredAtS: 99999, dataAtS: 100, fleetRevision: 3, sourceStateHash: hash,
  facts: { source: { id: "asset/1", condition: { kilometresSinceMaintenance: 4000 } }, holding: { ownerOperatorId: "public", holderOperatorId: "public" }, bindings: {} },
  factsHash: hash, historyHash: hash,
});
const clientFor = (value: unknown) => new GameApiClient("", "token", async () => new Response(JSON.stringify(value)));

describe("Fahrzeugregister-Client", () => {
  it("übermittelt die ausdrücklich bestätigte Betriebsaufgabe mit unverändertem Wiederholungsschlüssel", async () => {
    const requests = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ schemaVersion: "zugfolge-operator-fleet-exit/v1", listings: [] })));
    const client = new GameApiClient("https://api.test", "token", requests);
    await client.exitOperatorFleet("world/1", "operator/1", { "asset/1": "175000000" }, "exit-once");
    expect(String(requests.mock.calls[0]![0])).toBe("https://api.test/worlds/world%2F1/operators/operator%2F1/fleet-exit");
    expect(requests.mock.calls[0]![1]?.method).toBe("POST");
    expect(JSON.parse(String(requests.mock.calls[0]![1]?.body))).toEqual({ salePrices: { "asset/1": "175000000" }, idempotencyKey: "exit-once" });
    await expect(clientFor({}).exitOperatorFleet("world", "operator", {}, "exit-once")).rejects.toThrow(/nicht bestätigt/);
  });

  it("ruft Pass, Suche und chronologische Folgeseiten ohne EVU-Bindung ab", async () => {
    const requests = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(
      String(url).includes("/history?") ? {
        schemaVersion: "zugfolge-vehicle-register-history-page/v1", worldId: "world/1", vehicleId: "asset/1", nextCursor: null,
        items: [{ id: "event-1", worldId: "world/1", vehicleId: "asset/1", fleetRevision: 3, atS: 100,
          eventType: "condition-updated", priorHistoryHash: hash, resultingHistoryHash: hash, sourceStateHash: hash, details: {} }],
      } : String(url).includes("vehicle-register?") ? {
        schemaVersion: "zugfolge-vehicle-register-page/v1", worldId: "world/1", items: [passport()], nextCursor: "asset/1",
      } : passport(),
    )));
    const client = new GameApiClient("https://api.test", "token", requests);
    expect((await client.loadVehicleRegistry("world/1", "BR 442", "prior/asset", 20)).items[0]?.vehicleId).toBe("asset/1");
    expect((await client.loadVehiclePassport("world/1", "asset/1")).ownerOperatorId).toBe("public");
    expect((await client.loadVehicleRegistryHistory("world/1", "asset/1", "2", 20)).items[0]?.fleetRevision).toBe(3);
    expect(requests.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.test/worlds/world%2F1/vehicle-register?limit=20&cursor=prior%2Fasset&query=BR+442",
      "https://api.test/worlds/world%2F1/vehicle-register/asset%2F1",
      "https://api.test/worlds/world%2F1/vehicle-register/asset%2F1/history?limit=20&cursor=2",
    ]);
  });

  it("verwirft fremde, ungebundene oder beschädigte Originalfakten", async () => {
    for (const broken of [
      { ...passport(), worldId: "foreign" }, { ...passport(), vehicleId: "other" },
      { ...passport(), schemaVersion: "zugfolge-vehicle-register/v2" }, { ...passport(), historyHash: "broken" },
      { ...passport(), dataAtS: -1 }, { ...passport(), facts: { source: { id: "other" }, holding: { assetId: "asset/1" }, bindings: {} } },
    ]) await expect(clientFor(broken).loadVehiclePassport("world/1", "asset/1")).rejects.toThrow();
  });

  it("übernimmt fehlenden Gesamt-km-Stand und Wert als unbekannt", async () => {
    const vehicle = { worldId: "world", vehicleId: "asset", classDesignation: "442", ownerOperatorId: "owner", holderOperatorId: "owner",
      odometerMetres: null, valueCents: null, conditionBasisPoints: null, conditionProfile: { mechanicsBasisPoints: 9000 },
      damages: [], maintenanceDeadlines: [], bindings: {}, revision: 1, historyHash: hash };
    expect((await clientFor([vehicle]).loadOwnedVehicles("world", "owner"))[0]).toMatchObject({ odometerMetres: null, valueCents: null, conditionBasisPoints: null });
  });
});
