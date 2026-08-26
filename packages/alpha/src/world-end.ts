import {
  alphaWorldProfiles,
  domainEvents,
  gameAdminRequests,
  ledgerAccounts,
  ledgerEntries,
  odooCommandQueue,
  odooProjectionOutbox,
  operatorContracts,
  operators,
  worldArchives,
  worldFinalRankings,
  worlds,
} from "@zugfolge/db";
import { ECONOMY_COST_TYPES, STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN } from "@zugfolge/economy";
import { and, asc, eq, sql } from "drizzle-orm";

import { AlphaAuthorizationError, AlphaConflictError, AlphaValidationError } from "./errors.js";
import { alphaHash } from "./hash.js";
import type { AlphaDatabase } from "./world.js";

type RankingType = "reliability" | "passenger-service" | "economy" | "resilience" | "cooperation";
const WORLD_END_RANKING_TYPES = ["reliability", "passenger-service", "economy", "resilience", "cooperation"] as const;
const GLOBAL_ADMIN_PROJECTION_SCOPE_ID = "00000000-0000-0000-0000-000000000000";

export interface WorldEndResult {
  readonly finalStateHash: string;
  readonly evidenceHash: string;
  readonly replayHash: string;
  readonly rankings: readonly {
    readonly rankingType: RankingType;
    readonly operatorId: string;
    readonly rank: number;
    readonly score: bigint;
    readonly evidenceHash: string;
  }[];
  readonly archives: readonly (typeof worldArchives.$inferSelect)[];
}

export interface WorldEndCloseInput {
  /** Bereits geoeffnete Commerce-Transaktion; `close` darf keine Nested-Tx erzeugen. */
  readonly db: AlphaDatabase;
  readonly worldId: string;
  readonly atS: number;
  readonly adminRequestId: string;
  readonly beforeSeal: (result: WorldEndResult) => Promise<void>;
}

/**
 * Fachvertrag der Wirtschaftsrangliste: kumulierter Betriebserfolg aus den
 * typisierten GuV-Konten. Kasse, Eigenkapital und Kredite sind bewusst keine
 * Ertraege und koennen den Schlussrang daher nicht durch Finanzierung heben.
 */
export const WORLD_END_ECONOMY_RANKING_SPECIFICATION = Object.freeze({
  schema: "world-end-economy-ranking/v1" as const,
  version: "cumulative-operating-result-2026-1",
  accountPlanVersion: STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN.version,
  measure: "revenue-minus-classified-costs" as const,
  revenueAccountName: STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN.revenueAccountName,
  costAccountNames: Object.freeze(ECONOMY_COST_TYPES.map((type) => STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN.costAccountNames[type])),
});

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
  const sorted = [...scores].sort(([leftId, left], [rightId, right]) => left === right
    ? Buffer.from(leftId).compare(Buffer.from(rightId))
    : left > right ? -1 : 1);
  let lastScore: bigint | undefined;
  let lastRank = 0;
  return sorted.map(([operatorId, score], index) => {
    if (lastScore === undefined || score !== lastScore) lastRank = index + 1;
    lastScore = score;
    return { rankingType: type, operatorId, rank: lastRank, score, evidenceHash };
  });
}

function exactValue(left: unknown, right: unknown): boolean {
  return alphaHash("zugfolge-world-end-exact-value/v1", left)
    === alphaHash("zugfolge-world-end-exact-value/v1", right);
}

function assertCloseCommandPayload(value: unknown, worldId: string, atS: number): void {
  const payload = payloadRecord(value);
  if (payload["kind"] !== "admin.world_close"
    || payload["actionType"] !== "world_close"
    || payload["riskClass"] !== "high"
    || payload["worldId"] !== worldId
    || payload["requestedAtS"] !== atS) {
    throw new AlphaAuthorizationError("Odoo-world_close stimmt nicht mit Welt und Abschlusszeit ueberein.");
  }
}

