import { randomUUID } from "node:crypto";
import { abuseObservations, abuseSanctions, rateLimitBuckets, type AbuseObservation } from "@zugfolge/db";
import { and, eq, inArray, isNotNull, isNull, gt, lte, or, sql } from "drizzle-orm";

import { AlphaConflictError, AlphaValidationError } from "./errors.js";
import { alphaHash } from "./hash.js";
import type { AlphaDatabase } from "./world.js";

export const ABUSE_POLICY = Object.freeze({
  schemaVersion: "zugfolge-abuse-policy/v2",
  bucketSeconds: 60,
  limits: {
    anonymous: { endpoint: 30, action: 10, distinctTargets: 8 },
    authenticated: { endpoint: 120, action: 30, distinctTargets: 20 },
    administrative: { endpoint: 60, action: 10, distinctTargets: 10 },
  },
  protectedActions: ["path-window", "tender-bid", "vehicle-market", "operator-contract"],
  thresholds: { delay: 2_500, limit: 5_000, block: 7_500, manualReview: 9_000 },
} as const);

export type IdentityClass = keyof typeof ABUSE_POLICY.limits;
export type AbuseResponse = AbuseObservation["response"];

export interface AbuseFacts {
  readonly observationKey?: string;
  readonly worldId: string;
  readonly identityHash: string;
  readonly identityClass: IdentityClass;
  readonly endpointClass: string;
  readonly actionClass: string;
  readonly atS: number;
  readonly requestCount: number;
  readonly actionCount: number;
  readonly distinctTargetCount: number;
  readonly replayCount: number;
  readonly coordinatedIdentityCount: number;
  readonly correlationId: string;
}

export interface AbuseRequest {
  readonly worldId: string;
  readonly identityHash: string;
  readonly identityClass: IdentityClass;
  readonly endpointClass: string;
  readonly actionClass: string;
  readonly targetHash: string;
  readonly replayKeyHash: string;
  readonly atS: number;
  readonly correlationId: string;
}

function count(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) throw new AlphaValidationError(`${name} ist ungueltig.`);
}

export function evaluateAbuse(facts: AbuseFacts): { readonly scoreBasisPoints: number; readonly ruleCodes: readonly string[]; readonly response: AbuseResponse; readonly delayMs: number } {
  if (!Number.isSafeInteger(facts.atS) || facts.atS < 0) throw new AlphaValidationError("Missbrauchszeit ist ungueltig.");
  for (const [name, value] of Object.entries({ requestCount: facts.requestCount, actionCount: facts.actionCount, distinctTargetCount: facts.distinctTargetCount, replayCount: facts.replayCount, coordinatedIdentityCount: facts.coordinatedIdentityCount })) count(value, name);
  const limit = ABUSE_POLICY.limits[facts.identityClass];
  const rules: string[] = [];
  let score = 0;
  if (facts.requestCount > limit.endpoint) { rules.push("rate.endpoint"); score += Math.min(3_000, (facts.requestCount - limit.endpoint) * 100); }
  if (facts.actionCount > limit.action) { rules.push("rate.action"); score += Math.min(3_000, (facts.actionCount - limit.action) * 200); }
  if (facts.distinctTargetCount > limit.distinctTargets) { rules.push("mass-targets"); score += Math.min(2_500, (facts.distinctTargetCount - limit.distinctTargets) * 250); }
  if (facts.replayCount > 0) { rules.push("replay"); score += Math.min(3_500, facts.replayCount * 700); }
  if (facts.coordinatedIdentityCount >= 3) { rules.push("coordinated-market"); score += Math.min(4_000, (facts.coordinatedIdentityCount - 2) * 800); }
  if (ABUSE_POLICY.protectedActions.includes(facts.actionClass as never) && facts.actionCount > Math.floor(limit.action * 3 / 4)) {
    rules.push("protected-action-burst"); score += 1_000;
  }
  score = Math.min(10_000, score);
  const response: AbuseResponse = score >= ABUSE_POLICY.thresholds.manualReview ? "manual-review"
    : score >= ABUSE_POLICY.thresholds.block ? "block"
      : score >= ABUSE_POLICY.thresholds.limit ? "limit"
        : score >= ABUSE_POLICY.thresholds.delay ? "delay" : "observe";
  return { scoreBasisPoints: score, ruleCodes: rules.sort(), response, delayMs: response === "delay" ? Math.min(2_000, score / 5) : 0 };
}

