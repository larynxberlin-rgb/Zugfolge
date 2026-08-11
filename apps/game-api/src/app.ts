/**
 * Game-API (M2) — Keycloak-Authentifizierung, Konten, Rollen, Weltzugänge
 * (M2.1), EVU (M2.3), Ledger-Kern (M2.4), Postfach (M2.5), Datenschutz
 * (M2.6).
 *
 * `buildApp` nimmt seine Abhängigkeiten entgegen, statt sie selbst
 * aufzubauen: Produktion verdrahtet eine echte Postgres-Verbindung und den
 * echten Keycloak-Realm (`server.ts`), Tests verdrahten PGlite und ein
 * lokales Schlüsselpaar (`app.test.ts`). Beide laufen über denselben Code.
 */

import { timingSafeEqual } from "node:crypto";

import {
  accounts,
  createDatabaseHealthCheck,
  dailyOperationReports,
  EventSequenceError,
  operatingProgramVersions,
  simulationCommands,
  worldEventLog,
  worlds,
} from "@zugfolge/db";
import {
  ACTIONS,
  buildDailyReport,
  canonicalizeProgram,
  operatingProgramTemplates,
  OperationsRegistry,
  ProgramValidationError,
  projectOperations,
} from "@zugfolge/dispatch";
import {
  announceTender,
  buildEconomyRelease,
  decodeEconomyValue,
  deriveGtfsServiceSpecification,
  DuplicateLedgerAccountNameError,
  EconomyStateConflictError,
  escalateOperator,
  FleetSnapshotValidationError,
  ForeignLedgerAccountError,
  encodeEconomyValue,
  IncompleteTransactionError,
  ledgerAccountBalance,
  listLedgerAccounts,
  listLedgerTransactions,
  loadFleetMobilizationSnapshot,
  loadEconomyWorldState,
  openLedgerAccount,
  postLedgerTransaction,
  persistEconomyTransition,
  persistFleetMobilizationSnapshot,
  resolveVehicleConcept,
  settleContractPeriod,
  startEconomyWorld,
  submitBid,
  submitMobilizationReference,
  UnbalancedTransactionError,
  verifyMobilizationReference,
  type AuthorityBudget,
  type EconomyRelease,
  type FleetMobilizationReference,
  type GtfsPlanningEnvelope,
  type GtfsPlanningLotReference,
} from "@zugfolge/economy";
import { runHealthChecks, type HealthCheck } from "@zugfolge/health";
import { LivemapCapacityError, type LiveDelta, type LivemapRegistry } from "@zugfolge/livemap-stream";
import {
  AccessRevokedError,
  AccountNotFoundError,
  AuthorizationError,
  getAccount,
  grantRole,
  isRole,
  listAccountsForSubject,
  listAccountsInWorld,
  requestWorldAccess,
  type IdentityDatabase,
} from "@zugfolge/identity";
import { acknowledgeMessage, listInbox, MessageNotFoundError, RecipientNotFoundError, sendMessage } from "@zugfolge/mailbox";
import {
  DuplicateOperatorNameError,
  foundOperator,
  getOperator,
  listOperatorsForAccount,
  listOperatorsInWorld,
  NoAccountInWorldError,
  OperatorNotFoundError,
} from "@zugfolge/operators";
import {
  parsePlanningAlternativeCommand,
  parsePlanningProjection,
  PlanningProjectionValidationError,
  type PlanningAlternativeCommandV1,
  type PlanningProjectionV1,
} from "@zugfolge/planning-projection";
import { eraseAccountData, exportAccountData, PersonalDataNotFoundError } from "@zugfolge/privacy";
import type { OperatingRuntime } from "@zugfolge/runtime-native";
import { and, asc, desc, eq } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

import { createAuthenticator, type TokenVerifier } from "./auth.js";

export interface AppDependencies {
  readonly db: IdentityDatabase;
  readonly verifyToken: TokenVerifier;
  /**
   * Zusätzliche Prüfungen für `/health/ready`, über die Datenbankverbindung
   * hinaus — der Erweiterungspunkt, an dem künftige Milestones ihre eigenen
   * Health Checks anmelden, statt sie später nachzuziehen.
   */
  readonly extraHealthChecks?: readonly HealthCheck[];
  /** Öffentlicher, weltisolierter Livemap-Fanout (M4.6). */
  readonly livemap?: LivemapRegistry;
  /** Authentifizierter, je EVU getrennter Betriebsereignis-Fanout (M7.5/M7.6). */
  readonly operations?: OperationsRegistry;
  /** Geteiltes Geheimnis des internen Simulations-zu-Livemap-Adapters. */
  readonly livemapIngestToken?: string;
  /** Geteiltes Geheimnis des Simulations-Eventlog-Adapters. */
  readonly simulationIngestToken?: string;
  /** Geteiltes Geheimnis des kanonischen M5-Single-Writer-Snapshot-Adapters. */
  readonly fleetIngestToken?: string;
  /** Fail-closed Rust-Verifikation fuer jeden eingehenden M5-Snapshot. */
  readonly verifyFleetMobilizationSnapshot?: OperatingRuntime["verifyFleetMobilizationSnapshot"];
  /** Hartes Zeitbudget jedes Readiness-Checks. */
  readonly healthCheckTimeoutMs?: number;
  /** Produktion protokolliert strukturiert; Tests dürfen den Logger abschalten. */
  readonly logger?: boolean;
}

const worldIdParam = {
  type: "object",
  required: ["worldId"],
  properties: { worldId: { type: "string", format: "uuid" } },
} as const;

const operatorIdParam = {
  type: "object",
  required: ["worldId", "operatorId"],
  properties: {
    worldId: { type: "string", format: "uuid" },
    operatorId: { type: "string", format: "uuid" },
  },
} as const;

const cents = { type: "string", pattern: "^-?[0-9]+$" } as const;

async function requireOperatorOwner(
  db: IdentityDatabase,
  worldId: string,
  operatorId: string,
  keycloakSubject: string,
): Promise<void> {
  const operator = await getOperator(db, { worldId, operatorId });
  const account = await getAccount(db, { worldId, keycloakSubject });
  if (account === undefined || account.id !== operator.foundingAccountId) {
    throw new AuthorizationError(`Nur das gründende Konto führt die Bücher von EVU '${operatorId}'.`);
  }
}

async function requireWorldAdminAccount(db: IdentityDatabase, worldId: string, keycloakSubject: string): Promise<void> {
  const account = await getAccount(db, { worldId, keycloakSubject });
  if (account === undefined || !account.roles.includes("world_admin")) {
    throw new AuthorizationError(`Konto ist kein Weltverwalter von '${worldId}'.`);
  }
}

async function resolveKeycloakSubject(db: IdentityDatabase, worldId: string, accountId: string): Promise<string> {
  const [row] = await db
    .select({ keycloakSubject: accounts.keycloakSubject })
    .from(accounts)
    .where(and(eq(accounts.worldId, worldId), eq(accounts.id, accountId)))
    .limit(1);
  if (row === undefined) {
    throw new AccountNotFoundError(accountId, worldId);
  }
  return row.keycloakSubject;
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (
    error instanceof AccessRevokedError ||
    error instanceof AuthorizationError ||
    error instanceof NoAccountInWorldError ||
    error instanceof ForeignLedgerAccountError
  ) {
    return reply.code(403).send({ error: error.message });
  }
  if (
    error instanceof AccountNotFoundError ||
    error instanceof OperatorNotFoundError ||
    error instanceof RecipientNotFoundError ||
    error instanceof MessageNotFoundError ||
    error instanceof PersonalDataNotFoundError
  ) {
    return reply.code(404).send({ error: error.message });
  }
  if (error instanceof DuplicateOperatorNameError || error instanceof DuplicateLedgerAccountNameError || error instanceof EventSequenceError || error instanceof EconomyStateConflictError) {
    return reply.code(409).send({ error: error.message });
  }
  if (error instanceof IncompleteTransactionError || error instanceof UnbalancedTransactionError || error instanceof FleetSnapshotValidationError) {
    return reply.code(400).send({ error: error.message });
  }
  if (error instanceof ProgramValidationError || error instanceof RangeError) {
    return reply.code(400).send({ error: error.message });
  }
  throw error;
}

function sendEconomyError(reply: FastifyReply, error: unknown): FastifyReply {
  if (
    error instanceof AccessRevokedError
    || error instanceof AuthorizationError
    || error instanceof NoAccountInWorldError
    || error instanceof AccountNotFoundError
    || error instanceof OperatorNotFoundError
    || error instanceof EconomyStateConflictError
    || error instanceof FleetSnapshotValidationError
  ) return sendError(reply, error);
  if (error instanceof Error) return reply.code(400).send({ error: error.message });
  throw error;
}