async function loadCloseAuthorization(
  db: AlphaDatabase,
  worldId: string,
  atS: number,
  adminRequestId: string,
  expectedState: "dispatched" | "completed",
) {
  const [row] = await db.select({
    requestId: gameAdminRequests.id,
    requestWorldId: gameAdminRequests.worldId,
    actionType: gameAdminRequests.actionType,
    riskClass: gameAdminRequests.riskClass,
    requesterReference: gameAdminRequests.requesterReference,
    approverReference: gameAdminRequests.approverReference,
    requestState: gameAdminRequests.state,
    requestCorrelationId: gameAdminRequests.correlationId,
    gameAuditEventId: gameAdminRequests.gameAuditEventId,
    commandId: odooCommandQueue.id,
    commandWorldId: odooCommandQueue.worldId,
    commandType: odooCommandQueue.commandType,
    commandStatus: odooCommandQueue.status,
    commandPayload: odooCommandQueue.payload,
    commandCorrelationId: odooCommandQueue.correlationId,
    commandEventId: odooCommandQueue.eventId,
  }).from(gameAdminRequests).innerJoin(
    odooCommandQueue,
    eq(odooCommandQueue.id, gameAdminRequests.commandId),
  ).where(and(
    eq(gameAdminRequests.id, adminRequestId),
    eq(gameAdminRequests.worldId, worldId),
  )).limit(1);
  const expectedCommandState = expectedState === "dispatched" ? "processing" : "completed";
  if (row === undefined
    || row.requestWorldId !== worldId
    || row.actionType !== "world_close"
    || row.riskClass !== "high"
    || row.requestState !== expectedState
    || row.approverReference === null
    || row.requesterReference === row.approverReference
    || row.commandWorldId !== worldId
    || row.commandType !== "admin.world_close"
    || row.commandStatus !== expectedCommandState
    || row.requestCorrelationId !== row.commandCorrelationId) {
    throw new AlphaAuthorizationError("Vollstaendige Odoo-Vier-Augen-Bindung fuer world_close fehlt.");
  }
  assertCloseCommandPayload(row.commandPayload, worldId, atS);
  return row;
}

