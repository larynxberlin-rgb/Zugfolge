import {
  alphaWorldProfiles,
  domainEvents,
  gameAdminRequests,
  ledgerAccounts,
  ledgerEntries,
  operatorContracts,
  operators,
  worldArchives,
  worldFinalRankings,
  worlds,
} from "@zugfolge/db";
import { and, asc, eq, sql } from "drizzle-orm";

import { AlphaAuthorizationError, AlphaConflictError, AlphaValidationError } from "./errors.js";
import { alphaHash } from "./hash.js";
import type { AlphaDatabase } from "./world.js";

type RankingType = "reliability" | "passenger-service" | "economy" | "resilience" | "cooperation";

function payloadRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

function eventOperator(payload: unknown): string | undefined {
  const value = payloadRecord(payload);
  for (const key of ["operatorId", "operator_id", "actingOperatorId", "toOperatorId"]) {
    if (typeof value[key] === "string") return value[key] as string;
  }
  return undefined;
}

function integerField(payload: unknown, keys: readonly string[]): bigint {
  const value = payloadRecord(payload);
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "number" && Number.isSafeInteger(item)) return BigInt(item);
    if (typeof item === "string" && /^-?[0-9]+$/.test(item)) return BigInt(item);
  }
  return 0n;
}

function rankingRows(scores: ReadonlyMap<string, bigint>, type: RankingType, evidenceHash: string) {
  return [...scores].sort(([leftId, left], [rightId, right]) => left === right
    ? Buffer.from(leftId).compare(Buffer.from(rightId))
    : left > right ? -1 : 1).map(([operatorId, score], index) => ({ rankingType: type, operatorId, rank: index + 1, score, evidenceHash }));
}

export class WorldEndService {
  constructor(private readonly db: AlphaDatabase) {}

