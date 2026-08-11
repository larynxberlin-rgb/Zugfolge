import {
  disruptionProviderApplications,
  regionalSimulationStates,
  type Database,
} from "@zugfolge/db";
import {
  materializeRestrictions,
  PROVIDER_SET_ID,
  PROVIDER_VISIBLE_HORIZON_MS,
  type MaterializedRestriction,
  type ProviderSnapshot,
} from "@zugfolge/disruption-provider";
import type { RegionalSimulationCommandPayload } from "@zugfolge/runtime-native";
import { and, eq } from "drizzle-orm";

import type { RegionalSimulationWorker } from "./regional-simulation-worker.js";
import { compareUtf8 } from "./utf8.js";

type RegisterPayload = Extract<RegionalSimulationCommandPayload, { readonly type: "register-disruption" }>;

export interface ProviderRegistration {
  readonly regionId: string;
  readonly disruption: RegisterPayload["disruption"];
}

interface StoredProviderRegistration extends ProviderRegistration {
  readonly snapshotHash: string;
}

export interface ProviderRegionalStateRow {
  readonly regionId: string;
  readonly state: unknown;
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function locationKey(value: string): string {
  return value.normalize("NFKD").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function trainsInState(stateValue: unknown): readonly Readonly<Record<string, unknown>>[] {
  const state = object(stateValue);
  const trains = state?.["initialTrains"];
  if (!Array.isArray(trains)) return [];
  return trains.map(object).filter((item): item is Readonly<Record<string, unknown>> => item !== undefined);
}

function effectDelaySeconds(effect: MaterializedRestriction["effect"]): number {
  switch (effect) {
    case "closure": return 900;
    case "route-deviation": return 600;
    case "vehicle-restriction": return 600;
    case "single-track": return 300;
    case "traffic-hold": return 180;
    case "speed-restriction": return 120;
  }
}

function affectedResource(restriction: MaterializedRestriction): string {
  const routes = restriction.location.routeNumbers.join("-") || "route-unknown";
  const points = restriction.location.operatingPointCodes.map(locationKey).filter(Boolean).join("-") || "points-unknown";
  return `track:${routes}:${points}`;
}

function registrationsForRestriction(
  rows: readonly ProviderRegionalStateRow[],
  restriction: MaterializedRestriction,
  epochMs: number,
): ProviderRegistration[] {
  const locationKeys = new Set([
    ...restriction.location.operatingPointCodes,
    ...restriction.location.operatingPointNames,
  ].map(locationKey).filter(Boolean));
  if (locationKeys.size === 0) return [];
  const startsAtS = Math.max(0, Math.floor((restriction.startsAtMs - epochMs) / 1_000));
  const validUntilS = Math.floor((restriction.endsAtMs - epochMs) / 1_000);
  if (validUntilS <= startsAtS) return [];
  const result: ProviderRegistration[] = [];
  for (const row of rows) {
    const affectedTrainRunIds: string[] = [];
    const positions: number[] = [];
    for (const train of trainsInState(row.state)) {
      if (typeof train["trainRunId"] !== "string" || !Array.isArray(train["route"])) continue;
      let affected = false;
      for (const waypointValue of train["route"]) {
        const waypoint = object(waypointValue);
        if (waypoint === undefined || typeof waypoint["operatingPoint"] !== "string") continue;
        if (!locationKeys.has(locationKey(waypoint["operatingPoint"]))) continue;
        affected = true;
        if (Number.isSafeInteger(waypoint["positionMm"]) && (waypoint["positionMm"] as number) >= 0) positions.push(waypoint["positionMm"] as number);
      }
      if (affected) affectedTrainRunIds.push(train["trainRunId"]);
    }
    if (affectedTrainRunIds.length === 0) continue;
    affectedTrainRunIds.sort(compareUtf8);
    result.push({
      regionId: row.regionId,
      disruption: {
        disruptionId: `provider:${restriction.id}`,
        kind: restriction.kind,
        publishedAtS: startsAtS,
        startsAtS,
        validUntilS,
        positionMm: positions.length === 0 ? 0 : Math.min(...positions),
        causeCode: restriction.causeCode,
        fineCauseId: restriction.fineCauseId,
        effect: restriction.effect,
        affectedResource: affectedResource(restriction),
        affectedTrainRunIds,
        delaySeconds: effectDelaySeconds(restriction.effect),
      },
    });
  }
  return result;
}

export function providerRegistrations(
  rows: readonly ProviderRegionalStateRow[],
  snapshot: Pick<ProviderSnapshot, "restrictions">,
  epoch: Date,
  now: Date,
): ProviderRegistration[] {
  const restrictions = materializeRestrictions(snapshot, now.getTime(), now.getTime() + PROVIDER_VISIBLE_HORIZON_MS);
  return restrictions.flatMap((restriction) => registrationsForRestriction(rows, restriction, epoch.getTime()))
    .sort((left, right) => compareUtf8(left.regionId, right.regionId) || compareUtf8(left.disruption.disruptionId, right.disruption.disruptionId));
}

function registrationKey(value: ProviderRegistration): string {
  return `${value.regionId}\u0000${value.disruption.disruptionId}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const input = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(input).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(",")}}`;
}

function sameRegistration(left: ProviderRegistration, right: ProviderRegistration): boolean {
  return canonicalJson(left.disruption) === canonicalJson(right.disruption);
}

function storedRegistration(row: Readonly<{
  regionId: string;
  disruptionId: string;
  snapshotHash: string;
  registration: unknown;
}>): StoredProviderRegistration {
  const registration = object(row.registration);
  if (registration?.["disruptionId"] !== row.disruptionId) {
    throw new TypeError(`Provider-Abgleichstand '${row.regionId}/${row.disruptionId}' ist inkonsistent.`);
  }
  return {
    regionId: row.regionId,
    snapshotHash: row.snapshotHash,
    disruption: registration as unknown as RegisterPayload["disruption"],
  };
}

export function createProviderDisruptionConsumer(
  db: Database,
  worker: RegionalSimulationWorker,
): (world: Readonly<{ worldId: string; epoch: Date }>, snapshot: ProviderSnapshot, now: Date) => Promise<void> {
  return async (world, snapshot, now) => {
    const rows = await db.select({ regionId: regionalSimulationStates.regionId, state: regionalSimulationStates.state })
      .from(regionalSimulationStates)
      .where(eq(regionalSimulationStates.worldId, world.worldId));
    if (rows.length === 0) return;
    const storedRows = await db.select({
      regionId: disruptionProviderApplications.regionId,
      disruptionId: disruptionProviderApplications.disruptionId,
      snapshotHash: disruptionProviderApplications.snapshotHash,
      registration: disruptionProviderApplications.registration,
    })
      .from(disruptionProviderApplications)
      .where(and(
        eq(disruptionProviderApplications.worldId, world.worldId),
        eq(disruptionProviderApplications.providerSetId, PROVIDER_SET_ID),
      ));
    const oldRegistrations = storedRows.map(storedRegistration);
    const newRegistrations = providerRegistrations(rows, snapshot, world.epoch, now);
    const oldByKey = new Map(oldRegistrations.map((item) => [registrationKey(item), item] as const));
    const newByKey = new Map(newRegistrations.map((item) => [registrationKey(item), item] as const));

    for (const [key, old] of oldByKey) {
      const current = newByKey.get(key);
      if (current !== undefined && sameRegistration(current, old)) continue;
      await worker.apply({
        worldId: world.worldId,
        regionId: old.regionId,
        commandId: `provider-clear:${old.snapshotHash}:${old.disruption.disruptionId}`,
        command: { type: "clear-disruption", disruptionId: old.disruption.disruptionId },
      }, now);
    }
    for (const [key, current] of newByKey) {
      const old = oldByKey.get(key);
      if (old !== undefined && sameRegistration(old, current)) continue;
      await worker.apply({
        worldId: world.worldId,
        regionId: current.regionId,
        commandId: `provider-register:${snapshot.snapshotHash}:${current.disruption.disruptionId}`,
        command: { type: "register-disruption", disruption: current.disruption },
      }, now);
    }
    await db.transaction(async (tx) => {
      await tx.delete(disruptionProviderApplications).where(and(
        eq(disruptionProviderApplications.worldId, world.worldId),
        eq(disruptionProviderApplications.providerSetId, PROVIDER_SET_ID),
      ));
      if (newRegistrations.length > 0) {
        await tx.insert(disruptionProviderApplications).values(newRegistrations.map((registration) => ({
          worldId: world.worldId,
          providerSetId: PROVIDER_SET_ID,
          regionId: registration.regionId,
          disruptionId: registration.disruption.disruptionId,
          snapshotHash: snapshot.snapshotHash,
          registration: registration.disruption,
          appliedAt: now,
        })));
      }
    });
  };
}
