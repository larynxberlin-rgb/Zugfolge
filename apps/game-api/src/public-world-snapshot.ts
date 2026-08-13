import {
  ACTIVITY_EVENT_TYPES,
  calculateStrongActivity,
  effectiveActivityPolicy,
  effectiveStartingCapitalPolicy,
  type AlphaWorldBlueprint,
  type ActivityEvent,
} from "@zugfolge/alpha";
import {
  PUBLIC_WORLD_SNAPSHOT_VERSION,
  validatePublicWorldSnapshot,
  type PublicWorldSnapshotV1,
} from "@zugfolge/commerce";
import {
  alphaWorldProfiles,
  domainEvents,
  operators,
  worldParticipations,
  worlds,
} from "@zugfolge/db";
import { decodeEconomyValue, serializeStartingCapitalPolicy } from "@zugfolge/economy";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type SnapshotDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;

export class PublicWorldSnapshotUnavailableError extends Error {
  constructor(readonly code: "not_found" | "legacy_blueprint" | "not_public") {
    super(`Oeffentlicher Weltsnapshot ist nicht verfuegbar: ${code}.`);
    this.name = "PublicWorldSnapshotUnavailableError";
  }
}

function payloadOperatorId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)["operatorId"];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export async function buildPublicWorldSnapshot(
  db: SnapshotDatabase,
  input: { readonly worldId: string; readonly authoritativeNowS: number; readonly generatedAt: Date },
): Promise<PublicWorldSnapshotV1> {
  if (!Number.isSafeInteger(input.authoritativeNowS) || input.authoritativeNowS < 0) {
    throw new RangeError("Autoritative Weltzeit ist ungueltig.");
  }
  const [profile] = await db.select({
    blueprint: alphaWorldProfiles.blueprint,
    profileKind: alphaWorldProfiles.profileKind,
    epoch: worlds.epoch,
    worldName: worlds.name,
  }).from(alphaWorldProfiles).innerJoin(worlds, eq(worlds.id, alphaWorldProfiles.worldId))
    .where(eq(alphaWorldProfiles.worldId, input.worldId)).limit(1);
  if (profile === undefined) throw new PublicWorldSnapshotUnavailableError("not_found");
  if (profile.profileKind !== "public") throw new PublicWorldSnapshotUnavailableError("not_public");
  const blueprint = decodeEconomyValue(profile.blueprint) as AlphaWorldBlueprint;
  if (blueprint.schemaVersion !== "zugfolge-alpha-world-blueprint/v2" || blueprint.publicMetadata === undefined || blueprint.admission === undefined) {
    throw new PublicWorldSnapshotUnavailableError("legacy_blueprint");
  }

  const operatorRows = await db.select({
    operatorId: operators.id, kind: operators.operatorKind, lifecycle: operators.lifecycle,
  }).from(operators).where(eq(operators.worldId, input.worldId));
  const publicOperators = operatorRows.filter((operator) => operator.kind === "player" && operator.lifecycle !== "deleted");
  const activityPolicy = effectiveActivityPolicy(blueprint);
  let activityEvents: readonly ActivityEvent[] = [];
  if (activityPolicy !== null) {
    const authoritativeAsOf = new Date(profile.epoch.getTime() + input.authoritativeNowS * 1_000);
    const windowStart = new Date(authoritativeAsOf.getTime() - activityPolicy.windowSeconds * 1_000);
    const eventRows = await db.select({
      eventType: domainEvents.eventType, payload: domainEvents.payload, occurredAt: domainEvents.occurredAt,
    }).from(domainEvents).where(and(
      eq(domainEvents.worldId, input.worldId),
      inArray(domainEvents.eventType, ACTIVITY_EVENT_TYPES),
      gte(domainEvents.occurredAt, windowStart),
      lte(domainEvents.occurredAt, authoritativeAsOf),
    ));
    activityEvents = eventRows.map((event) => ({
      eventType: event.eventType,
      operatorId: payloadOperatorId(event.payload),
      occurredAtS: Math.floor((event.occurredAt.getTime() - profile.epoch.getTime()) / 1_000),
    }));
  }
  const activity = calculateStrongActivity(activityPolicy, operatorRows, activityEvents, input.authoritativeNowS);
  const participationRows = await db.select({ state: worldParticipations.state }).from(worldParticipations)
    .where(eq(worldParticipations.worldId, input.worldId));
  const occupiedPlaces = participationRows.filter((entry) => entry.state === "provisioning" || entry.state === "active").length;
  const capacity = blueprint.admission.capacity;
  const freePlaces = Math.max(0, capacity - occupiedPlaces);
  const configuredAdmission = blueprint.admission.status;
  const admissionStatus = freePlaces === 0 && configuredAdmission === "open" ? "full" : configuredAdmission;
  const authoritativeAsOf = new Date(profile.epoch.getTime() + input.authoritativeNowS * 1_000);
  const endsAt = blueprint.publicMetadata.endsAt;
  const remainingRuntimeSeconds = endsAt === null ? null : Math.max(0, Math.floor((new Date(endsAt).getTime() - authoritativeAsOf.getTime()) / 1_000));

  const snapshot: PublicWorldSnapshotV1 = {
    projectionVersion: PUBLIC_WORLD_SNAPSHOT_VERSION,
    worldId: input.worldId,
    worldName: profile.worldName,
    shortDescription: blueprint.publicMetadata.description,
    phase: blueprint.publicMetadata.phase,
    startsAt: blueprint.publicMetadata.startsAt,
    endsAt,
    authoritativeAsOf: authoritativeAsOf.toISOString(),
    remainingRuntimeSeconds,
    startingCapitalPolicy: serializeStartingCapitalPolicy(effectiveStartingCapitalPolicy(blueprint)),
    totalOperators: publicOperators.length,
    stronglyActiveOperators: activity.status === "configured" ? activity.stronglyActiveOperatorIds.length : null,
    activityPolicyStatus: activity.status,
    activityExplanation: activity.status === "configured"
      ? `Spielhandlungen der letzten ${activityPolicy!.windowSeconds} Sekunden; stark aktiv ab ${activityPolicy!.minimumScore} gewichteten Punkten.`
      : "Grenzwerte fuer starke Aktivitaet sind noch nicht fachlich freigegeben.",
    capacity,
    freePlaces,
    admissionStatus,
    region: blueprint.publicMetadata.regionLabel,
    ruleRelease: blueprint.publicMetadata.ruleRelease,
    releases: blueprint.releases,
    banner: blueprint.publicMetadata.banner,
    generatedAt: input.generatedAt.toISOString(),
  };
  validatePublicWorldSnapshot(snapshot);
  return snapshot;
}