export class AbuseGuard {
  constructor(private readonly db: AlphaDatabase) {}

  async evaluate(facts: AbuseFacts): Promise<AbuseObservation> {
    if (!/^[a-f0-9]{64}$/.test(facts.identityHash)) throw new AlphaValidationError("Identitaet ist nicht pseudonymisiert.");
    const result = evaluateAbuse(facts);
    const { observationKey: requestedKey, ...immutableFacts } = facts;
    const factsHash = alphaHash("zugfolge-abuse-facts/v2", immutableFacts);
    const observationKey = requestedKey ?? factsHash;
    const bucketStartS = facts.atS - facts.atS % ABUSE_POLICY.bucketSeconds;
    let [observation] = await this.db.insert(abuseObservations).values({
      worldId: facts.worldId,
      identityHash: facts.identityHash,
      endpointClass: facts.endpointClass,
      actionClass: facts.actionClass,
      bucketStartS,
      requestCount: facts.requestCount,
      distinctTargetCount: facts.distinctTargetCount,
      replayCount: facts.replayCount,
      coordinatedIdentityCount: facts.coordinatedIdentityCount,
      scoreBasisPoints: result.scoreBasisPoints,
      ruleCodes: result.ruleCodes,
      response: result.response,
      correlationId: facts.correlationId,
      observationKey,
      factsHash,
    }).onConflictDoNothing({ target: [abuseObservations.worldId, abuseObservations.observationKey] }).returning();
    if (observation === undefined) {
      [observation] = await this.db.select().from(abuseObservations).where(and(
        eq(abuseObservations.worldId, facts.worldId), eq(abuseObservations.observationKey, observationKey),
      )).limit(1);
      if (observation === undefined) throw new Error("Missbrauchsbeobachtung konnte nicht gelesen werden.");
      if (observation.factsHash !== factsHash) throw new AlphaConflictError("Beobachtungsschluessel gehoert zu anderen Missbrauchsfakten.", "abuse_replay_conflict");
    }
    if (observation.response === "manual-review") {
      await this.db.insert(abuseSanctions).values({
        worldId: facts.worldId,
        observationId: observation.id,
        identityHash: facts.identityHash,
        sanction: "manual-review",
        status: "proposed",
        startsAtS: facts.atS,
        explanation: { policy: ABUSE_POLICY.schemaVersion, scoreBasisPoints: observation.scoreBasisPoints, ruleCodes: observation.ruleCodes, appealAvailable: true },
      }).onConflictDoNothing();
    }
    // Einspruch suspendiert eine bestaetigte Massnahme nicht. Ein angefochtener
    // Vorschlag besitzt keine administrative Aktivierung und bleibt unwirksam.
    const sanctions = await this.db.select().from(abuseSanctions).where(and(
      eq(abuseSanctions.worldId, facts.worldId), eq(abuseSanctions.identityHash, facts.identityHash),
      or(eq(abuseSanctions.status, "active"), and(eq(abuseSanctions.status, "appealed"), isNotNull(abuseSanctions.odooAdminRequestId))),
      lte(abuseSanctions.startsAtS, facts.atS), or(isNull(abuseSanctions.endsAtS), gt(abuseSanctions.endsAtS, facts.atS)),
    ));
    const rank: Record<AbuseResponse, number> = { observe: 0, delay: 1, limit: 2, block: 3, "manual-review": 4 };
    let response = observation.response;
    for (const sanction of sanctions) {
      const candidate = sanction.sanction === "temporary-block" ? "block" : sanction.sanction;
      if (rank[candidate] > rank[response]) response = candidate;
    }
    return { ...observation, response, scoreBasisPoints: response === "delay" ? Math.max(2_500, observation.scoreBasisPoints) : observation.scoreBasisPoints };
  }