function requireExpectedRevision(worldId: string, actual: number, expected: number): void {
  if (actual !== expected) throw new EconomyStateConflictError(worldId, expected);
}

function decoded<T>(value: unknown): T {
  return decodeEconomyValue(value) as T;
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function worldExists(db: IdentityDatabase, worldId: string): Promise<boolean> {
  const [world] = await db
    .select({ id: worlds.id })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);
  return world !== undefined;
}

const PLANNING_APPLY_ALTERNATIVE_SCHEMA = "planning-apply-alternative/v1" as const;

interface PlanningApplyAlternativePayload {
  readonly schemaVersion: typeof PLANNING_APPLY_ALTERNATIVE_SCHEMA;
  readonly projectionRevision: number;
  readonly alternativeId: string;
  readonly conflictId: string;
  readonly trainId: string;
  readonly departureShiftS: number;
}

function planningProjectionForWorld(
  payload: unknown,
  worldId: string,
): { readonly projection?: PlanningProjectionV1; readonly error?: string } {
  try {
    const projection = parsePlanningProjection(payload);
    if (projection.worldId !== worldId) {
      return { error: "Planner-Projektion gehört nicht zur angefragten Welt." };
    }
    return { projection };
  } catch (error) {
    if (error instanceof PlanningProjectionValidationError) {
      return { error: "Planner-Projektion hat ein ungültiges Format." };
    }
    throw error;
  }
}

