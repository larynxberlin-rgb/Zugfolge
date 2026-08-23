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
import type { OperationalSimulationCommandPayload } from "@zugfolge/runtime-native";
import { and, eq } from "drizzle-orm";

import type { RegionalSimulationWorker } from "./regional-simulation-worker.js";
import { compareUtf8 } from "./utf8.js";

type ActivatePayload = Extract<OperationalSimulationCommandPayload, { readonly type: "activate-disruption" }>;

export interface ProviderRegistration {
  readonly regionId: string;
  readonly disruptionId: string;
  readonly effect: ActivatePayload["effect"];
}

interface StoredProviderRegistration extends Omit<ProviderRegistration, "effect"> {
  readonly snapshotHash: string;
  /** Fehlt nur bei einem v1-Altstand, der beim ersten v2-Abgleich sicher aufgehoben wird. */
  readonly effect?: ActivatePayload["effect"];
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

function objectValues(value: unknown, detail: string): readonly Readonly<Record<string, unknown>>[] {
  const values = Object.values(object(value) ?? {});
  if (values.some((item) => object(item) === undefined)) throw new TypeError(detail);
  return values as readonly Readonly<Record<string, unknown>>[];
}

function stringSet(value: unknown, detail: string): ReadonlySet<string> {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new TypeError(detail);
  }
  return new Set(value);
}

function identifierParts(value: string): ReadonlySet<string> {
  const normalized = value.normalize("NFKD").toUpperCase();
  return new Set([
    locationKey(value),
    ...normalized.split(/[^A-Z0-9]+/u).map(locationKey).filter(Boolean),
  ]);
}

function aliasesContain(aliases: readonly string[], key: string): boolean {
  return aliases.some((alias) => {
    const parts = identifierParts(alias);
    return parts.has(key) || (key.length > 3 && [...parts].some((part) => part.includes(key)));
  });
}

function locationMatches(
  restriction: MaterializedRestriction,
  aliases: readonly string[],
): boolean {
  const placeKeys = new Set([
    ...restriction.location.operatingPointCodes,
    ...restriction.location.operatingPointNames,
  ].map(locationKey).filter(Boolean));
  const routeKeys = new Set(restriction.location.routeNumbers.map(String));
  if (placeKeys.size === 0 && routeKeys.size === 0) return false;
  return (
    (placeKeys.size === 0 || [...placeKeys].some((key) => aliasesContain(aliases, key)))
    && (routeKeys.size === 0 || [...routeKeys].some((key) => aliasesContain(aliases, key)))
  );
}

type ResolvedResourceKind = "block" | "signal" | "switch";

interface ResolvedResource {
  readonly kind: ResolvedResourceKind;
  readonly resourceId: string;
}