async function calculateWorldEnd(
  db: AlphaDatabase,
  worldId: string,
  atS: number,
  profile: typeof alphaWorldProfiles.$inferSelect,
  world: typeof worlds.$inferSelect,
  eventUntilSequence?: number,
) {
  const operatorRows = await db.select({ id: operators.id }).from(operators)
    .where(eq(operators.worldId, worldId)).orderBy(asc(operators.id));
  if (operatorRows.length === 0) throw new AlphaConflictError("Welt besitzt keine EVU fuer Schlussranglisten.");
  const allEvents = await db.select().from(domainEvents).where(eq(domainEvents.worldId, worldId))
    .orderBy(asc(domainEvents.sequence));
  const events = eventUntilSequence === undefined
    ? allEvents
    : allEvents.filter((event) => event.sequence <= eventUntilSequence);
  const contracts = await db.select().from(operatorContracts).where(eq(operatorContracts.worldId, worldId))
    .orderBy(asc(operatorContracts.id));
  const balances = await db.select({
    operatorId: ledgerAccounts.operatorId,
    accountName: ledgerAccounts.name,
    amount: ledgerEntries.amountCents,
  }).from(ledgerEntries).innerJoin(ledgerAccounts, and(
    eq(ledgerEntries.worldId, ledgerAccounts.worldId),
    eq(ledgerEntries.ledgerAccountId, ledgerAccounts.id),
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
    if (event.eventType.includes("arrived") || event.eventType.includes("completed")) {
      reliability.set(operatorId, reliability.get(operatorId)! + 10_000n
        - integerField(event.payload, ["delaySeconds", "delay_seconds"]));
    }
    if (event.eventType.includes("cancel")) passenger.set(operatorId, passenger.get(operatorId)! - 10_000n);
    if (event.eventType.includes("passenger") || event.eventType.includes("service")) {
      passenger.set(operatorId, passenger.get(operatorId)!
        + integerField(event.payload, ["passengerCount", "passengers", "served"]));
    }
    if (event.eventType.startsWith("dispatch.") || event.eventType.includes("replacement")) {
      resilience.set(operatorId, resilience.get(operatorId)! + 1_000n);
    }
  }
  const economyCostAccounts = new Set(WORLD_END_ECONOMY_RANKING_SPECIFICATION.costAccountNames);
  for (const row of balances) {
    if (!economy.has(row.operatorId)) continue;
    if (row.accountName === WORLD_END_ECONOMY_RANKING_SPECIFICATION.revenueAccountName
      || economyCostAccounts.has(row.accountName)) {
      economy.set(row.operatorId, economy.get(row.operatorId)! - row.amount);
    }
  }
  for (const contract of contracts) {
    if (!["completed", "active"].includes(contract.status)) continue;
    cooperation.set(contract.offerorOperatorId, cooperation.get(contract.offerorOperatorId)! + 1_000n);
    cooperation.set(contract.offereeOperatorId, cooperation.get(contract.offereeOperatorId)! + 1_000n);
  }
  const evidenceHash = alphaHash("zugfolge-world-end-evidence/v1", {
    worldId,
    eventHead: events.at(-1)?.sequence ?? 0,
    eventHashes: events.map((event) => alphaHash("event/v1", event)),
    contractHashes: contracts.map((contract) => alphaHash("contract/v1", contract)),
    releasePins: {
      infra: profile.infraReleaseHash,
      timetable: profile.timetableReleaseHash,
      fleet: profile.fleetReleaseHash,
      economy: profile.economyReleaseHash,
    },
    economyRankingSpecification: WORLD_END_ECONOMY_RANKING_SPECIFICATION,
  });
  const rankings = [
    ...rankingRows(reliability, "reliability", evidenceHash),
    ...rankingRows(passenger, "passenger-service", evidenceHash),
    ...rankingRows(economy, "economy", evidenceHash),
    ...rankingRows(resilience, "resilience", evidenceHash),
    ...rankingRows(cooperation, "cooperation", evidenceHash),
  ];
  const replayPayload = events.map((event) => ({
    sequence: event.sequence,
    type: event.eventType,
    payload: event.payload,
    occurredAt: event.occurredAt.toISOString(),
  }));
  const replayHash = alphaHash("zugfolge-authorized-replay/v1", replayPayload);
  const finalStateHash = alphaHash("zugfolge-world-final-state/v1", {
    blueprintHash: profile.blueprintHash,
    evidenceHash,
    rankings,
    replayHash,
  });
  const occurredAt = new Date(world.epoch.getTime() + atS * 1_000);
  const participantRetention = new Date(occurredAt.getTime() + 90 * 86_400_000);
  const eventFromSequence = events[0]?.sequence ?? 0;
  const cutoffSequence = events.at(-1)?.sequence ?? 0;
  const archiveInputs = [
    { retentionClass: "public-history" as const, retainUntil: null, authorizedRoles: ["world-participant", "support", "auditor"] },
    { retentionClass: "participant-data" as const, retainUntil: participantRetention, authorizedRoles: ["data-subject", "privacy-officer"] },
    { retentionClass: "audit" as const, retainUntil: null, authorizedRoles: ["auditor"] },
  ].map((entry) => ({
    worldId,
    archiveSchema: "zugfolge-world-archive/v1",
    eventFromSequence,
    eventUntilSequence: cutoffSequence,
    stateHash: finalStateHash,
    replayHash,
    archiveHash: alphaHash("zugfolge-world-archive/v1", {
      worldId,
      ...entry,
      finalStateHash,
      replayHash,
    }),
    ...entry,
  }));
  return {
    result: { finalStateHash, evidenceHash, replayHash, rankings },
    allEvents,
    cutoffSequence,
    occurredAt,
    archiveInputs,
  };
}

function sortedRankingValues(values: readonly {
  readonly rankingType: string;
  readonly operatorId: string;
  readonly rank: number;
  readonly score: bigint;
  readonly evidenceHash: string;
}[]) {
  return [...values].sort((left, right) => `${left.rankingType}:${left.operatorId}`
    .localeCompare(`${right.rankingType}:${right.operatorId}`, "en"));
}

async function assertPersistedWorldEnd(
  db: AlphaDatabase,
  input: {
    readonly worldId: string;
    readonly atS: number;
    readonly adminRequestId: string;
    readonly calculation: Awaited<ReturnType<typeof calculateWorldEnd>>;
  },
) {
  const { worldId, atS, adminRequestId, calculation } = input;
  const authorization = await loadCloseAuthorization(db, worldId, atS, adminRequestId, "completed");
  const storedRankings = await db.select({
    rankingType: worldFinalRankings.rankingType,
    operatorId: worldFinalRankings.operatorId,
    rank: worldFinalRankings.rank,
    score: worldFinalRankings.score,
    evidenceHash: worldFinalRankings.evidenceHash,
  }).from(worldFinalRankings).where(eq(worldFinalRankings.worldId, worldId));
  if (!exactValue(
    sortedRankingValues(storedRankings),
    sortedRankingValues(calculation.result.rankings),
  )) {
    throw new AlphaConflictError("Persistierte Schlussranglisten widersprechen dem rekonstruierten Weltende.");
  }

  const archives = await db.select().from(worldArchives).where(eq(worldArchives.worldId, worldId));
  const archiveValues = archives.map((archive) => ({
    worldId: archive.worldId,
    archiveSchema: archive.archiveSchema,
    eventFromSequence: archive.eventFromSequence,
    eventUntilSequence: archive.eventUntilSequence,
    stateHash: archive.stateHash,
    replayHash: archive.replayHash,
    archiveHash: archive.archiveHash,
    retentionClass: archive.retentionClass,
    retainUntil: archive.retainUntil,
    authorizedRoles: archive.authorizedRoles,
  })).sort((left, right) => left.retentionClass.localeCompare(right.retentionClass, "en"));
  const expectedArchives = [...calculation.archiveInputs]
    .sort((left, right) => left.retentionClass.localeCompare(right.retentionClass, "en"));
  if (archives.length !== 3 || !exactValue(archiveValues, expectedArchives)) {
    throw new AlphaConflictError("Weltarchiv ist unvollstaendig oder widerspruechlich.");
  }

  const tail = calculation.allEvents.filter((event) => event.sequence > calculation.cutoffSequence);
  if (tail.length !== 2
    || tail[0]?.sequence !== calculation.cutoffSequence + 1
    || tail[0].eventType !== "alpha.world-archived"
    || tail[0].occurredAt.getTime() !== calculation.occurredAt.getTime()
    || tail[1]?.sequence !== calculation.cutoffSequence + 2
    || tail[1].eventType !== "admin.action-audited"
    || authorization.gameAuditEventId !== tail[1].id) {
    throw new AlphaConflictError("Weltabschluss besitzt keine exakte versiegelte Eventfolge.");
  }
  const archivedPayload = {
    finalStateHash: calculation.result.finalStateHash,
    evidenceHash: calculation.result.evidenceHash,
    replayHash: calculation.result.replayHash,
    rankingTypes: WORLD_END_RANKING_TYPES,
    noWorldEndPenalty: true,
    prequalificationTransfer: false,
    adminRequestId,
  };
  if (!exactValue(tail[0].payload, archivedPayload)) {
    throw new AlphaConflictError("Weltabschlussereignis widerspricht dem rekonstruierten Schlusszustand.");
  }
  const effectAuditReference = `world-close:${worldId}:${calculation.result.finalStateHash}`;
  const auditPayload = {
    adminRequestId,
    actionType: "world_close",
    riskClass: "high",
    correlationId: authorization.commandCorrelationId,
    outcome: "completed",
    effectAuditReference,
  };
  if (!exactValue(tail[1].payload, auditPayload)) {
    throw new AlphaConflictError("Game-Auditbeleg widerspricht dem world_close-Antrag.");
  }

  const globalResults = await db.select().from(odooProjectionOutbox).where(and(
    eq(odooProjectionOutbox.worldId, GLOBAL_ADMIN_PROJECTION_SCOPE_ID),
    eq(odooProjectionOutbox.messageType, "admin.command.result"),
    eq(odooProjectionOutbox.correlationId, authorization.commandCorrelationId),
  ));
  const expectedProjection = {
    finalStateHash: calculation.result.finalStateHash,
    evidenceHash: calculation.result.evidenceHash,
    replayHash: calculation.result.replayHash,
    archivedAtS: atS,
    eventId: authorization.commandEventId,
    outcome: "accepted",
    state: "completed",
    authoritative: true,
    projectionScope: "global-admin",
    actionType: "world_close",
    targetWorldId: worldId,
    adminRequestId,
    gameAuditEventId: tail[1].id,
    effectAuditReference,
  };
  if (globalResults.length !== 1
    || globalResults[0]?.schemaVersion !== "zugfolge-odoo/v1"
    || !exactValue(globalResults[0].payload, expectedProjection)) {
    throw new AlphaConflictError("Globale Odoo-Abschlussprojektion fehlt oder ist nicht exakt gebunden.");
  }
  return archives;
}

export class WorldEndService {
  constructor(private readonly db: AlphaDatabase) {}

  /**
   * Vollzieht world_close innerhalb der bereits vom Commerce-Store geoeffneten
   * Transaktion. Der exklusive Welt-Lock ist die erste DB-Anweisung dieses
   * Fachpfads; `worlds.lifecycle_status = archived` bleibt sein letzter
   * weltgebundener Write.
   */
  async close(input: WorldEndCloseInput): Promise<WorldEndResult> {
    const { db, worldId, atS, adminRequestId } = input;
    if (!Number.isSafeInteger(atS) || atS < 0) throw new AlphaValidationError("Weltendezeit ist ungueltig.");
    await db.execute(sql`select pg_advisory_xact_lock(
      ('x' || substr(md5(${worldId}::uuid::text), 1, 16))::bit(64)::bigint
    )`);
    const [profile] = await db.select().from(alphaWorldProfiles)
      .where(eq(alphaWorldProfiles.worldId, worldId)).limit(1);
    const [world] = await db.select().from(worlds).where(eq(worlds.id, worldId)).limit(1);
    if (profile === undefined || world === undefined) throw new AlphaValidationError("Welt oder Weltprofil fehlt.");

    if (profile.state === "archived" || world.lifecycleStatus === "archived") {
      if (profile.state !== "archived"
        || world.lifecycleStatus !== "archived"
        || profile.closingAtS !== atS
        || profile.archivedAtS !== atS
        || profile.finalStateHash === null) {
        throw new AlphaConflictError("Archivierter Weltabschluss besitzt einen unvollstaendigen Mischzustand.");
      }
      const archives = await db.select().from(worldArchives).where(eq(worldArchives.worldId, worldId));
      const publicArchive = archives.filter((archive) => archive.retentionClass === "public-history");
      if (publicArchive.length !== 1) throw new AlphaConflictError("Archivierter Weltabschluss besitzt keinen eindeutigen Replay-Cutoff.");
      const calculation = await calculateWorldEnd(
        db,
        worldId,
        atS,
        profile,
        world,
        publicArchive[0]!.eventUntilSequence,
      );
      if (profile.finalStateHash !== calculation.result.finalStateHash) {
        throw new AlphaConflictError("Archivierter Schluss-Hash ist nicht rekonstruierbar.");
      }
      const verifiedArchives = await assertPersistedWorldEnd(db, {
        worldId,
        atS,
        adminRequestId,
        calculation,
      });
      return { ...calculation.result, archives: verifiedArchives };
    }

    if (profile.state !== "running" || world.lifecycleStatus !== "active") {
      throw new AlphaConflictError("Nur eine aktive laufende Welt kann atomar abgeschlossen werden.");
    }
    if (profile.periodCount !== null && profile.currentPeriod < profile.periodCount - 1) {
      throw new AlphaConflictError("Befristete Welt ist noch nicht in der letzten Periode.");
    }
    await loadCloseAuthorization(db, worldId, atS, adminRequestId, "dispatched");
    const transitioned = await db.update(alphaWorldProfiles).set({
      state: "closing",
      closingAtS: atS,
    }).where(and(
      eq(alphaWorldProfiles.worldId, worldId),
      eq(alphaWorldProfiles.state, "running"),
    )).returning({ worldId: alphaWorldProfiles.worldId });
    if (transitioned.length !== 1) throw new AlphaConflictError("Weltabschluss verlor das Transition-Rennen.");

    const calculation = await calculateWorldEnd(db, worldId, atS, profile, world);
    await db.insert(worldFinalRankings).values(calculation.result.rankings.map((ranking) => ({
      worldId,
      ...ranking,
    })));
    const archives = await db.insert(worldArchives).values(calculation.archiveInputs).returning();
    const archivedProfiles = await db.update(alphaWorldProfiles).set({
      state: "archived",
      archivedAtS: atS,
      finalStateHash: calculation.result.finalStateHash,
    }).where(and(
      eq(alphaWorldProfiles.worldId, worldId),
      eq(alphaWorldProfiles.state, "closing"),
      eq(alphaWorldProfiles.closingAtS, atS),
    )).returning({ worldId: alphaWorldProfiles.worldId });
    if (archivedProfiles.length !== 1) throw new AlphaConflictError("Weltprofil konnte nicht atomar archiviert werden.");
    await db.insert(domainEvents).values({
      worldId,
      sequence: calculation.cutoffSequence + 1,
      eventType: "alpha.world-archived",
      payload: {
        finalStateHash: calculation.result.finalStateHash,
        evidenceHash: calculation.result.evidenceHash,
        replayHash: calculation.result.replayHash,
        rankingTypes: WORLD_END_RANKING_TYPES,
        noWorldEndPenalty: true,
        prequalificationTransfer: false,
        adminRequestId,
      },
      occurredAt: calculation.occurredAt,
    });

    const result: WorldEndResult = { ...calculation.result, archives };
    await input.beforeSeal(result);
    const verification = await calculateWorldEnd(
      db,
      worldId,
      atS,
      profile,
      world,
      calculation.cutoffSequence,
    );
    if (!exactValue(verification.result, calculation.result)) {
      throw new AlphaConflictError("Weltzustand veraenderte sich waehrend der Abschlussquittierung.");
    }
    await assertPersistedWorldEnd(db, {
      worldId,
      atS,
      adminRequestId,
      calculation: verification,
    });
    const sealedWorlds = await db.update(worlds).set({ lifecycleStatus: "archived" }).where(and(
      eq(worlds.id, worldId),
      eq(worlds.lifecycleStatus, "active"),
    )).returning({ id: worlds.id });
    if (sealedWorlds.length !== 1) throw new AlphaConflictError("Welt-Lifecycle konnte nicht als letzter Write versiegelt werden.");
    return result;
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
