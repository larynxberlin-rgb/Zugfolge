import { describe, expect, it, vi } from "vitest";
import {
  OPERATIONAL_DAY_MS as DAY,
  OPERATIONAL_DAILY_RESTRICTIONS_GENERATED_SCHEMA,
  type OperationalDailyRestrictionPolicy,
  type OperationalDailyRestrictionsRequest,
} from "@zugfolge/runtime-native";
import { DailyRestrictionCommandCatalog, type DailyRestrictionWorldSource } from "./daily-restriction-catalog.js";
import type { RegionalScheduledCommandCatalog } from "./regional-simulation-scheduler.js";

const source: DailyRestrictionWorldSource = {
  worldId: "world-a", regionId: "region-a", seed: "77", routeVersionIds: ["route-a"],
  infraRelease: { schemaVersion: "zugfolge-operational-infrastructure-binding/v2", infraReleaseId: "infra-a", file: "operational-infrastructure-v2.json", bytes: 100, sha256: "a".repeat(64), stateHash: "b".repeat(64) },
};
const policy: OperationalDailyRestrictionPolicy = {
  version: 1, plannedWorksMode: "SIMULATED", operationalIncidentMode: "SIMULATED", providerSetId: null,
  simulationProfile: { id: "explicit-test-profile/v1" }, rulesetVersion: "rules/v1", validFromMs: 0, validUntilMs: null,
};
const empty: RegionalScheduledCommandCatalog = { at: () => [], *dueBoundaries() {} };

function generated(input: OperationalDailyRestrictionsRequest) {
  return {
    schemaVersion: OPERATIONAL_DAILY_RESTRICTIONS_GENERATED_SCHEMA,
    worldId: input.worldId, regionId: input.regionId, dayStartMs: input.dayStartMs, policyVersion: input.policy.version,
    restrictions: [{ disruptionId: `la:${input.worldId}:${input.policy.version}:${input.dayStartMs}`, startsAtMs: input.dayStartMs, endsAtMs: input.dayStartMs + DAY + 500,
      effect: { "speed-restriction": { edgeId: "edge-a", maximumSpeedMmps: 5_555 } }, provenance: { kind: "simulated-daily-restriction", seed: input.seed } }],
    unsupportedRestrictions: [{ reason: "operational-scope-not-supported", effect: { type: "speed-restriction" }, scope: { traffic: "passenger", direction: "regular-direction" } }],
  } as const;
}