function resolvedResources(
  stateValue: unknown,
  restriction: MaterializedRestriction,
): ResolvedResource[] {
  const state = object(stateValue);
  const world = object(state?.["world"]);
  const infra = object(world?.["infra"]);
  const trains = objectValues(
    world?.["trains"],
    "Operativer Provider-Abgleich besitzt keine gueltige Zugmenge.",
  );
  const routeVersions = object(infra?.["routeVersions"]);
  const interlockingRoutes = objectValues(
    infra?.["interlockingRoutes"],
    "Operativer Provider-Abgleich besitzt keine gueltigen Fahrstrassen.",
  );
  const platformIntervals = object(infra?.["platformIntervals"]);
  const blockResources = stringSet(
    infra?.["blockResources"],
    "Operativer Provider-Abgleich besitzt keine gueltigen Konfliktressourcen.",
  );
  const signals = stringSet(
    infra?.["signals"],
    "Operativer Provider-Abgleich besitzt keine gueltigen Signale.",
  );
  const switches = stringSet(
    infra?.["switches"],
    "Operativer Provider-Abgleich besitzt keine gueltigen Weichen.",
  );
  if (state === undefined || world === undefined || infra === undefined || routeVersions === undefined || platformIntervals === undefined) {
    throw new TypeError("Provider-Abgleich erwartet einen operativen v2-Zustand mit Welt und InfraRelease.");
  }

  const trainRouteIds = new Set<string>();
  for (const train of trains) {
    if (typeof train["routeVersionId"] !== "string" || train["routeVersionId"].length === 0) {
      throw new TypeError("Operativer Provider-Abgleich besitzt einen Zug ohne Laufwegversion.");
    }
    trainRouteIds.add(train["routeVersionId"]);
  }

  const result = new Map<string, ResolvedResource>();
  for (const routeId of [...trainRouteIds].sort(compareUtf8)) {
    const route = object(routeVersions[routeId]);
    if (route === undefined || typeof route["templateId"] !== "string" || !Array.isArray(route["legs"])) {
      throw new TypeError(`Provider-Abgleich kann Laufweg '${routeId}' nicht aus dem InfraRelease lesen.`);
    }
    const legs: Array<{
      readonly edgeId: string;
      readonly blockIds: readonly string[];
      readonly aliases: string[];
    }> = [];
    for (const legValue of route["legs"]) {
      const leg = object(legValue);
      if (
        leg === undefined
        || typeof leg["edgeId"] !== "string"
        || !Array.isArray(leg["blockIds"])
        || !leg["blockIds"].every((item) => typeof item === "string")
      ) {
        throw new TypeError(`Provider-Abgleich kann Laufweg '${routeId}' nicht auf Infra-Ressourcen abbilden.`);
      }
      const blockIds = leg["blockIds"] as string[];
      for (const blockId of blockIds) {
        if (!blockResources.has(blockId)) {
          throw new TypeError(`Provider-Abgleich fand unbekannte Konfliktressource '${blockId}'.`);
        }
      }
      legs.push({
        edgeId: leg["edgeId"],
        blockIds,
        aliases: [leg["edgeId"], ...blockIds],
      });
    }
    for (const [platformId, intervalValue] of Object.entries(platformIntervals)) {
      const interval = object(intervalValue);
      if (interval !== undefined && typeof interval["edgeId"] === "string") {
        for (const leg of legs) if (leg.edgeId === interval["edgeId"]) leg.aliases.push(platformId);
      }
    }
    const matchedLegs = legs.filter((leg) => locationMatches(restriction, leg.aliases));
    if (matchedLegs.length === 0) continue;

    if (restriction.fineCauseId === "signalling.signal") {
      for (const template of interlockingRoutes) {
        if (
          template["routeTemplateId"] === route["templateId"]
          && typeof template["signalId"] === "string"
          && signals.has(template["signalId"])
        ) {
          const resourceId = template["signalId"];
          result.set(`signal\u0000${resourceId}`, { kind: "signal", resourceId });
        }
      }
      continue;
    }
    if (restriction.fineCauseId === "switch.drive") {
      for (const template of interlockingRoutes) {
        if (template["routeTemplateId"] !== route["templateId"]) continue;
        const positions = object(template["switchPositions"]);
        if (positions === undefined) throw new TypeError("Provider-Abgleich fand ungueltige Weichenlagen.");
        for (const switchId of Object.keys(positions)) {
          if (!switches.has(switchId)) throw new TypeError(`Provider-Abgleich fand unbekannte Weiche '${switchId}'.`);
          result.set(`switch\u0000${switchId}`, { kind: "switch", resourceId: switchId });
        }
      }
      continue;
    }
    if (restriction.effect === "speed-restriction" || restriction.effect === "vehicle-restriction") {
      // Der Providervertrag liefert weder eine konkrete Vmax noch ein physisches Fahrzeug.
      // Ohne diese Angaben darf keine Wirkung erfunden werden.
      continue;
    }
    const matchedBlockIds = new Set(matchedLegs.flatMap((leg) => leg.blockIds));
    for (const resourceId of matchedBlockIds) {
      result.set(`block\u0000${resourceId}`, { kind: "block", resourceId });
    }
  }
  return [...result.values()].sort((left, right) =>
    compareUtf8(left.kind, right.kind) || compareUtf8(left.resourceId, right.resourceId));
}