  async beginClosure(worldId: string, atS: number, adminRequestId?: string) {
    if (!Number.isSafeInteger(atS) || atS < 0) throw new AlphaValidationError("Weltendezeit ist ungueltig.");
    const [profile] = await this.db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, worldId)).limit(1);
    if (profile?.state !== "running") throw new AlphaConflictError("Nur eine laufende Welt kann den Abschluss beginnen.");
    if (profile.periodCount !== null && profile.currentPeriod < profile.periodCount - 1) throw new AlphaConflictError("Befristete Welt ist noch nicht in der letzten Periode.");
    if (profile.periodCount === null) {
      if (adminRequestId === undefined) throw new AlphaAuthorizationError("Unbefristetes Weltende braucht einen Odoo-Hochrisikoantrag.");
      const [request] = await this.db.select().from(gameAdminRequests).where(and(eq(gameAdminRequests.worldId, worldId), eq(gameAdminRequests.id, adminRequestId))).limit(1);
      if (request?.actionType !== "world_close" || request.riskClass !== "high" || request.state !== "approved" || request.requesterReference === request.approverReference) {
        throw new AlphaAuthorizationError("Odoo-Vier-Augen-Freigabe fuer unbefristetes Weltende fehlt.");
      }
    }
    const [updated] = await this.db.update(alphaWorldProfiles).set({ state: "closing", closingAtS: atS }).where(and(
      eq(alphaWorldProfiles.worldId, worldId), eq(alphaWorldProfiles.state, "running"),
    )).returning();
    if (updated === undefined) throw new AlphaConflictError("Weltabschluss verlor ein Parallelrennen.");
    return updated;
  }

  async finalize(worldId: string, atS: number) {
    const [profile] = await this.db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, worldId)).limit(1);
    if (profile?.state !== "closing") throw new AlphaConflictError("Welt ist nicht im Abschluss.");
    const [world] = await this.db.select().from(worlds).where(eq(worlds.id, worldId)).limit(1);
    if (world === undefined) throw new AlphaValidationError("Welt fehlt.");
    const operatorRows = await this.db.select({ id: operators.id }).from(operators).where(eq(operators.worldId, worldId)).orderBy(asc(operators.id));
    if (operatorRows.length === 0) throw new AlphaConflictError("Welt besitzt keine EVU fuer Schlussranglisten.");
    const events = await this.db.select().from(domainEvents).where(eq(domainEvents.worldId, worldId)).orderBy(asc(domainEvents.sequence));
    const contracts = await this.db.select().from(operatorContracts).where(eq(operatorContracts.worldId, worldId)).orderBy(asc(operatorContracts.id));
    const balances = await this.db.select({ operatorId: ledgerAccounts.operatorId, amount: ledgerEntries.amountCents })
      .from(ledgerEntries).innerJoin(ledgerAccounts, and(
        eq(ledgerEntries.worldId, ledgerAccounts.worldId), eq(ledgerEntries.ledgerAccountId, ledgerAccounts.id),
      )).where(eq(ledgerEntries.worldId, worldId));
    const ids = operatorRows.map((row) => row.id);
    const base = () => new Map(ids.map((id) => [id, 0n]));
    const reliability = base();
    const passenger = base();
    const economy = base();
    const resilience = base();
    const cooperation = base();
    for (const event of events) {
      const operatorId = eventOperator(event.payload);
      if (operatorId === undefined || !reliability.has(operatorId)) continue;
      if (event.eventType.includes("arrived") || event.eventType.includes("completed")) reliability.set(operatorId, reliability.get(operatorId)! + 10_000n - integerField(event.payload, ["delaySeconds", "delay_seconds"]));
      if (event.eventType.includes("cancel")) passenger.set(operatorId, passenger.get(operatorId)! - 10_000n);
      if (event.eventType.includes("passenger") || event.eventType.includes("service")) passenger.set(operatorId, passenger.get(operatorId)! + integerField(event.payload, ["passengerCount", "passengers", "served"]));
      if (event.eventType.startsWith("dispatch.") || event.eventType.includes("replacement")) resilience.set(operatorId, resilience.get(operatorId)! + 1_000n);
    }
    for (const row of balances) if (economy.has(row.operatorId)) economy.set(row.operatorId, economy.get(row.operatorId)! + row.amount);
    for (const contract of contracts) {
      if (!["completed", "active"].includes(contract.status)) continue;
      cooperation.set(contract.offerorOperatorId, cooperation.get(contract.offerorOperatorId)! + 1_000n);
      cooperation.set(contract.offereeOperatorId, cooperation.get(contract.offereeOperatorId)! + 1_000n);
    }
    const evidenceHash = alphaHash("zugfolge-world-end-evidence/v1", {
      worldId, eventHead: events.at(-1)?.sequence ?? 0, eventHashes: events.map((event) => alphaHash("event/v1", event)),
      contractHashes: contracts.map((contract) => alphaHash("contract/v1", contract)), releasePins: {
        infra: profile.infraReleaseHash, timetable: profile.timetableReleaseHash, fleet: profile.fleetReleaseHash, economy: profile.economyReleaseHash,
      },
    });
    const rankings = [
      ...rankingRows(reliability, "reliability", evidenceHash),
      ...rankingRows(passenger, "passenger-service", evidenceHash),
      ...rankingRows(economy, "economy", evidenceHash),
      ...rankingRows(resilience, "resilience", evidenceHash),
      ...rankingRows(cooperation, "cooperation", evidenceHash),
    ];
    const replayPayload = events.map((event) => ({ sequence: event.sequence, type: event.eventType, payload: event.payload, occurredAt: event.occurredAt.toISOString() }));
    const replayHash = alphaHash("zugfolge-authorized-replay/v1", replayPayload);
    const finalStateHash = alphaHash("zugfolge-world-final-state/v1", { blueprintHash: profile.blueprintHash, evidenceHash, rankings, replayHash });
    const occurredAt = new Date(world.epoch.getTime() + atS * 1_000);
    const participantRetention = new Date(occurredAt.getTime() + 90 * 86_400_000);
    return this.db.transaction(async (tx) => {
      await tx.insert(worldFinalRankings).values(rankings.map((row) => ({ worldId, ...row })));
      const archiveInputs = [
        { retentionClass: "public-history" as const, retainUntil: null, authorizedRoles: ["world-participant", "support", "auditor"] },
        { retentionClass: "participant-data" as const, retainUntil: participantRetention, authorizedRoles: ["data-subject", "privacy-officer"] },
        { retentionClass: "audit" as const, retainUntil: null, authorizedRoles: ["auditor"] },
      ];
      const archives = await tx.insert(worldArchives).values(archiveInputs.map((entry) => ({
        worldId, archiveSchema: "zugfolge-world-archive/v1", eventFromSequence: events[0]?.sequence ?? 0,
        eventUntilSequence: events.at(-1)?.sequence ?? 0, stateHash: finalStateHash, replayHash,
        archiveHash: alphaHash("zugfolge-world-archive/v1", { worldId, ...entry, finalStateHash, replayHash }), ...entry,
      }))).returning();
      await tx.update(alphaWorldProfiles).set({ state: "archived", archivedAtS: atS, finalStateHash }).where(and(eq(alphaWorldProfiles.worldId, worldId), eq(alphaWorldProfiles.state, "closing")));
      await tx.update(worlds).set({ lifecycleStatus: "archived" }).where(eq(worlds.id, worldId));
      const [head] = events.slice(-1);
      await tx.insert(domainEvents).values({ worldId, sequence: (head?.sequence ?? 0) + 1, eventType: "alpha.world-archived", payload: { finalStateHash, evidenceHash, replayHash, rankingTypes: ["reliability", "passenger-service", "economy", "resilience", "cooperation"], noWorldEndPenalty: true, prequalificationTransfer: false }, occurredAt });
      return { finalStateHash, evidenceHash, replayHash, rankings, archives };
    });
  }

  async exportReplay(worldId: string, role: string) {
    const [archive] = await this.db.select().from(worldArchives).where(and(eq(worldArchives.worldId, worldId), eq(worldArchives.retentionClass, "public-history"))).limit(1);
    if (archive === undefined) throw new AlphaConflictError("Weltarchiv fehlt.");
    if (!Array.isArray(archive.authorizedRoles) || !(archive.authorizedRoles as unknown[]).includes(role)) throw new AlphaAuthorizationError("Rolle darf diesen Replay nicht exportieren.");
    const events = await this.db.select().from(domainEvents).where(and(
      eq(domainEvents.worldId, worldId), sql`${domainEvents.sequence} between ${archive.eventFromSequence} and ${archive.eventUntilSequence}`,
    )).orderBy(asc(domainEvents.sequence));
    const payload = { schemaVersion: "zugfolge-authorized-replay/v1", worldId, stateHash: archive.stateHash, events: events.map((event) => ({ sequence: event.sequence, type: event.eventType, payload: event.payload, occurredAt: event.occurredAt.toISOString() })) };
    if (alphaHash("zugfolge-authorized-replay/v1", payload.events) !== archive.replayHash) throw new AlphaConflictError("Replay-Hash stimmt nicht mit dem unveraenderlichen Archiv ueberein.", "replay_hash_mismatch");
    return { ...payload, replayHash: archive.replayHash };
  }
}