function isSamePlanningApplyAlternativePayload(
  value: unknown,
  expected: PlanningApplyAlternativePayload,
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "projectionRevision",
    "alternativeId",
    "conflictId",
    "trainId",
    "departureShiftS",
  ] as const;
  return Object.keys(payload).length === keys.length
    && keys.every((key) => payload[key] === expected[key]);
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? process.env["NODE_ENV"] !== "test",
    // Unbekannte Felder nicht still entfernen: Ein manipulierter Client soll
    // eine sichtbare 400-Antwort erhalten, statt den Eindruck zu gewinnen,
    // technische Ausschreibungswerte erfolgreich gesetzt zu haben.
    ajv: { customOptions: { removeAdditional: false } },
  });
  const authenticate = createAuthenticator(deps.verifyToken);
  const operations = deps.operations ?? new OperationsRegistry();

  // `/health` ist Liveness: läuft der Prozess, ohne jede Abhängigkeit zu
  // prüfen. `/health/ready` ist Readiness für Status- und Monitoringdienste:
  // sie fragt die Registry, die sich aus der Datenbankprüfung und den
  // Erweiterungen jedes weiteren Milestones zusammensetzt (M9.5 baut darauf
  // auf, nicht darauf um).
  const healthChecks: readonly HealthCheck[] = [createDatabaseHealthCheck(deps.db), ...(deps.extraHealthChecks ?? [])];

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    const report = await runHealthChecks(healthChecks, {
      timeoutMs: deps.healthCheckTimeoutMs ?? 2_000,
      onError: (healthCheck, error) => {
        app.log.error({ err: error, healthCheck }, "Readiness-Prüfung fehlgeschlagen");
      },
    });
    return reply.code(report.status === "down" ? 503 : 200).send(report);
  });

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/economy/state",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        const account = await getAccount(deps.db, {
          worldId: request.params.worldId,
          keycloakSubject: identity.keycloakSubject,
        });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Zugang zu dieser Welt.");
        const state = await loadEconomyWorldState(deps.db, request.params.worldId);
        if (state === undefined) return reply.code(404).send({ error: "Wirtschaftswelt ist noch nicht gestartet." });
        return reply.send(encodeEconomyValue(state));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string };
    Body: {
      readonly at: number;
      readonly seed: string;
      readonly durationMonths: 6 | 12 | 18 | "unlimited";
      readonly release: unknown;
      readonly planning: unknown;
      readonly authorityBudgets: unknown;
    };
  }>(
    "/worlds/:worldId/economy/start",
    {
      preHandler: authenticate,
      schema: {
        params: worldIdParam,
        body: {
          type: "object",
          required: ["at", "seed", "durationMonths", "release", "planning", "authorityBudgets"],
          additionalProperties: false,
          properties: {
            at: { type: "integer", minimum: 0 },
            seed: { type: "string", pattern: "^[0-9]+$" },
            durationMonths: { anyOf: [{ type: "integer", enum: [6, 12, 18] }, { type: "string", const: "unlimited" }] },
            release: { type: "object" },
            planning: { type: "object" },
            authorityBudgets: { type: "array" },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireWorldAdminAccount(deps.db, request.params.worldId, identity.keycloakSubject);
        if (await loadEconomyWorldState(deps.db, request.params.worldId)) return reply.code(409).send({ error: "Wirtschaftswelt wurde bereits gestartet." });
        const suppliedRelease = decoded<EconomyRelease>(request.body.release);
        const release = buildEconomyRelease({
          version: suppliedRelease.version,
          rates: suppliedRelease.rates,
          rules: suppliedRelease.rules,
          tenderProfiles: suppliedRelease.tenderProfiles,
        });
        if (release.checksum !== suppliedRelease.checksum) throw new Error("EconomyRelease-Prüfsumme ist ungültig.");
        const accountsInWorld = await listAccountsInWorld(deps.db, { worldId: request.params.worldId, requestingKeycloakSubject: identity.keycloakSubject });
        const started = startEconomyWorld({
          worldId: request.params.worldId,
          seed: BigInt(request.body.seed),
          durationMonths: request.body.durationMonths,
          release,
          planning: decoded<GtfsPlanningEnvelope>(request.body.planning),
          authorityBudgets: decoded<readonly AuthorityBudget[]>(request.body.authorityBudgets),
          accounts: accountsInWorld.map((account) => account.id),
        });
        await persistEconomyTransition(deps.db, { expectedRevision: null, ...started, committedAt: new Date(request.body.at * 1_000) });
        return reply.code(201).send(encodeEconomyValue(started.state));
      } catch (error) {
        return sendEconomyError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string };
    Body: {
      readonly expectedRevision: number;
      readonly commandId: string;
      readonly tenderId: string;
      readonly planningReference: GtfsPlanningLotReference;
      readonly announcedAt: number;
      readonly opensAt: number;
      readonly closesAt: number;
      readonly operatingFrom: number;
      readonly authorityId: string;
      readonly budgetPeriod: number;
      readonly vehiclePool: readonly string[];
      readonly failurePenaltyCents: string;
    };
  }>(
    "/worlds/:worldId/economy/tenders",
    {
      preHandler: authenticate,
      schema: {
        params: worldIdParam,
        body: {
          type: "object",
          required: ["expectedRevision", "commandId", "tenderId", "planningReference", "announcedAt", "opensAt", "closesAt", "operatingFrom", "authorityId", "budgetPeriod", "vehiclePool", "failurePenaltyCents"],
          additionalProperties: false,
          properties: {
            expectedRevision: { type: "integer", minimum: 0 },
            commandId: { type: "string", minLength: 1, maxLength: 128 },
            tenderId: { type: "string", minLength: 1, maxLength: 128 },
            planningReference: {
              type: "object",
              required: ["planningRevision", "snapshotHash", "lotId"],
              additionalProperties: false,
              properties: {
                planningRevision: { type: "integer", minimum: 0 },
                snapshotHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
                lotId: { type: "string", minLength: 1 },
              },
            },
            announcedAt: { type: "integer", minimum: 0 },
            opensAt: { type: "integer", minimum: 0 },
            closesAt: { type: "integer", minimum: 0 },
            operatingFrom: { type: "integer", minimum: 0 },
            authorityId: { type: "string", minLength: 1 },
            budgetPeriod: { type: "integer", minimum: 0 },
            vehiclePool: { type: "array", items: { type: "string", minLength: 1 } },
            failurePenaltyCents: { type: "string", pattern: "^[0-9]+$" },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireWorldAdminAccount(deps.db, request.params.worldId, identity.keycloakSubject);
        const state = await loadEconomyWorldState(deps.db, request.params.worldId);
        if (state === undefined) return reply.code(404).send({ error: "Wirtschaftswelt ist noch nicht gestartet." });
        requireExpectedRevision(request.params.worldId, state.revision, request.body.expectedRevision);
        if (state.planning === undefined) throw new Error("Wirtschaftswelt besitzt keinen GTFS-Planungssnapshot.");
        const periodDurationSeconds = state.profile.periodWeeks * 7 * 86_400;
        const planned = deriveGtfsServiceSpecification(
          state.planning,
          request.params.worldId,
          request.body.planningReference,
          periodDurationSeconds,
        );
        const incumbent = [...state.contracts.values()]
          .filter((contract) => contract.lotId === planned.lot.id)
          .sort((left, right) => right.endsAt - left.endsAt)[0]?.operatorId ?? "public";
        const operatorsInWorld = await listOperatorsInWorld(deps.db, { worldId: request.params.worldId, requestingKeycloakSubject: identity.keycloakSubject });
        const recipientByOperator = Object.fromEntries(operatorsInWorld.map((operator) => [operator.id, operator.foundingAccountId]));
        const recipients = (await listAccountsInWorld(deps.db, { worldId: request.params.worldId, requestingKeycloakSubject: identity.keycloakSubject })).map((account) => account.id);
        const announced = announceTender(state, {
          commandId: request.body.commandId,
          release: state.release,
          recipients,
          tender: {
            id: request.body.tenderId,
            worldId: request.params.worldId,
            lotId: planned.lot.id,
            incumbentOperatorId: incumbent,
            specification: planned.specification,
            planningEvidence: planned.evidence,
            announcedAt: request.body.announcedAt,
            opensAt: request.body.opensAt,
            closesAt: request.body.closesAt,
            operatingFrom: request.body.operatingFrom,
            contractPeriods: state.profile.contractPeriods,
            periodDurationSeconds,
            smallLot: planned.lot.smallLot,
          },
          automation: {
            authorityId: request.body.authorityId,
            budgetPeriod: request.body.budgetPeriod,
            vehiclePool: request.body.vehiclePool,
            recipientByOperator,
            failurePenaltyCents: BigInt(request.body.failurePenaltyCents),
          },
        });
        await persistEconomyTransition(deps.db, { expectedRevision: state.revision, ...announced, committedAt: new Date(request.body.announcedAt * 1_000) });
        return reply.code(201).send(encodeEconomyValue(announced.state));
      } catch (error) {
        return sendEconomyError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string; tenderId: string; operatorId: string };
    Body: {
      readonly expectedRevision: number;
      readonly commandId: string;
      readonly bidId: string;
      readonly orderingFeeCentsPerTrainKm: string;
      readonly submittedAt: number;
      readonly vehicleReference: { readonly fleetRevision: number; readonly snapshotHash: string; readonly formationId: string };
      readonly promises: { readonly extraSeats: number; readonly punctualityBasisPoints: number; readonly additionalStops: number };
    };
  }>(
    "/worlds/:worldId/economy/tenders/:tenderId/operators/:operatorId/bids",
    { preHandler: authenticate, schema: { params: { type: "object", required: ["worldId", "tenderId", "operatorId"], properties: { worldId: { type: "string", format: "uuid" }, tenderId: { type: "string", minLength: 1 }, operatorId: { type: "string", format: "uuid" } } }, body: { type: "object", required: ["expectedRevision", "commandId", "bidId", "orderingFeeCentsPerTrainKm", "submittedAt", "vehicleReference", "promises"], additionalProperties: false, properties: { expectedRevision: { type: "integer", minimum: 0 }, commandId: { type: "string", minLength: 1 }, bidId: { type: "string", minLength: 1 }, orderingFeeCentsPerTrainKm: { type: "string", pattern: "^[0-9]+$" }, submittedAt: { type: "integer", minimum: 0 }, vehicleReference: { type: "object", required: ["fleetRevision", "snapshotHash", "formationId"], additionalProperties: false, properties: { fleetRevision: { type: "integer", minimum: 0 }, snapshotHash: { type: "string", pattern: "^[a-f0-9]{64}$" }, formationId: { type: "string", minLength: 1 } } }, promises: { type: "object", required: ["extraSeats", "punctualityBasisPoints", "additionalStops"], additionalProperties: false, properties: { extraSeats: { type: "integer", minimum: 0 }, punctualityBasisPoints: { type: "integer", minimum: 0, maximum: 10000 }, additionalStops: { type: "integer", minimum: 0 } } } } } } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const state = await loadEconomyWorldState(deps.db, request.params.worldId);
        if (state === undefined) return reply.code(404).send({ error: "Wirtschaftswelt ist noch nicht gestartet." });
        requireExpectedRevision(request.params.worldId, state.revision, request.body.expectedRevision);
        const lifecycle = state.tenders.get(request.params.tenderId);
        if (lifecycle === undefined) return reply.code(404).send({ error: "Ausschreibung existiert nicht." });
        const snapshot = await loadFleetMobilizationSnapshot(deps.db, request.params.worldId, request.body.vehicleReference);
        const vehicle = resolveVehicleConcept(snapshot, request.body.vehicleReference, { operatorId: request.params.operatorId, serviceLineIds: lifecycle.tender.specification.lines, operatingFrom: lifecycle.tender.operatingFrom });
        const account = await getAccount(deps.db, { worldId: request.params.worldId, keycloakSubject: identity.keycloakSubject });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Weltzugang.");
        const smallLot = lifecycle.tender.closesAt - lifecycle.tender.opensAt <= 2 * 86_400;
        const next = submitBid(state, request.body.commandId, request.params.tenderId, { id: request.body.bidId, operatorId: request.params.operatorId, orderingFeeCentsPerTrainKm: BigInt(request.body.orderingFeeCentsPerTrainKm), vehicle, promises: request.body.promises, submittedAt: request.body.submittedAt }, { accountId: account.id, period: Math.floor(request.body.submittedAt / (state.profile.periodWeeks * 7 * 86_400)), smallLot, minimumScore: 4_000 });
        await persistEconomyTransition(deps.db, { expectedRevision: state.revision, state: next, effects: { notices: [], journal: [] }, committedAt: new Date(request.body.submittedAt * 1_000) });
        return reply.code(201).send(encodeEconomyValue(next));
      } catch (error) {
        return sendEconomyError(reply, error);
      }
    },
  );

  app.put<{
    Params: { worldId: string; tenderId: string; operatorId: string };
    Body: { readonly expectedRevision: number; readonly commandId: string; readonly at: number; readonly reference: FleetMobilizationReference };
  }>(
    "/worlds/:worldId/economy/tenders/:tenderId/operators/:operatorId/mobilization",
    { preHandler: authenticate, schema: { params: { type: "object", required: ["worldId", "tenderId", "operatorId"], properties: { worldId: { type: "string", format: "uuid" }, tenderId: { type: "string", minLength: 1 }, operatorId: { type: "string", format: "uuid" } } }, body: { type: "object", required: ["expectedRevision", "commandId", "at", "reference"], additionalProperties: false, properties: { expectedRevision: { type: "integer", minimum: 0 }, commandId: { type: "string", minLength: 1 }, at: { type: "integer", minimum: 0 }, reference: { type: "object", required: ["fleetRevision", "snapshotHash", "formationIds", "personnelDutyIds", "pathReservationIds"], additionalProperties: false, properties: { fleetRevision: { type: "integer", minimum: 0 }, snapshotHash: { type: "string", pattern: "^[a-f0-9]{64}$" }, formationIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, personnelDutyIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, pathReservationIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } } } } } } } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const state = await loadEconomyWorldState(deps.db, request.params.worldId);
        if (state === undefined) return reply.code(404).send({ error: "Wirtschaftswelt ist noch nicht gestartet." });
        requireExpectedRevision(request.params.worldId, state.revision, request.body.expectedRevision);
        const lifecycle = state.tenders.get(request.params.tenderId);
        if (lifecycle?.phase !== "awarded") throw new Error("Ausschreibung wurde diesem EVU nicht zugeschlagen.");
        const snapshot = await loadFleetMobilizationSnapshot(deps.db, request.params.worldId, request.body.reference);
        verifyMobilizationReference(snapshot, request.body.reference, { operatorId: request.params.operatorId, winningFormationId: lifecycle.winningBid.vehicle.formationId, serviceLineIds: lifecycle.tender.specification.lines, operatingFrom: lifecycle.tender.operatingFrom });
        const next = submitMobilizationReference(state, { commandId: request.body.commandId, tenderId: request.params.tenderId, operatorId: request.params.operatorId, at: request.body.at, reference: request.body.reference });
        await persistEconomyTransition(deps.db, { expectedRevision: state.revision, state: next, effects: { notices: [], journal: [] }, committedAt: new Date(request.body.at * 1_000) });
        return reply.send(encodeEconomyValue(next));
      } catch (error) {
        return sendEconomyError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string; operatorId: string; contractId: string };
    Body: { readonly expectedRevision: number; readonly commandId: string; readonly period: number; readonly at: number; readonly performance: { readonly trainKm: string; readonly punctualityBasisPoints: number; readonly cancellations: number; readonly missingSeats: number; readonly missedConnections: number; readonly evidence: readonly string[] }; readonly costs: readonly { readonly amountCents: string; readonly costType: "track" | "station" | "facility" | "energy" | "personnel" | "administration" | "vehicle" | "penalty" | "interest"; readonly costCentreId: string; readonly reference: string }[] };
  }>(
    "/worlds/:worldId/economy/operators/:operatorId/contracts/:contractId/settlements",
    { preHandler: authenticate, schema: { params: { type: "object", required: ["worldId", "operatorId", "contractId"], properties: { worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" }, contractId: { type: "string", minLength: 1 } } }, body: { type: "object", required: ["expectedRevision", "commandId", "period", "at", "performance", "costs"], additionalProperties: false, properties: { expectedRevision: { type: "integer", minimum: 0 }, commandId: { type: "string", minLength: 1 }, period: { type: "integer", minimum: 0 }, at: { type: "integer", minimum: 0 }, performance: { type: "object" }, costs: { type: "array", items: { type: "object" } } } } } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const state = await loadEconomyWorldState(deps.db, request.params.worldId);
        if (state === undefined) return reply.code(404).send({ error: "Wirtschaftswelt ist noch nicht gestartet." });
        requireExpectedRevision(request.params.worldId, state.revision, request.body.expectedRevision);
        if (state.contracts.get(request.params.contractId)?.operatorId !== request.params.operatorId) throw new AuthorizationError("Vertrag gehört einem anderen EVU.");
        const settled = settleContractPeriod(state, { commandId: request.body.commandId, contractId: request.params.contractId, period: request.body.period, at: request.body.at, performance: { ...request.body.performance, trainKm: BigInt(request.body.performance.trainKm) }, costs: request.body.costs.map((cost) => ({ ...cost, amountCents: BigInt(cost.amountCents) })) });
        await persistEconomyTransition(deps.db, { expectedRevision: state.revision, state: settled.state, effects: settled.effects, committedAt: new Date(request.body.at * 1_000) });
        return reply.code(201).send(encodeEconomyValue(settled.result));
      } catch (error) {
        return sendEconomyError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string; operatorId: string };
    Body: { readonly expectedRevision: number; readonly commandId: string; readonly accountId: string; readonly period: number; readonly at: number; readonly signals: { readonly liquidCents: string; readonly twoPeriodNeedCents: string; readonly overdueCents: string; readonly creditScore: number; readonly contractTerminated: boolean; readonly unableToPay: boolean } };
  }>(
    "/worlds/:worldId/economy/operators/:operatorId/escalations",
    { preHandler: authenticate, schema: { params: { type: "object", required: ["worldId", "operatorId"], properties: { worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" } } }, body: { type: "object", required: ["expectedRevision", "commandId", "accountId", "period", "at", "signals"], additionalProperties: false, properties: { expectedRevision: { type: "integer", minimum: 0 }, commandId: { type: "string", minLength: 1 }, accountId: { type: "string", format: "uuid" }, period: { type: "integer", minimum: 0 }, at: { type: "integer", minimum: 0 }, signals: { type: "object" } } } } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireWorldAdminAccount(deps.db, request.params.worldId, identity.keycloakSubject);
        const state = await loadEconomyWorldState(deps.db, request.params.worldId);
        if (state === undefined) return reply.code(404).send({ error: "Wirtschaftswelt ist noch nicht gestartet." });
        requireExpectedRevision(request.params.worldId, state.revision, request.body.expectedRevision);
        const escalated = escalateOperator(state, { commandId: request.body.commandId, operatorId: request.params.operatorId, accountId: request.body.accountId, period: request.body.period, at: request.body.at, signals: { ...request.body.signals, liquidCents: BigInt(request.body.signals.liquidCents), twoPeriodNeedCents: BigInt(request.body.signals.twoPeriodNeedCents), overdueCents: BigInt(request.body.signals.overdueCents) } });
        await persistEconomyTransition(deps.db, { expectedRevision: state.revision, state: escalated.state, effects: escalated.effects, committedAt: new Date(request.body.at * 1_000) });
        return reply.send(encodeEconomyValue(escalated.decision));
      } catch (error) {
        return sendEconomyError(reply, error);
      }
    },
  );

  if (deps.livemap !== undefined && deps.livemapIngestToken !== undefined) {
    app.post<{
      Params: { worldId: string };
      Body: Omit<LiveDelta, "worldId" | "sequence">;
    }>(
      "/internal/worlds/:worldId/livemap/deltas",
      {
        schema: {
          params: worldIdParam,
          body: {
            type: "object",
            required: ["at", "changed", "removed"],
            additionalProperties: false,
            properties: {
              at: { type: "integer", minimum: 0 },
              removed: { type: "array", items: { type: "string", minLength: 1 } },
              changed: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "operator", "trainNumber", "category", "positionMm", "speedMmPerSecond", "delaySeconds", "nextOperatingPoint", "status"],
                  additionalProperties: false,
                  properties: {
                    id: { type: "string", minLength: 1 },
                    operator: { type: "string" },
                    trainNumber: { type: "string" },
                    category: { type: "string" },
                    positionMm: { type: "integer" },
                    speedMmPerSecond: { type: "integer" },
                    delaySeconds: { type: "integer" },
                    nextOperatingPoint: { type: "string" },
                    status: { type: "string", minLength: 1 },
                  },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        if (!bearerMatches(request.headers.authorization, deps.livemapIngestToken!)) {
          return reply.code(401).send({ error: "Ungültige Livemap-Ingest-Autorisierung." });
        }
        if (!(await worldExists(deps.db, request.params.worldId))) {
          return reply.code(404).send({ error: "Welt existiert nicht." });
        }
        try {
          return reply.code(202).send(deps.livemap!.forWorld(request.params.worldId).publish(request.body));
        } catch (error) {
          if (error instanceof LivemapCapacityError) return reply.code(503).send({ error: "Livemap-Kapazität erschöpft." });
          throw error;
        }
      },
    );
  }

  if (deps.fleetIngestToken !== undefined) {
    app.post<{
      Params: { worldId: string };
      Body: Parameters<typeof persistFleetMobilizationSnapshot>[2];
    }>(
      "/internal/worlds/:worldId/fleet/mobilization-snapshots",
      {
        schema: {
          params: worldIdParam,
          body: {
            type: "object",
            required: ["snapshot", "snapshotHash"],
            additionalProperties: false,
            properties: {
              snapshotHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
              snapshot: {
                type: "object",
                required: ["schema", "worldId", "revision", "producedAt", "formations", "personnelDuties", "pathReservations"],
                additionalProperties: false,
                properties: {
                  schema: { type: "string", const: "zugfolge-fleet-mobilization/v1" },
                  worldId: { type: "string", format: "uuid" },
                  revision: { type: "integer", minimum: 0 },
                  producedAt: { type: "integer", minimum: 0 },
                  formations: { type: "array", items: { type: "object" } },
                  personnelDuties: { type: "array", items: { type: "object" } },
                  pathReservations: { type: "array", items: { type: "object" } },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        if (!bearerMatches(request.headers.authorization, deps.fleetIngestToken!)) {
          return reply.code(401).send({ error: "Ungültige Fleet-Ingest-Autorisierung." });
        }
        if (!(await worldExists(deps.db, request.params.worldId))) {
          return reply.code(404).send({ error: "Welt existiert nicht." });
        }
        if (deps.verifyFleetMobilizationSnapshot === undefined) {
          return reply.code(503).send({ error: "Native M5-Snapshot-Verifikation ist nicht verfuegbar." });
        }
        try {
          const verified = deps.verifyFleetMobilizationSnapshot(request.body.snapshot);
          if (
            verified.worldId !== request.params.worldId
            || verified.fleetRevision !== request.body.snapshot.revision
            || verified.snapshotHash !== request.body.snapshotHash
          ) {
            throw new FleetSnapshotValidationError(
              "Rust-verifizierter M5-Snapshot stimmt nicht mit Welt, Revision und Snapshothash ueberein.",
            );
          }
          const result = await persistFleetMobilizationSnapshot(
            deps.db,
            request.params.worldId,
            request.body,
            new Date(),
          );
          return reply.code(result.created ? 201 : 200).send(result);
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );
  }

  if (deps.simulationIngestToken !== undefined) {
    app.post<{
      Params: { worldId: string };
      Body: { readonly events: readonly { readonly sequence: number; readonly eventType: string; readonly payload: unknown; readonly occurredAt: string }[] };
    }>(
      "/internal/worlds/:worldId/simulation/events",
      {
        schema: {
          params: worldIdParam,
          body: {
            type: "object",
            required: ["events"],
            additionalProperties: false,
            properties: {
              events: {
                type: "array",
                minItems: 1,
                maxItems: 1_000,
                items: {
                  type: "object",
                  required: ["sequence", "eventType", "payload", "occurredAt"],
                  additionalProperties: false,
                  properties: {
                    sequence: { type: "integer", minimum: 1 },
                    eventType: { type: "string", minLength: 1, maxLength: 128 },
                    payload: {},
                    occurredAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        if (!bearerMatches(request.headers.authorization, deps.simulationIngestToken!)) {
          return reply.code(401).send({ error: "Ungültige Simulations-Ingest-Autorisierung." });
        }
        if (!(await worldExists(deps.db, request.params.worldId))) return reply.code(404).send({ error: "Welt existiert nicht." });
        try {
          const appended = await worldEventLog(deps.db, request.params.worldId).appendBatch(
            request.body.events.map((event) => ({ ...event, occurredAt: new Date(event.occurredAt) })),
          );
          for (const event of appended) {
            const eventPayload = event.payload as Record<string, unknown>;
            const operatorId = typeof eventPayload?.operatorId === "string"
              ? eventPayload.operatorId
              : typeof eventPayload?.operator_id === "string"
                ? eventPayload.operator_id
                : undefined;
            if (operatorId === undefined) continue;
            const projected = projectOperations([event], operatorId).decisions[0];
            if (projected !== undefined) {
              operations.forOperator(request.params.worldId, operatorId).publish({
                worldId: request.params.worldId,
                operatorId,
                sequence: event.sequence,
                decision: projected,
              });
            }
          }
          return reply.code(202).send({ appended: appended.length, lastSequence: appended.at(-1)?.sequence });
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );
  }

  app.get<{ Params: { worldId: string }; Querystring: { after?: number; limit?: number } }>(
    "/worlds/:worldId/simulation/events",
    {
      preHandler: authenticate,
      schema: {
        params: worldIdParam,
        querystring: {
          type: "object",
          properties: {
            after: { type: "integer", minimum: 0, default: 0 },
            limit: { type: "integer", minimum: 1, maximum: 5_000, default: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        const account = await getAccount(deps.db, { worldId: request.params.worldId, keycloakSubject: identity.keycloakSubject });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Zugang zu dieser Welt.");
        return reply.send(
          await worldEventLog(deps.db, request.params.worldId).listAfter(
            request.query.after ?? 0,
            request.query.limit ?? 500,
          ),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/planning/diagram",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        const account = await getAccount(deps.db, { worldId: request.params.worldId, keycloakSubject: identity.keycloakSubject });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Zugang zu dieser Welt.");
        const event = await worldEventLog(deps.db, request.params.worldId).latestOfType("planning.diagram");
        if (event === undefined) return reply.code(404).send({ error: "Noch kein Planner-Ergebnis veröffentlicht." });
        const parsed = planningProjectionForWorld(event.payload, request.params.worldId);
        if (parsed.projection === undefined) return reply.code(503).send({ error: parsed.error });
        return reply.send({ sequence: event.sequence, data: parsed.projection });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string };
    Body: PlanningAlternativeCommandV1;
  }>(
    "/worlds/:worldId/planning/alternatives",
    {
      preHandler: authenticate,
      schema: {
        params: worldIdParam,
        body: {
          type: "object",
          required: ["schemaVersion", "projectionRevision", "alternativeId", "idempotencyKey"],
          additionalProperties: false,
          properties: {
            schemaVersion: { const: "planning-alternative-command/v1" },
            projectionRevision: { type: "integer", minimum: 0 },
            alternativeId: { type: "string", minLength: 1, maxLength: 64 },
            idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        let requested: PlanningAlternativeCommandV1;
        try {
          requested = parsePlanningAlternativeCommand(request.body);
        } catch (error) {
          if (error instanceof PlanningProjectionValidationError) {
            return reply.code(400).send({ error: error.message });
          }
          throw error;
        }
        const account = await getAccount(deps.db, { worldId: request.params.worldId, keycloakSubject: identity.keycloakSubject });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Zugang zu dieser Welt.");
        const event = await worldEventLog(deps.db, request.params.worldId).latestOfType("planning.diagram");
        if (event === undefined) return reply.code(404).send({ error: "Noch kein Planner-Ergebnis veröffentlicht." });
        const parsed = planningProjectionForWorld(event.payload, request.params.worldId);
        if (parsed.projection === undefined) return reply.code(503).send({ error: parsed.error });
        const projection = parsed.projection;
        if (projection.projectionRevision !== requested.projectionRevision) {
          return reply.code(409).send({
            error: `Planner-Projektion ist nicht mehr aktuell: erwartet Revision ${projection.projectionRevision}, erhielt ${requested.projectionRevision}.`,
          });
        }
        const offered = projection.conflicts
          .map((conflict) => ({ conflict, alternative: conflict.alternative }))
          .find(({ alternative }) => alternative?.alternativeId === requested.alternativeId);
        if (offered?.alternative === null || offered?.alternative === undefined) {
          return reply.code(404).send({ error: "Alternative wird von der aktuellen Planner-Projektion nicht angeboten." });
        }
        const payload: PlanningApplyAlternativePayload = {
          schemaVersion: PLANNING_APPLY_ALTERNATIVE_SCHEMA,
          projectionRevision: projection.projectionRevision,
          alternativeId: offered.alternative.alternativeId,
          conflictId: offered.conflict.id,
          trainId: offered.alternative.trainId,
          departureShiftS: offered.alternative.departureShiftS,
        };
        const values = {
          worldId: request.params.worldId,
          requestingAccountId: account.id,
          idempotencyKey: requested.idempotencyKey,
          commandType: "planning.apply-alternative",
          payload,
          submittedAt: new Date(),
        };
        let [command] = await deps.db
          .insert(simulationCommands)
          .values(values)
          .onConflictDoNothing({ target: [simulationCommands.worldId, simulationCommands.requestingAccountId, simulationCommands.idempotencyKey] })
          .returning();
        if (command === undefined) {
          [command] = await deps.db
            .select()
            .from(simulationCommands)
            .where(and(eq(simulationCommands.worldId, request.params.worldId), eq(simulationCommands.requestingAccountId, account.id), eq(simulationCommands.idempotencyKey, requested.idempotencyKey)))
            .limit(1);
        }
        if (command === undefined
          || command.commandType !== values.commandType
          || !isSamePlanningApplyAlternativePayload(command.payload, payload)) {
          return reply.code(409).send({ error: "Idempotenzkennung ist bereits mit einem anderen Planner-Kommando belegt." });
        }
        return reply.code(202).send(command);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  if (deps.simulationIngestToken !== undefined) {
    app.get<{ Params: { worldId: string }; Querystring: { limit?: number } }>(
      "/internal/worlds/:worldId/simulation/commands",
      {
        schema: {
          params: worldIdParam,
          querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 1_000, default: 100 } } },
        },
      },
      async (request, reply) => {
        if (!bearerMatches(request.headers.authorization, deps.simulationIngestToken!)) return reply.code(401).send({ error: "Ungültige Simulations-Ingest-Autorisierung." });
        return reply.send(
          await deps.db
            .select()
            .from(simulationCommands)
            .where(and(eq(simulationCommands.worldId, request.params.worldId), eq(simulationCommands.status, "pending")))
            .orderBy(asc(simulationCommands.submittedAt), asc(simulationCommands.id))
            .limit(request.query.limit ?? 100),
        );
      },
    );

    app.post<{
      Params: { worldId: string; commandId: string };
      Body: { readonly status: "processed" | "failed"; readonly resultEventSequence?: number; readonly failureCode?: string; readonly processedAt: string };
    }>(
      "/internal/worlds/:worldId/simulation/commands/:commandId/result",
      {
        schema: {
          params: { type: "object", required: ["worldId", "commandId"], properties: { worldId: { type: "string", format: "uuid" }, commandId: { type: "string", format: "uuid" } } },
          body: {
            type: "object",
            required: ["status", "processedAt"],
            additionalProperties: false,
            properties: {
              status: { type: "string", enum: ["processed", "failed"] },
              resultEventSequence: { type: "integer", minimum: 1 },
              failureCode: { type: "string", minLength: 1, maxLength: 128 },
              processedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
      async (request, reply) => {
        if (!bearerMatches(request.headers.authorization, deps.simulationIngestToken!)) return reply.code(401).send({ error: "Ungültige Simulations-Ingest-Autorisierung." });
        if (request.body.status === "processed" && request.body.resultEventSequence === undefined) return reply.code(400).send({ error: "Erfolgreiches Kommando braucht eine Ergebnis-Sequenz." });
        if (request.body.status === "failed" && request.body.failureCode === undefined) return reply.code(400).send({ error: "Fehlgeschlagenes Kommando braucht einen stabilen Fehlercode." });
        const [updated] = await deps.db
          .update(simulationCommands)
          .set({ status: request.body.status, processedAt: new Date(request.body.processedAt), resultEventSequence: request.body.resultEventSequence, failureCode: request.body.failureCode })
          .where(and(eq(simulationCommands.worldId, request.params.worldId), eq(simulationCommands.id, request.params.commandId), eq(simulationCommands.status, "pending")))
          .returning();
        return updated === undefined ? reply.code(404).send({ error: "Ausstehendes Kommando nicht gefunden." }) : reply.send(updated);
      },
    );
  }

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/livemap/snapshot",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        const account = await getAccount(deps.db, {
          worldId: request.params.worldId,
          keycloakSubject: identity.keycloakSubject,
        });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Zugang zu dieser Welt.");
        if (deps.livemap === undefined) {
          return reply.code(503).send({ error: "Livemap-Publisher nicht verfügbar." });
        }
        return reply.send(deps.livemap.forWorld(request.params.worldId).snapshot());
      } catch (error) {
        if (error instanceof LivemapCapacityError) {
          return reply.code(503).send({ error: "Livemap vorübergehend ausgelastet." });
        }
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/livemap/events",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      let feed;
      try {
        const account = await getAccount(deps.db, {
          worldId: request.params.worldId,
          keycloakSubject: identity.keycloakSubject,
        });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Zugang zu dieser Welt.");
        feed = deps.livemap?.forWorld(request.params.worldId);
      } catch (error) {
        if (error instanceof LivemapCapacityError) {
          return reply.code(503).send({ error: "Livemap vorübergehend ausgelastet." });
        }
        return sendError(reply, error);
      }
      if (feed === undefined) {
        return reply.code(503).send({ error: "Livemap-Publisher nicht verfügbar." });
      }

      const lastEventHeader = request.headers["last-event-id"];
      const rawLastEventId = Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader;
      const lastEventId = rawLastEventId === undefined ? feed.snapshot().sequence : Number(rawLastEventId);
      if (!Number.isSafeInteger(lastEventId) || lastEventId < 0) {
        return reply.code(400).send({ error: "Last-Event-ID muss eine nichtnegative Ganzzahl sein." });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });

      const queue: string[] = [];
      const maximumQueueLength = 128;
      let waitingForDrain = false;
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: () => void = () => undefined;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        unsubscribe();
        queue.length = 0;
      };
      const flush = () => {
        if (closed || waitingForDrain) return;
        while (queue.length > 0) {
          const payload = queue.shift()!;
          if (!reply.raw.write(payload)) {
            waitingForDrain = true;
            reply.raw.once("drain", () => {
              waitingForDrain = false;
              flush();
            });
            return;
          }
        }
      };
      const enqueue = (payload: string) => {
        if (closed) return;
        if (queue.length >= maximumQueueLength) {
          cleanup();
          reply.raw.end();
          return;
        }
        queue.push(payload);
        flush();
      };

      const subscription = feed.subscribeAfter(lastEventId, (delta) => {
        enqueue(`id: ${delta.sequence}\ndata: ${JSON.stringify(delta)}\n\n`);
      });
      unsubscribe = subscription.unsubscribe;
      request.raw.once("aborted", cleanup);
      request.raw.once("close", cleanup);
      reply.raw.once("close", cleanup);
      reply.raw.once("error", cleanup);

      if (subscription.kind === "reset") {
        enqueue("event: reset\ndata: {}\n\n");
        cleanup();
        reply.raw.end();
        return undefined;
      }
      subscription.replay.forEach((delta) => {
        enqueue(`id: ${delta.sequence}\ndata: ${JSON.stringify(delta)}\n\n`);
      });
      if (closed) return undefined;
      heartbeat = setInterval(() => enqueue(": heartbeat\n\n"), 15_000);
      heartbeat.unref();
      enqueue("retry: 3000\n: verbunden\n\n");
      return undefined;
    },
  );

  // ---------------------------------------------------------------------
  // M2.1 — Weltzugang, Konto, Rolle
  // ---------------------------------------------------------------------

  app.post<{ Params: { worldId: string }; Body: { displayName: string } }>(
    "/worlds/:worldId/access",
    {
      preHandler: authenticate,
      schema: {
        params: worldIdParam,
        body: {
          type: "object",
          required: ["displayName"],
          properties: { displayName: { type: "string", minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const account = await requestWorldAccess(deps.db, {
          worldId: request.params.worldId,
          keycloakSubject: identity.keycloakSubject,
          displayName: request.body.displayName,
        });
        return reply.code(201).send(account);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/accounts",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const roster = await listAccountsInWorld(deps.db, {
          worldId: request.params.worldId,
          requestingKeycloakSubject: identity.keycloakSubject,
        });
        return reply.send(roster);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { worldId: string; accountId: string }; Body: { role: string } }>(
    "/worlds/:worldId/accounts/:accountId/roles",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          required: ["worldId", "accountId"],
          properties: {
            worldId: { type: "string", format: "uuid" },
            accountId: { type: "string", format: "uuid" },
          },
        },
        body: { type: "object", required: ["role"], properties: { role: { type: "string" } } },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      if (!isRole(request.body.role)) {
        return reply.code(400).send({ error: `Unbekannte Rolle '${request.body.role}'.` });
      }
      try {
        const account = await grantRole(deps.db, {
          worldId: request.params.worldId,
          targetAccountId: request.params.accountId,
          role: request.body.role,
          actingKeycloakSubject: identity.keycloakSubject,
        });
        return reply.send(account);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get("/me/worlds", { preHandler: authenticate }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) {
      return reply.code(401).send({ error: "Keine Identität." });
    }
    const memberships = await listAccountsForSubject(deps.db, identity.keycloakSubject);
    return reply.send(memberships);
  });

  // ---------------------------------------------------------------------
  // M2.3 — EVU: Gründung, Liste
  // ---------------------------------------------------------------------

  app.post<{ Params: { worldId: string }; Body: { name: string } }>(
    "/worlds/:worldId/operators",
    {
      preHandler: authenticate,
      schema: {
        params: worldIdParam,
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const operator = await foundOperator(deps.db, {
          worldId: request.params.worldId,
          foundingKeycloakSubject: identity.keycloakSubject,
          name: request.body.name,
        });
        return reply.code(201).send(operator);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/operators",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const roster = await listOperatorsInWorld(deps.db, {
          worldId: request.params.worldId,
          requestingKeycloakSubject: identity.keycloakSubject,
        });
        return reply.send(roster);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get("/me/operators", { preHandler: authenticate }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) {
      return reply.code(401).send({ error: "Keine Identität." });
    }
    const eigene = await listOperatorsForAccount(deps.db, identity.keycloakSubject);
    return reply.send(eigene);
  });

  // ---------------------------------------------------------------------
  // M7 — Betriebsprogramm, Rücktest, Betriebszentrale und Tagesbericht
  // ---------------------------------------------------------------------

  app.get<{ Params: { worldId: string; operatorId: string } }>(
    "/worlds/:worldId/operators/:operatorId/operating-programs/templates",
    { preHandler: authenticate, schema: { params: operatorIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const [conservative, connections, rotations] = operatingProgramTemplates(request.params.worldId, request.params.operatorId, 1);
        return reply.send([
          { id: "conservative-punctual", name: "Konservativ pünktlich", program: conservative },
          { id: "connection-oriented", name: "Anschlussorientiert", program: connections },
          { id: "rotation-protecting", name: "Umlaufschonend", program: rotations },
        ]);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { worldId: string; operatorId: string }; Body: { program: unknown } }>(
    "/worlds/:worldId/operators/:operatorId/operating-programs",
    {
      preHandler: authenticate,
      schema: {
        params: operatorIdParam,
        body: { type: "object", required: ["program"], additionalProperties: false, properties: { program: { type: "object" } } },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const account = await getAccount(deps.db, { worldId: request.params.worldId, keycloakSubject: identity.keycloakSubject });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Zugang zu dieser Welt.");
        const canonical = canonicalizeProgram(request.body.program, request.params);
        const [existing] = await deps.db
          .select({ id: operatingProgramVersions.id })
          .from(operatingProgramVersions)
          .where(and(
            eq(operatingProgramVersions.worldId, request.params.worldId),
            eq(operatingProgramVersions.operatorId, request.params.operatorId),
            eq(operatingProgramVersions.version, canonical.program.version),
          ))
          .limit(1);
        if (existing !== undefined) return reply.code(409).send({ error: "Diese Betriebsprogramm-Version existiert bereits." });
        const [saved] = await deps.db.insert(operatingProgramVersions).values({
          worldId: request.params.worldId,
          operatorId: request.params.operatorId,
          version: canonical.program.version,
          schema: canonical.program.schema,
          enabled: canonical.program.enabled,
          canonicalProgram: canonical.program,
          checksum: canonical.checksum,
          status: "draft",
          createdByAccountId: account.id,
          createdAt: new Date(),
        }).returning();
        return reply.code(201).send(saved);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { worldId: string; operatorId: string } }>(
    "/worlds/:worldId/operators/:operatorId/operating-programs",
    { preHandler: authenticate, schema: { params: operatorIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        return reply.send(await deps.db.select().from(operatingProgramVersions).where(and(
          eq(operatingProgramVersions.worldId, request.params.worldId),
          eq(operatingProgramVersions.operatorId, request.params.operatorId),
        )).orderBy(desc(operatingProgramVersions.version)));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { worldId: string; operatorId: string; version: string } }>(
    "/worlds/:worldId/operators/:operatorId/operating-programs/:version/activate",
    {
      preHandler: authenticate,
      schema: { params: { type: "object", required: ["worldId", "operatorId", "version"], properties: { worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" }, version: { type: "string", pattern: "^[1-9][0-9]*$" } } } },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const account = await getAccount(deps.db, { worldId: request.params.worldId, keycloakSubject: identity.keycloakSubject });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Zugang zu dieser Welt.");
        const version = Number(request.params.version);
        const result = await deps.db.transaction(async (tx) => {
          const [target] = await tx.select().from(operatingProgramVersions).where(and(
            eq(operatingProgramVersions.worldId, request.params.worldId),
            eq(operatingProgramVersions.operatorId, request.params.operatorId),
            eq(operatingProgramVersions.version, version),
          )).limit(1);
          if (target === undefined) return undefined;
          const activatedAt = new Date();
          await tx.update(operatingProgramVersions).set({ status: "superseded" }).where(and(
            eq(operatingProgramVersions.worldId, request.params.worldId),
            eq(operatingProgramVersions.operatorId, request.params.operatorId),
            eq(operatingProgramVersions.status, "active"),
          ));
          const [active] = await tx.update(operatingProgramVersions).set({ status: "active", activatedAt }).where(and(
            eq(operatingProgramVersions.worldId, request.params.worldId),
            eq(operatingProgramVersions.operatorId, request.params.operatorId),
            eq(operatingProgramVersions.version, version),
          )).returning();
          const [command] = await tx.insert(simulationCommands).values({
            worldId: request.params.worldId,
            requestingAccountId: account.id,
            idempotencyKey: `m7:activate:${request.params.operatorId}:${version}`,
            commandType: "dispatch.activate-program",
            payload: { operatorId: request.params.operatorId, version, checksum: target.checksum, program: target.canonicalProgram },
            submittedAt: activatedAt,
          }).onConflictDoNothing({ target: [simulationCommands.worldId, simulationCommands.requestingAccountId, simulationCommands.idempotencyKey] }).returning();
          return { active, command };
        });
        return result === undefined ? reply.code(404).send({ error: "Betriebsprogramm-Version nicht gefunden." }) : reply.code(202).send(result);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { worldId: string; operatorId: string } }>(
    "/worlds/:worldId/operators/:operatorId/operations",
    { preHandler: authenticate, schema: { params: operatorIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        return reply.send(projectOperations(await worldEventLog(deps.db, request.params.worldId).list(), request.params.operatorId));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string; operatorId: string; decisionId: string };
    Body: { idempotencyKey: string; action: string; reason: string; at: number };
  }>(
    "/worlds/:worldId/operators/:operatorId/operations/decisions/:decisionId/override",
    {
      preHandler: authenticate,
      schema: {
        params: { type: "object", required: ["worldId", "operatorId", "decisionId"], properties: { worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" }, decisionId: { type: "string", minLength: 1, maxLength: 128 } } },
        body: { type: "object", required: ["idempotencyKey", "action", "reason", "at"], additionalProperties: false, properties: { idempotencyKey: { type: "string", minLength: 1, maxLength: 128 }, action: { type: "string", enum: ACTIONS }, reason: { type: "string", minLength: 8, maxLength: 500 }, at: { type: "integer", minimum: 0 } } },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const account = await getAccount(deps.db, { worldId: request.params.worldId, keycloakSubject: identity.keycloakSubject });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Zugang zu dieser Welt.");
        const decisions = projectOperations(await worldEventLog(deps.db, request.params.worldId).list(), request.params.operatorId).decisions;
        if (!decisions.some((entry) => entry.decisionId === request.params.decisionId)) return reply.code(404).send({ error: "Entscheidung im EVU-Ereignisstrom nicht gefunden." });
        let [command] = await deps.db.insert(simulationCommands).values({
          worldId: request.params.worldId,
          requestingAccountId: account.id,
          idempotencyKey: request.body.idempotencyKey,
          commandType: "dispatch.manual-override",
          payload: { operatorId: request.params.operatorId, decisionId: request.params.decisionId, action: request.body.action, reason: request.body.reason, at: request.body.at },
          submittedAt: new Date(),
        }).onConflictDoNothing({ target: [simulationCommands.worldId, simulationCommands.requestingAccountId, simulationCommands.idempotencyKey] }).returning();
        if (command === undefined) [command] = await deps.db.select().from(simulationCommands).where(and(eq(simulationCommands.worldId, request.params.worldId), eq(simulationCommands.requestingAccountId, account.id), eq(simulationCommands.idempotencyKey, request.body.idempotencyKey))).limit(1);
        return reply.code(202).send(command);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string; operatorId: string };
    Body: { idempotencyKey: string; programVersion: number; sourceAfter: number; sourceThrough: number };
  }>(
    "/worlds/:worldId/operators/:operatorId/operating-programs/backtests",
    {
      preHandler: authenticate,
      schema: { params: operatorIdParam, body: { type: "object", required: ["idempotencyKey", "programVersion", "sourceAfter", "sourceThrough"], additionalProperties: false, properties: { idempotencyKey: { type: "string", minLength: 1, maxLength: 128 }, programVersion: { type: "integer", minimum: 1 }, sourceAfter: { type: "integer", minimum: 0 }, sourceThrough: { type: "integer", minimum: 1 } } } },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        if (request.body.sourceAfter >= request.body.sourceThrough) return reply.code(400).send({ error: "Rücktest-Zeitraum ist leer." });
        const account = await getAccount(deps.db, { worldId: request.params.worldId, keycloakSubject: identity.keycloakSubject });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Zugang zu dieser Welt.");
        const [version] = await deps.db.select().from(operatingProgramVersions).where(and(eq(operatingProgramVersions.worldId, request.params.worldId), eq(operatingProgramVersions.operatorId, request.params.operatorId), eq(operatingProgramVersions.version, request.body.programVersion))).limit(1);
        if (version === undefined) return reply.code(404).send({ error: "Betriebsprogramm-Version nicht gefunden." });
        let [command] = await deps.db.insert(simulationCommands).values({
          worldId: request.params.worldId,
          requestingAccountId: account.id,
          idempotencyKey: request.body.idempotencyKey,
          commandType: "dispatch.backtest",
          payload: { operatorId: request.params.operatorId, programVersion: request.body.programVersion, programChecksum: version.checksum, program: version.canonicalProgram, sourceAfter: request.body.sourceAfter, sourceThrough: request.body.sourceThrough },
          submittedAt: new Date(),
        }).onConflictDoNothing({ target: [simulationCommands.worldId, simulationCommands.requestingAccountId, simulationCommands.idempotencyKey] }).returning();
        if (command === undefined) {
          [command] = await deps.db.select().from(simulationCommands).where(and(
            eq(simulationCommands.worldId, request.params.worldId),
            eq(simulationCommands.requestingAccountId, account.id),
            eq(simulationCommands.idempotencyKey, request.body.idempotencyKey),
          )).limit(1);
        }
        return reply.code(202).send(command);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { worldId: string; operatorId: string } }>(
    "/worlds/:worldId/operators/:operatorId/operating-programs/backtests",
    { preHandler: authenticate, schema: { params: operatorIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const events = await worldEventLog(deps.db, request.params.worldId).list();
        return reply.send(events.filter((event) => {
          if (event.eventType !== "dispatch.backtest-result" || typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) return false;
          const payload = event.payload as Record<string, unknown>;
          return payload.operatorId === request.params.operatorId || payload.operator_id === request.params.operatorId;
        }));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { worldId: string; operatorId: string; serviceDay: string } }>(
    "/worlds/:worldId/operators/:operatorId/operations/reports/:serviceDay/generate",
    { preHandler: authenticate, schema: { params: { type: "object", required: ["worldId", "operatorId", "serviceDay"], properties: { worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" }, serviceDay: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" } } } } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const report = buildDailyReport(await worldEventLog(deps.db, request.params.worldId).list(), request.params.operatorId, request.params.serviceDay);
        const [saved] = await deps.db.insert(dailyOperationReports).values({ worldId: request.params.worldId, operatorId: request.params.operatorId, serviceDay: request.params.serviceDay, sourceFromSequence: report.sourceFromSequence, sourceThroughSequence: report.sourceThroughSequence, projection: report, generatedAt: new Date() }).onConflictDoUpdate({
          target: [dailyOperationReports.worldId, dailyOperationReports.operatorId, dailyOperationReports.serviceDay],
          set: { sourceFromSequence: report.sourceFromSequence, sourceThroughSequence: report.sourceThroughSequence, projection: report, generatedAt: new Date() },
        }).returning();
        return reply.code(201).send(saved);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { worldId: string; operatorId: string } }>(
    "/worlds/:worldId/operators/:operatorId/operations/reports",
    { preHandler: authenticate, schema: { params: operatorIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        return reply.send(await deps.db.select().from(dailyOperationReports).where(and(eq(dailyOperationReports.worldId, request.params.worldId), eq(dailyOperationReports.operatorId, request.params.operatorId))).orderBy(desc(dailyOperationReports.serviceDay)));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { worldId: string; operatorId: string } }>(
    "/worlds/:worldId/operators/:operatorId/operations/events",
    { preHandler: authenticate, schema: { params: operatorIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
      } catch (error) {
        return sendError(reply, error);
      }
      const feed = operations.forOperator(request.params.worldId, request.params.operatorId);
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      const queue: string[] = [];
      const maximumQueueLength = 128;
      let closed = false;
      let waitingForDrain = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: () => void = () => undefined;
      const cleanup = () => { if (closed) return; closed = true; if (heartbeat !== undefined) clearInterval(heartbeat); unsubscribe(); };
      const flush = () => {
        if (closed || waitingForDrain) return;
        while (queue.length > 0) {
          if (!reply.raw.write(queue.shift()!)) { waitingForDrain = true; reply.raw.once("drain", () => { waitingForDrain = false; flush(); }); return; }
        }
      };
      const enqueue = (value: string) => { if (closed) return; if (queue.length >= maximumQueueLength) { cleanup(); reply.raw.end(); return; } queue.push(value); flush(); };
      const rawLastEventId = request.headers["last-event-id"];
      const lastEventId = Number(Array.isArray(rawLastEventId) ? rawLastEventId[0] : rawLastEventId);
      if (Number.isSafeInteger(lastEventId) && lastEventId >= 0) {
        const replay = feed.eventsAfter(lastEventId);
        if (replay === undefined) enqueue("event: reset\ndata: {}\n\n");
        else replay.forEach((event) => enqueue(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`));
      }
      unsubscribe = feed.subscribe((event) => enqueue(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`));
      heartbeat = setInterval(() => enqueue(": heartbeat\n\n"), 15_000);
      heartbeat.unref();
      request.raw.once("close", cleanup);
      reply.raw.once("error", cleanup);
      enqueue("retry: 3000\n: verbunden\n\n");
      return undefined;
    },
  );

  // ---------------------------------------------------------------------
  // M2.4 — Ledger-Kern: Konten, Transaktionen, Salden
  // ---------------------------------------------------------------------

  app.post<{ Params: { worldId: string; operatorId: string }; Body: { name: string } }>(
    "/worlds/:worldId/operators/:operatorId/ledger/accounts",
    {
      preHandler: authenticate,
      schema: {
        params: operatorIdParam,
        body: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1 } } },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const account = await openLedgerAccount(deps.db, {
          worldId: request.params.worldId,
          operatorId: request.params.operatorId,
          name: request.body.name,
        });
        return reply.code(201).send(account);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { worldId: string; operatorId: string } }>(
    "/worlds/:worldId/operators/:operatorId/ledger/accounts",
    { preHandler: authenticate, schema: { params: operatorIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const ledgerAccounts = await listLedgerAccounts(deps.db, {
          worldId: request.params.worldId,
          operatorId: request.params.operatorId,
        });
        const withBalances = await Promise.all(
          ledgerAccounts.map(async (account) => {
            const balanceCents = await ledgerAccountBalance(deps.db, {
              worldId: request.params.worldId,
              ledgerAccountId: account.id,
            });
            return { ...account, balanceCents: balanceCents.toString() };
          }),
        );
        return reply.send(withBalances);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string; operatorId: string };
    Body: { description: string; entries: readonly { ledgerAccountId: string; amountCents: string }[] };
  }>(
    "/worlds/:worldId/operators/:operatorId/ledger/transactions",
    {
      preHandler: authenticate,
      schema: {
        params: operatorIdParam,
        body: {
          type: "object",
          required: ["description", "entries"],
          properties: {
            description: { type: "string", minLength: 1 },
            entries: {
              type: "array",
              minItems: 2,
              items: {
                type: "object",
                required: ["ledgerAccountId", "amountCents"],
                properties: { ledgerAccountId: { type: "string", format: "uuid" }, amountCents: cents },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const transaction = await postLedgerTransaction(deps.db, {
          worldId: request.params.worldId,
          operatorId: request.params.operatorId,
          description: request.body.description,
          postedAt: new Date(),
          entries: request.body.entries.map((entry) => ({
            ledgerAccountId: entry.ledgerAccountId,
            amountCents: BigInt(entry.amountCents),
          })),
        });
        return reply.code(201).send(transaction);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { worldId: string; operatorId: string } }>(
    "/worlds/:worldId/operators/:operatorId/ledger/transactions",
    { preHandler: authenticate, schema: { params: operatorIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const list = await listLedgerTransactions(deps.db, {
          worldId: request.params.worldId,
          operatorId: request.params.operatorId,
        });
        return reply.send(list);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  // ---------------------------------------------------------------------
  // M2.5 — Postfach: Liste, Quittierung, Versand (Weltverwalter)
  // ---------------------------------------------------------------------

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/mailbox",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const inbox = await listInbox(deps.db, {
          worldId: request.params.worldId,
          requestingKeycloakSubject: identity.keycloakSubject,
        });
        return reply.send(inbox);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { worldId: string; messageId: string } }>(
    "/worlds/:worldId/mailbox/:messageId/ack",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          required: ["worldId", "messageId"],
          properties: { worldId: { type: "string", format: "uuid" }, messageId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const message = await acknowledgeMessage(deps.db, {
          worldId: request.params.worldId,
          messageId: request.params.messageId,
          actingKeycloakSubject: identity.keycloakSubject,
          acknowledgedAt: new Date(),
        });
        return reply.send(message);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string; accountId: string };
    Body: { messageType: string; payload: unknown; deadlineAt?: string };
  }>(
    "/worlds/:worldId/accounts/:accountId/mailbox",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          required: ["worldId", "accountId"],
          properties: { worldId: { type: "string", format: "uuid" }, accountId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["messageType", "payload"],
          properties: {
            messageType: { type: "string", minLength: 1 },
            payload: {},
            deadlineAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        await requireWorldAdminAccount(deps.db, request.params.worldId, identity.keycloakSubject);
        const message = await sendMessage(deps.db, {
          worldId: request.params.worldId,
          recipientAccountId: request.params.accountId,
          messageType: request.body.messageType,
          payload: request.body.payload,
          deadlineAt: request.body.deadlineAt === undefined ? undefined : new Date(request.body.deadlineAt),
        });
        return reply.code(201).send(message);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  // ---------------------------------------------------------------------
  // M2.6 — Datenschutz: Auskunft, Löschung
  // ---------------------------------------------------------------------

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/me/export",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const auskunft = await exportAccountData(deps.db, {
          worldId: request.params.worldId,
          keycloakSubject: identity.keycloakSubject,
          exportedAt: new Date(),
        });
        return reply.send(auskunft);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { worldId: string } }>(
    "/worlds/:worldId/me/erase",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const account = await eraseAccountData(deps.db, {
          worldId: request.params.worldId,
          targetKeycloakSubject: identity.keycloakSubject,
          actingKeycloakSubject: identity.keycloakSubject,
          erasedAt: new Date(),
        });
        return reply.send(account);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { worldId: string; accountId: string } }>(
    "/worlds/:worldId/accounts/:accountId/erase",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          required: ["worldId", "accountId"],
          properties: { worldId: { type: "string", format: "uuid" }, accountId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const targetKeycloakSubject = await resolveKeycloakSubject(
          deps.db,
          request.params.worldId,
          request.params.accountId,
        );
        const account = await eraseAccountData(deps.db, {
          worldId: request.params.worldId,
          targetKeycloakSubject,
          actingKeycloakSubject: identity.keycloakSubject,
          erasedAt: new Date(),
        });
        return reply.send(account);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  return app;
}