  async consume(request: AbuseRequest): Promise<AbuseObservation> {
    for (const [name, hash] of Object.entries({ identityHash: request.identityHash, targetHash: request.targetHash, replayKeyHash: request.replayKeyHash })) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new AlphaValidationError(`${name} ist kein SHA-256.`);
    }
    const bucketStartS = request.atS - request.atS % ABUSE_POLICY.bucketSeconds;
    const targetHashes = { [request.targetHash]: true };
    const replayKeys = { [request.replayKeyHash]: true };
    const [bucket] = await this.db.insert(rateLimitBuckets).values({
      worldId: request.worldId,
      identityHash: request.identityHash,
      identityClass: request.identityClass,
      endpointClass: request.endpointClass,
      actionClass: request.actionClass,
      bucketStartS,
      requestCount: 1,
      actionCount: 1,
      targetHashes,
      replayKeys,
      replayCount: 0,
    }).onConflictDoUpdate({
      target: [rateLimitBuckets.worldId, rateLimitBuckets.identityHash, rateLimitBuckets.endpointClass, rateLimitBuckets.actionClass, rateLimitBuckets.bucketStartS],
      set: {
        requestCount: sql`${rateLimitBuckets.requestCount} + 1`,
        actionCount: sql`${rateLimitBuckets.actionCount} + 1`,
        targetHashes: sql`${rateLimitBuckets.targetHashes} || ${JSON.stringify(targetHashes)}::jsonb`,
        replayCount: sql`${rateLimitBuckets.replayCount} + case when ${rateLimitBuckets.replayKeys} ? ${request.replayKeyHash} then 1 else 0 end`,
        replayKeys: sql`${rateLimitBuckets.replayKeys} || ${JSON.stringify(replayKeys)}::jsonb`,
      },
    }).returning();
    if (bucket === undefined) throw new Error("Rate-Limit-Fenster konnte nicht fortgeschrieben werden.");
    const coordinated = await this.db.select({ identityHash: rateLimitBuckets.identityHash, targetHashes: rateLimitBuckets.targetHashes }).from(rateLimitBuckets).where(and(
      eq(rateLimitBuckets.worldId, request.worldId), eq(rateLimitBuckets.actionClass, request.actionClass), eq(rateLimitBuckets.bucketStartS, bucketStartS),
    ));
    const coordinatedIdentityCount = coordinated.filter((row) => {
      const targets = typeof row.targetHashes === "object" && row.targetHashes !== null ? row.targetHashes as Record<string, unknown> : {};
      return targets[request.targetHash] === true;
    }).length;
    const targets = typeof bucket.targetHashes === "object" && bucket.targetHashes !== null ? bucket.targetHashes as Record<string, unknown> : {};
    return this.evaluate({
      observationKey: randomUUID(),
      worldId: request.worldId,
      identityHash: request.identityHash,
      identityClass: request.identityClass,
      endpointClass: request.endpointClass,
      actionClass: request.actionClass,
      atS: request.atS,
      requestCount: bucket.requestCount,
      actionCount: bucket.actionCount,
      distinctTargetCount: Object.keys(targets).length,
      replayCount: bucket.replayCount,
      coordinatedIdentityCount,
      correlationId: request.correlationId,
    });
  }

  async activateSevere(worldId: string, sanctionId: string, odooAdminRequestId: string) {
    const [updated] = await this.db.update(abuseSanctions).set({ status: "active", odooAdminRequestId }).where(and(
      eq(abuseSanctions.worldId, worldId), eq(abuseSanctions.id, sanctionId), eq(abuseSanctions.status, "proposed"),
    )).returning();
    if (updated === undefined) throw new AlphaConflictError("Schwere Massnahme ist nicht vorgeschlagen oder bereits bearbeitet.");
    return updated;
  }

  async appeal(worldId: string, identityHash: string, sanctionId: string, appealReference: string) {
    if (appealReference.trim().length < 8) throw new AlphaValidationError("Einspruch braucht eine nachvollziehbare Begruendung oder Referenz.");
    const [updated] = await this.db.update(abuseSanctions).set({ status: "appealed", appealReference }).where(and(
      eq(abuseSanctions.worldId, worldId), eq(abuseSanctions.id, sanctionId), eq(abuseSanctions.identityHash, identityHash),
      inArray(abuseSanctions.status, ["proposed", "active"]),
    )).returning();
    if (updated === undefined) throw new AlphaConflictError("Sanktion ist nicht einspruchsfaehig.");
    return updated;
  }
}
