import { describe, expect, it, vi } from "vitest";

import type { ProviderSnapshot } from "@zugfolge/disruption-provider";
import { PROVIDER_SET_ID, PROVIDER_SNAPSHOT_SCHEMA } from "@zugfolge/disruption-provider";
import {
  createDisruptionProviderHealthCheck,
  DisruptionProviderMonitor,
  runDisruptionProviderCycle,
  type DisruptionProviderStore,
} from "./disruption-provider-scheduler.js";

const snapshot: ProviderSnapshot = {
  schemaVersion: PROVIDER_SNAPSHOT_SCHEMA,
  providerSetId: PROVIDER_SET_ID,
  fetchedAt: "2026-08-11T15:00:00.000Z",
  revision: 7,
  sourceVersion: "2.28.0",
  sourceDataTimestamps: { planned: "2026-08-07T15:23:59", unplanned: "2026-08-11T16:34:25" },
  snapshotHash: "a".repeat(64),
  raw: { handshake: {}, plannedWorks: [], operationalIncidents: [], scheduledTrafficPauses: [] },
  restrictions: [],
  discarded: [],
};

function store(): DisruptionProviderStore & { persistSuccess: ReturnType<typeof vi.fn>; persistFailure: ReturnType<typeof vi.fn> } {
  return {
    enabledWorlds: async () => [{ worldId: "11111111-1111-4111-8111-111111111111", epoch: new Date("2026-01-01T00:00:00Z") }],
    persistSuccess: vi.fn(async () => undefined),
    persistFailure: vi.fn(async () => undefined),
  };
}

describe("30-Minuten-Providerlauf", () => {
  it("archiviert einen Snapshot je freigegebener Welt", async () => {
    const repository = store();
    const monitor = new DisruptionProviderMonitor(Date.parse("2026-08-11T14:59:00Z"));
    const result = await runDisruptionProviderCycle({ fetchSnapshot: async () => snapshot }, repository, monitor, new Date(snapshot.fetchedAt));
    expect(result).toEqual({ worlds: 1, fetched: true });
    expect(repository.persistSuccess).toHaveBeenCalledWith(expect.objectContaining({ worldId: expect.any(String) }), snapshot, new Date(snapshot.fetchedAt));
    expect(await createDisruptionProviderHealthCheck(monitor, () => Date.parse("2026-08-11T15:30:00Z")).check()).toMatchObject({ status: "ok", code: "provider_current" });
  });

  it("behält nach Ausfall den letzten sicheren Stand und meldet degraded", async () => {
    const repository = store();
    const monitor = new DisruptionProviderMonitor(Date.parse("2026-08-11T14:00:00Z"));
    await runDisruptionProviderCycle({ fetchSnapshot: async () => snapshot }, repository, monitor, new Date(snapshot.fetchedAt));
    await expect(runDisruptionProviderCycle({ fetchSnapshot: async () => { throw new Error("HTTP 503"); } }, repository, monitor, new Date("2026-08-11T15:30:00Z"))).rejects.toThrow("HTTP 503");
    expect(repository.persistFailure).toHaveBeenCalled();
    expect(await createDisruptionProviderHealthCheck(monitor, () => Date.parse("2026-08-11T15:31:00Z")).check()).toMatchObject({ status: "degraded", code: "provider_last_safe" });
  });
});