describe("produktiver La-Zeitkatalog", () => {
  it("diagnostiziert fehlende und MANUAL-Policies ohne Generatoraufruf oder Moduswechsel", async () => {
    let rows: readonly OperationalDailyRestrictionPolicy[] = [];
    const generate = vi.fn(generated);
    const catalog = new DailyRestrictionCommandCatalog({ base: empty, generate, loadPolicies: async () => rows });
    await catalog.refresh([source]);
    expect(catalog.at("world-a", "region-a", 0)).toEqual([]);
    expect(catalog.diagnostics("world-a")[0]?.status).toBe("missing-policy");
    rows = [{ ...policy, plannedWorksMode: "MANUAL", operationalIncidentMode: "MANUAL" }];
    await catalog.refresh([source]);
    expect(catalog.at("world-a", "region-a", 0)).toEqual([]);
    expect(catalog.diagnostics("world-a")[0]?.status).toBe("manual");
    expect(generate).not.toHaveBeenCalled();
  });

  it("liefert native Aktivierung und Ablauf bei Catch-up und Neustart identisch und weltisoliert", async () => {
    const generate = vi.fn(generated);
    const options = { base: empty, generate, loadPolicies: async () => [policy] };
    const first = new DailyRestrictionCommandCatalog(options);
    const restarted = new DailyRestrictionCommandCatalog(options);
    await first.refresh([source]); await restarted.refresh([source]);
    expect(first.at("world-a", "region-a", 0)[0]?.command.type).toBe("activate-disruption");
    const boundaries = [...first.dueBoundaries("world-a", "region-a", 0, 2 * DAY)];
    expect(boundaries.map((entry) => entry.atMs)).toEqual([DAY, DAY + 500, 2 * DAY]);
    expect(boundaries[1]?.commands[0]?.command.type).toBe("clear-disruption");
    expect([...restarted.dueBoundaries("world-a", "region-a", DAY, 2 * DAY)]).toEqual(boundaries.filter((entry) => entry.atMs > DAY));
    expect(first.at("foreign-world", "region-a", DAY)).toEqual([]);
    expect(generate.mock.calls.every(([input]) => input.worldId === source.worldId && input.seed === "77" && input.infraRelease === source.infraRelease)).toBe(true);
    expect(first.diagnostics("world-a")[0]?.status).toBe("partially-supported");
    expect(first.diagnostics("foreign-world")).toEqual([]);
    expect(boundaries.flatMap((entry) => entry.commands).every((command) => !command.commandId.includes("passenger"))).toBe(true);
  });

  it("wendet neue Policies erst ab ihrer Tagesgrenze an und belebt abgelaufene Vorgaenger nicht wieder", async () => {
    const generate = vi.fn(generated);
    const catalog = new DailyRestrictionCommandCatalog({ base: empty, generate, loadPolicies: async () => [policy, { ...policy, version: 2, validFromMs: DAY, validUntilMs: 2 * DAY }] });
    await catalog.refresh([source]);
    expect(catalog.at("world-a", "region-a", 0)[0]?.commandId).toContain("daily:1:");
    expect(catalog.at("world-a", "region-a", DAY)[0]?.commandId).toContain("daily:2:");
    expect(catalog.at("world-a", "region-a", 2 * DAY)).toEqual([]);
    expect(catalog.diagnostics("world-a")[0]?.status).toBe("missing-policy");
    expect(generate.mock.calls.map(([input]) => input.policy.version)).toEqual([1, 2]);
  });

  it("vereinigt La und Zugkommandos ohne doppelte oder unvollstaendige Zeitgrenze", async () => {
    const train = { commandId: "train:dispatch", atMs: DAY, command: { type: "dispatch" as const, requests: [] } };
    const base: RegionalScheduledCommandCatalog = { at: (_world, _region, at) => at === DAY ? [train] : [], *dueBoundaries(_world, _region, after, through) { if (after < DAY && through >= DAY) yield { atMs: DAY, commands: [train] }; } };
    const catalog = new DailyRestrictionCommandCatalog({ base, generate: generated, loadPolicies: async () => [policy] });
    await catalog.refresh([source]);
    const [boundary] = [...catalog.dueBoundaries("world-a", "region-a", DAY - 1, DAY)];
    expect(boundary?.commands.map((entry) => entry.command.type)).toEqual(["activate-disruption", "dispatch"]);
    expect(catalog.at("world-a", "region-a", DAY)).toEqual(boundary?.commands);
  });

  it("validiert den ersten expliziten Policyantrag nativ und entfernt archivierte Weltbindungen", async () => {
    const generate = vi.fn(generated);
    const catalog = new DailyRestrictionCommandCatalog({ base: empty, generate, loadPolicies: async () => [] });
    await catalog.refresh([source]);
    catalog.validatePolicy("world-a", { ...policy, validFromMs: DAY });
    expect(generate.mock.calls[0]?.[0].dayStartMs).toBe(DAY);
    expect(() => catalog.validatePolicy("world-a", { ...policy, validFromMs: 1 })).toThrow(/Tages-/u);
    expect(() => catalog.validatePolicy("foreign-world", policy)).toThrow(/Weltbindung/u);
    await catalog.refresh([]);
    expect(catalog.at("world-a", "region-a", DAY)).toEqual([]);
    expect(catalog.diagnostics("world-a")).toEqual([]);
  });
});