function operationalEffect(
  restriction: MaterializedRestriction,
  target: ResolvedResource,
): ActivatePayload["effect"] {
  switch (target.kind) {
    case "signal": return { "signal-failed": { signalId: target.resourceId } };
    case "switch": return { "switch-failed": { switchId: target.resourceId } };
    case "block": return restriction.fineCauseId === "signalling.track-occupation"
      ? { "track-detection-failed": { resourceId: target.resourceId } }
      : { "resource-closed": { resourceId: target.resourceId } };
  }
}

function registrationsForRestriction(
  rows: readonly ProviderRegionalStateRow[],
  restriction: MaterializedRestriction,
): ProviderRegistration[] {
  const result: ProviderRegistration[] = [];
  for (const row of rows) {
    for (const target of resolvedResources(row.state, restriction)) {
      result.push({
        regionId: row.regionId,
        disruptionId: `provider:${restriction.id}:${target.kind}:${target.resourceId}`,
        effect: operationalEffect(restriction, target),
      });
    }
  }
  return result;
}

export function providerRegistrations(
  rows: readonly ProviderRegionalStateRow[],
  snapshot: Pick<ProviderSnapshot, "restrictions">,
  now: Date,
): ProviderRegistration[] {
  const restrictions = materializeRestrictions(snapshot, now.getTime(), now.getTime() + PROVIDER_VISIBLE_HORIZON_MS);
  return restrictions
    .filter((restriction) => restriction.startsAtMs <= now.getTime() && now.getTime() < restriction.endsAtMs)
    .flatMap((restriction) => registrationsForRestriction(rows, restriction))
    .sort((left, right) => compareUtf8(left.regionId, right.regionId) || compareUtf8(left.disruptionId, right.disruptionId));
}

function registrationKey(value: Readonly<{ regionId: string; disruptionId: string }>): string {
  return `${value.regionId}\u0000${value.disruptionId}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const input = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(input).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(",")}}`;
}

function sameRegistration(
  left: Readonly<{ effect?: ActivatePayload["effect"] }>,
  right: Readonly<{ effect?: ActivatePayload["effect"] }>,
): boolean {
  return left.effect !== undefined
    && right.effect !== undefined
    && canonicalJson(left.effect) === canonicalJson(right.effect);
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
    disruptionId: row.disruptionId,
    ...(object(registration["effect"]) === undefined
      ? {}
      : { effect: registration["effect"] as ActivatePayload["effect"] }),
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
    const newRegistrations = providerRegistrations(rows, snapshot, now);
    const oldByKey = new Map(oldRegistrations.map((item) => [registrationKey(item), item] as const));
    const newByKey = new Map(newRegistrations.map((item) => [registrationKey(item), item] as const));

    for (const [key, old] of oldByKey) {
      const current = newByKey.get(key);
      if (current !== undefined && sameRegistration(current, old)) continue;
      await worker.apply({
        worldId: world.worldId,
        regionId: old.regionId,
        commandId: `provider-clear:${old.snapshotHash}:${old.disruptionId}`,
        command: {
          type: "clear-disruption",
          disruptionId: old.disruptionId,
          releaseReference: `provider:${PROVIDER_SET_ID}:${snapshot.snapshotHash}`,
        },
      }, now);
    }
    for (const [key, current] of newByKey) {
      const old = oldByKey.get(key);
      if (old !== undefined && sameRegistration(old, current)) continue;
      await worker.apply({
        worldId: world.worldId,
        regionId: current.regionId,
        commandId: `provider-activate:${snapshot.snapshotHash}:${current.disruptionId}`,
        command: { type: "activate-disruption", disruptionId: current.disruptionId, effect: current.effect },
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
          disruptionId: registration.disruptionId,
          snapshotHash: snapshot.snapshotHash,
          registration,
          appliedAt: now,
        })));
      }
    });
  };
}
