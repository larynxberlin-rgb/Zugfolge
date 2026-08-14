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
  ALPHA_WORLD_BLUEPRINT_SCHEMA,
  AlphaAuthorizationError,
  AlphaConflictError,
  AlphaValidationError,
  effectiveStartingCapitalPolicy,
  foundPublicOperatorWithStartingCapital,
  validateStoredPublicWorldContract,
  validateWorldBlueprint,
  type AlphaWorldBlueprint,
  type StartingCapitalPolicy,
} from "@zugfolge/alpha";

import {
  accounts,
  alphaWorldProfiles,
  createDatabaseHealthCheck,
  dailyOperationReports,
  disruptionPolicies,
  disruptionProviderStates,
  EventSequenceError,
  operatingProgramVersions,
  operators,
  simulationCommands,
  tutorialSessions,
  worldEventLog,
  worlds,
  worldAccesses,
  worldParticipations,
} from "@zugfolge/db";
import {
  assertPrivateWorldEntitlement,
  assertPublicWorldSlot,
  activeEntitlementsForSubject,
  PrivateWorldEntitlementError,
  PublicWorldSlotError,
  receiveOdooWebhook,
  WebhookSignatureError,
  WebhookValidationError,
  type OdooWebhookReceiptStore,
  type OdooWebhookReceiverOptions,
  type OdooWebhookEnvelope,
  type SignedPayload,
} from "@zugfolge/commerce";
import {
  CooperationAuthorizationError,
  CooperationConflictError,
  CooperationNotFoundError,
  CooperationService,
  CooperationValidationError,
} from "@zugfolge/cooperation";
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
  applyFleetProducerCommand,
  announceTender,
  buildEconomyRelease,
  decodeEconomyValue,
  deriveGtfsServiceSpecification,
  DuplicateLedgerAccountNameError,
  economyStateForPlayer,
  EconomyStateConflictError,
  escalateOperator,
  FleetProducerConflictError,
  FleetProducerUnavailableError,
  FleetSnapshotValidationError,
  ForeignLedgerAccountError,
  encodeEconomyValue,
  IncompleteTransactionError,
  initializeFleetProducer,
  ledgerAccountBalance,
  listLedgerAccounts,
  listLedgerTransactions,
  loadFleetMobilizationSnapshot,
  loadEconomyWorldEpoch,
  loadEconomyWorldState,
  openLedgerAccount,
  postLedgerTransaction,
  persistEconomyTransition,
  resolveVehicleConcept,
  resolvePublicEntryFacilityVehicleConcept,
  serializeStartingCapitalPolicy,
  settleContractPeriod,
  startEconomyWorld,
  submitBid,
  submitMobilizationReference,
  UnbalancedTransactionError,
  verifyPublicEntryFacilityMobilizationReference,
  verifyMobilizationReference,
  PUBLIC_ENTRY_FACILITY_SCHEMA,
  type AuthorityBudget,
  type EconomyRelease,
  type EconomyDatabase,
  type FleetMobilizationReference,
  type GtfsPlanningEnvelope,
  type GtfsPlanningLotReference,
} from "@zugfolge/economy";
import { runHealthChecks, type HealthCheck } from "@zugfolge/health";
import {
  livemapEventId,
  LivemapCapacityError,
  parseLivemapEventId,
  type LivemapReadModel,
  type LivemapRegistry,
} from "@zugfolge/livemap-stream";
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
  WorldContractAcceptanceConflictError,
  type IdentityDatabase,
} from "@zugfolge/identity";
import { acknowledgeMessage, listInbox, MessageNotFoundError, projectInboxMessage, RecipientNotFoundError, sendMessage } from "@zugfolge/mailbox";
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
import {
  PLANNING_COORDINATE_AUTHORITY_BODY_SCHEMA,
  PLANNING_PLAYER_PATH_REQUEST_BODY_SCHEMA,
  PlanningWorkerConflictError,
  queuePlanningCoordinate,
  queuePlanningPathRequest,
  type PlanningCoordinateAuthorityBody,
  type PlanningPlayerPathRequestBody,
} from "@zugfolge/planning-worker";
import { eraseAccountData, exportAccountData, PersonalDataNotFoundError } from "@zugfolge/privacy";
import {
  FLEET_FORMATION_COMMAND_SCHEMA,
  FLEET_INITIALIZE_SCHEMA,
  FLEET_PATH_RESERVATION_COMMAND_SCHEMA,
  FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA,
  REGIONAL_SIMULATION_INITIALIZE_SCHEMA,
  type FleetAuthorityRelease,
  type FleetCommandResult,
  type FleetRuntime,
  type FleetWorldInitialized,
  type NativeFleetCommand,
  type RegionalSimulationCommandPayload,
  type RegionalSimulationInitialization,
} from "@zugfolge/runtime-native";
import { and, asc, desc, eq, lte, notInArray, sql } from "drizzle-orm";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import { createAuthenticator, type TokenVerifier } from "./auth.js";
import { guardAlphaAction, registerAlphaRoutes, type AlphaAbuseServices, type AlphaRouteServices } from "./alpha-routes.js";
import { registerCooperationRoutes } from "./cooperation-routes.js";
import { GameCooperationAuthority } from "./cooperation-authority.js";
import { GameFleetAssetTransferWriter } from "./fleet-market-writer.js";
import { registerInfraPackageUploadRoutes } from "./infra-package-routes.js";
import type { InfraPackageStaging, InfraUploadSigningKey } from "./infra-package-staging.js";
import { registerLivemapReadRoutes } from "./livemap-read-routes.js";
import { ApiObservability, requestCorrelationId, type PrometheusMetricSource } from "./observability.js";
import { PlanningAuthorityError, resolveAuthoritativePlanningPathRequest } from "./planning-authority.js";
import {
  RegionalSimulationConflictError,
  RegionalSimulationSequenceError,
  RegionalSimulationUnavailableError,
  type RegionalSimulationWorker,
} from "./regional-simulation-worker.js";
import { projectSimulationEventBatch } from "./simulation-event-projection.js";
import { registerWorldLifecycleGate } from "./world-lifecycle-gate.js";

export interface AppDependencies {
  readonly db: IdentityDatabase;
  readonly verifyToken: TokenVerifier;
  /**
   * Zusätzliche Prüfungen für `/health/ready`, über die Datenbankverbindung
   * hinaus — der Erweiterungspunkt, an dem künftige Milestones ihre eigenen
   * Health Checks anmelden, statt sie später nachzuziehen.
   */
  readonly extraHealthChecks?: readonly HealthCheck[];
  /** Bereits materialisierte Betriebsmetriken; `/metrics` fuehrt keine Fachabfragen aus. */
  readonly extraMetricSources?: readonly PrometheusMetricSource[];
  /** Öffentlicher, weltisolierter Livemap-Fanout (M4.6). */
  readonly livemap?: LivemapRegistry;
  /** Gepinnte Infrastrukturdetails und serverautoritative FIS-/Tafelprojektionen. */
  readonly livemapReadModel?: LivemapReadModel;
  /** Authentifizierter, je EVU getrennter Betriebsereignis-Fanout (M7.5/M7.6). */
  readonly operations?: OperationsRegistry;
  /** Geteiltes Geheimnis des Simulations-Eventlog-Adapters. */
  readonly simulationIngestToken?: string;
  /** Persistenter, in-process angebundener regionaler Rust-Single-Writer (M4). */
  readonly regionalSimulation?: Pick<RegionalSimulationWorker, "initialize" | "apply">;
  /** Serverseitig je Welt gebundener Audit-Principal fuer PlanningRun-Koordination. */
  readonly planningAuthorityAccountIds?: Readonly<Record<string, string>>;
  /** Geteiltes Geheimnis des kanonischen M5-Single-Writer-Snapshot-Adapters. */
  readonly fleetIngestToken?: string;
  /** Fail-closed Rust-Single-Writer fuer M5-Intents und deren Projektion. */
  readonly fleetRuntime?: FleetRuntime;
  /** Serverseitig eingefrorener Authority-Release je Welt. */
  readonly fleetAuthorityReleases?: Readonly<Record<string, FleetAuthorityRelease>>;
  /** Hartes Zeitbudget jedes Readiness-Checks. */
  readonly healthCheckTimeoutMs?: number;
  /** Produktion protokolliert strukturiert; Tests dürfen den Logger abschalten. */
  readonly logger?: boolean;
  /** Optionaler, vom normalen Keycloak-Pfad getrennter Odoo-Webhook-Receiver (E23). */
  readonly odooWebhookStore?: OdooWebhookReceiptStore;
  readonly odooWebhookOptions?: OdooWebhookReceiverOptions;
  /** Getrennt signierter, lokaler und nie aktivierender Odoo-Jahresimport. */
  readonly infraPackageStaging?: InfraPackageStaging;
  readonly infraUploadKeys?: readonly InfraUploadSigningKey[];
  /** Serverautoritative EVU-Verträge und Sekundärmarkt; Produktion nutzt dieselbe Postgres-Verbindung. */
  readonly cooperation?: CooperationService;
  /** Injizierbare serverautoritative Weltzeit für Kooperation und Markt. */
  readonly cooperationSimulationSecond?: (worldId: string) => Promise<number>;
  /** Einmal je Postfachrequest gelesene Serverzeit fuer Prioritaet und Fristen. */
  readonly mailboxClock?: () => Date;
  /** Einmal je Weltvertragsrequest gelesene Wandzeit; nie Teil des Simulationskerns. */
  readonly publicWorldClock?: () => Date;
  /** Reale Queuezeit fuer Economy-Outbox-Commits, getrennt von der beschleunigten Fachzeit. */
  readonly economyQueueClock?: () => Date;
  /** M9-Spieler-, Monitoring- und Alpha-Pfade; fehlen sie, werden keine Teilattrappen exponiert. */
  readonly alpha?: AlphaRouteServices;
  /** Persistenter Missbrauchsschutz darf auch ohne noch nicht fertig verdrahtete Alpha-Oberflaechen aktiv sein. */
  readonly alphaAbuse?: AlphaAbuseServices;
  /** Direkte Admin-HTTP-Pfade sind nur in Tests/Bootstrap erlaubt; Produktion setzt `odoo`. */
  readonly adminControl?: "odoo" | "nonproduction-direct";
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

type FleetCommandWithoutWorld<T> = T extends { readonly worldId: string }
  ? Omit<T, "worldId">
  : never;
type FleetCommandBody = FleetCommandWithoutWorld<NativeFleetCommand>;

const fleetInitializeBody = {
  type: "object",
  required: ["producedAt"],
  additionalProperties: false,
  properties: {
    producedAt: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const;

const fleetCommandHeaderProperties = {
  commandId: { type: "string", minLength: 1, maxLength: 200 },
  expectedStateHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
  expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  atS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
} as const;

const fleetIdentifier = { type: "string", minLength: 1, maxLength: 200 } as const;
const fleetIdentifierSet = {
  type: "array",
  minItems: 1,
  maxItems: 1_000,
  uniqueItems: true,
  items: fleetIdentifier,
} as const;

const fleetCommandBody = {
  oneOf: [
    {
      type: "object",
      required: [
        "schemaVersion",
        "commandId",
        "expectedStateHash",
        "expectedRevision",
        "atS",
        "formationId",
        "vehicleIds",
        "pathReceiptId",
      ],
      additionalProperties: false,
      properties: {
        schemaVersion: { type: "string", const: FLEET_FORMATION_COMMAND_SCHEMA },
        ...fleetCommandHeaderProperties,
        formationId: fleetIdentifier,
        vehicleIds: fleetIdentifierSet,
        pathReceiptId: fleetIdentifier,
      },
    },
    {
      type: "object",
      required: [
        "schemaVersion",
        "commandId",
        "expectedStateHash",
        "expectedRevision",
        "atS",
        "personnelDutyId",
        "personnelPoolId",
        "formationIds",
        "pathReceiptId",
        "validFrom",
        "validUntil",
      ],
      additionalProperties: false,
      properties: {
        schemaVersion: { type: "string", const: FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA },
        ...fleetCommandHeaderProperties,
        personnelDutyId: fleetIdentifier,
        personnelPoolId: fleetIdentifier,
        formationIds: fleetIdentifierSet,
        pathReceiptId: fleetIdentifier,
        validFrom: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        validUntil: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
    },
    {
      type: "object",
      required: [
        "schemaVersion",
        "commandId",
        "expectedStateHash",
        "expectedRevision",
        "atS",
        "pathReservationId",
        "pathReceiptId",
      ],
      additionalProperties: false,
      properties: {
        schemaVersion: { type: "string", const: FLEET_PATH_RESERVATION_COMMAND_SCHEMA },
        ...fleetCommandHeaderProperties,
        pathReservationId: fleetIdentifier,
        pathReceiptId: fleetIdentifier,
      },
    },
  ],
} as const;

const RESERVED_SINGLE_WRITER_EVENT_TYPES = new Set([
  "planning.runtime-state",
  "planning.diagram",
  "livemap-operation-marked",
  "livemap-operation-cleared",
  "operating-duty-ended",
  "operating-transition-completed",
  "train-operation-assigned",
]);
const RESERVED_PLANNING_COMMAND_TYPES = [
  "planning.coordinate",
  "planning.path-request",
  "planning.apply-alternative",
] as const;

const regionalSimulationParams = {
  type: "object",
  required: ["worldId", "regionId"],
  additionalProperties: false,
  properties: {
    worldId: { type: "string", format: "uuid" },
    regionId: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

const regionalSimulationCommandParams = {
  type: "object",
  required: ["worldId", "regionId", "commandId"],
  additionalProperties: false,
  properties: {
    ...regionalSimulationParams.properties,
    commandId: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

const regionalWaypointSchema = {
  type: "object",
  required: [
    "operatingPoint",
    "positionMm",
    "arrivalS",
    "minimumDwellSeconds",
    "departureS",
  ],
  additionalProperties: false,
  properties: {
    operatingPoint: { type: "string", minLength: 1, maxLength: 200 },
    positionMm: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    arrivalS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    minimumDwellSeconds: { type: "integer", minimum: 0, maximum: 4_294_967_295 },
    departureS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const;

const regionalTrainSchema = {
  type: "object",
  required: ["trainRunId", "operator", "trainNumber", "category", "route"],
  additionalProperties: false,
  properties: {
    trainRunId: { type: "string", minLength: 1, maxLength: 200 },
    operator: { type: "string", minLength: 1, maxLength: 200 },
    trainNumber: { type: "string", minLength: 1, maxLength: 200 },
    category: {
      type: "string",
      enum: ["regional", "long-distance", "freight", "empty-stock", "engineering"],
    },
    route: {
      type: "array",
      minItems: 1,
      maxItems: 10_000,
      items: regionalWaypointSchema,
    },
  },
} as const;

const regionalInitializationSchema = {
  type: "object",
  required: ["materializationWindowHours", "nowS", "trains"],
  additionalProperties: false,
  properties: {
    materializationWindowHours: { type: "integer", minimum: 48, maximum: 72 },
    nowS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    trains: {
      type: "array",
      maxItems: 200_000,
      items: regionalTrainSchema,
    },
  },
} as const;

const regionalCommandSchema = {
  oneOf: [
    {
      type: "object",
      required: ["type", "train"],
      additionalProperties: false,
      properties: {
        type: { const: "materialize" },
        train: regionalTrainSchema,
      },
    },
    {
      type: "object",
      required: ["type", "atS"],
      additionalProperties: false,
      properties: {
        type: { const: "advance-to" },
        atS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
    },
    {
      type: "object",
      required: ["type", "trainRunId", "seconds"],
      additionalProperties: false,
      properties: {
        type: { const: "add-delay" },
        trainRunId: { type: "string", minLength: 1, maxLength: 200 },
        seconds: { type: "integer", minimum: 0, maximum: 4_294_967_295 },
      },
    },
    {
      type: "object",
      required: ["type", "beforeS"],
      additionalProperties: false,
      properties: {
        type: { const: "dematerialize-before" },
        beforeS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
    },
    {
      type: "object",
      required: ["type", "trainRunId", "externalLeg"],
      additionalProperties: false,
      properties: {
        type: { const: "enter-external-zone" },
        trainRunId: { type: "string", minLength: 1, maxLength: 200 },
        externalLeg: {
          type: "object",
          required: [
            "journeyChainId", "externalLegId", "fromPortalId", "toPortalId",
            "scheduledStartS", "scheduledEndS", "reentryEarliestS", "reentryLatestS",
            "fixedCostCents", "boundVehicleIds", "boundPersonnelDutyIds", "reentryRoute", "firstResources",
          ],
          additionalProperties: false,
          properties: {
            journeyChainId: { type: "string", minLength: 1, maxLength: 200 },
            externalLegId: { type: "string", minLength: 1, maxLength: 200 },
            fromPortalId: { type: "string", minLength: 1, maxLength: 200 },
            toPortalId: { anyOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 200 }] },
            scheduledStartS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            scheduledEndS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            reentryEarliestS: { anyOf: [{ type: "null" }, { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }] },
            reentryLatestS: { anyOf: [{ type: "null" }, { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }] },
            fixedCostCents: { type: "string", pattern: "^(0|[1-9][0-9]*)$", maxLength: 19 },
            boundVehicleIds: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
            boundPersonnelDutyIds: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
            reentryRoute: { type: "array", maxItems: 10_000, items: regionalWaypointSchema },
            firstResources: { type: "array", maxItems: 10_000, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
          },
        },
      },
    },
    {
      type: "object",
      required: ["type", "trainRunId"],
      additionalProperties: false,
      properties: {
        type: { const: "reenter-from-external" },
        trainRunId: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
  ],
} as const;

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

async function startingCapitalPolicyForWorld(db: IdentityDatabase, worldId: string) {
  const [profile] = await db
    .select({
      blueprint: alphaWorldProfiles.blueprint,
      blueprintHash: alphaWorldProfiles.blueprintHash,
      deploymentHash: alphaWorldProfiles.deploymentHash,
      state: alphaWorldProfiles.state,
    })
    .from(alphaWorldProfiles)
    .where(eq(alphaWorldProfiles.worldId, worldId))
    .limit(1);
  if (profile === undefined || profile.state !== "running") {
    throw new AlphaConflictError(
      "Startkapital ist erst fuer eine signiert gestartete Welt verfuegbar.",
      "starting_capital_world_not_running",
    );
  }
  try {
    if (profile.deploymentHash === null || !/^[a-f0-9]{64}$/.test(profile.deploymentHash)) {
      throw new Error("Deployment-Hash fehlt.");
    }
    const blueprint = decodeEconomyValue(profile.blueprint) as AlphaWorldBlueprint;
    if (validateWorldBlueprint(blueprint) !== profile.blueprintHash) {
      throw new Error("Blueprint-Hash weicht ab.");
    }
    return effectiveStartingCapitalPolicy(blueprint);
  } catch {
    throw new AlphaConflictError(
      "Startkapital ist nicht unveraendert an das signierte Welt-Deployment gebunden.",
      "starting_capital_unsigned",
    );
  }
}

async function publicEntryFacilityForWorld(db: IdentityDatabase, worldId: string, lotId: string) {
  const [profile] = await db
    .select({
      blueprint: alphaWorldProfiles.blueprint,
      blueprintHash: alphaWorldProfiles.blueprintHash,
      deploymentHash: alphaWorldProfiles.deploymentHash,
      state: alphaWorldProfiles.state,
    })
    .from(alphaWorldProfiles)
    .where(eq(alphaWorldProfiles.worldId, worldId))
    .limit(1);
  let blueprint: AlphaWorldBlueprint;
  try {
    blueprint = decodeEconomyValue(profile?.blueprint) as AlphaWorldBlueprint;
    if (validateWorldBlueprint(blueprint) !== profile?.blueprintHash) throw new Error("Blueprint-Hash weicht ab.");
  } catch {
    throw new AlphaConflictError("Diese Welt besitzt keinen unveraendert signierten Anschubvertrag.", "public_entry_facility_unsigned");
  }
  const policy = blueprint?.entryFacilityPolicy;
  const lot = blueprint.lots.find((candidate) => candidate.lotId === lotId);
  if (
    profile?.state !== "running"
    || profile.deploymentHash === null
    || !/^[a-f0-9]{64}$/.test(profile.deploymentHash)
    || policy?.schemaVersion !== PUBLIC_ENTRY_FACILITY_SCHEMA
    || policy.mode !== "award-contingent-wet-lease"
    || policy.providerOperatorId !== "public"
    || policy.costBasis !== "formation-operating-cost"
    || lot === undefined
  ) throw new AlphaConflictError("Diese Welt besitzt keinen signierten Anschubvertrag.", "public_entry_facility_disabled");
  return {
    providerOperatorId: policy.providerOperatorId,
    signedLotVehicleIds: Object.freeze([...lot.vehicleIds]),
    signedLotPersonnelDutyIds: Object.freeze([...lot.personnelDutyIds]),
    signedLotPathReceiptIds: Object.freeze([...lot.pathReceiptIds]),
  };
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
  if (error instanceof CommercialWorldReleaseRequiredError) {
    return reply.code(403).send({ code: error.code, error: error.message });
  }
  if (error instanceof AlphaAuthorizationError) {
    return reply.code(403).send({ code: error.code, error: error.message });
  }
  if (error instanceof AlphaValidationError) {
    return reply.code(400).send({ code: error.code, error: error.message });
  }
  if (error instanceof AlphaConflictError) {
    return reply.code(409).send({ code: error.code, error: error.message });
  }
  if (
    error instanceof AccessRevokedError ||
    error instanceof AuthorizationError ||
    error instanceof NoAccountInWorldError ||
    error instanceof ForeignLedgerAccountError
    || error instanceof PublicWorldSlotError
    || error instanceof PrivateWorldEntitlementError
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
  if (error instanceof DuplicateOperatorNameError || error instanceof DuplicateLedgerAccountNameError || error instanceof EventSequenceError || error instanceof EconomyStateConflictError || error instanceof WorldContractAcceptanceConflictError) {
    return reply.code(409).send({ error: error.message });
  }
  if (error instanceof IncompleteTransactionError || error instanceof UnbalancedTransactionError || error instanceof FleetSnapshotValidationError) {
    return reply.code(400).send({ error: error.message });
  }
  if (error instanceof ProgramValidationError || error instanceof RangeError) {
    return reply.code(400).send({ error: error.message });
  }
  if (error instanceof CooperationAuthorizationError) {
    return reply.code(403).send({ error: error.message });
  }
  if (error instanceof CooperationNotFoundError) {
    return reply.code(404).send({ error: error.message });
  }
  if (error instanceof CooperationConflictError) {
    return reply.code(409).send({ code: error.code, error: error.message });
  }
  if (error instanceof CooperationValidationError) {
    return reply.code(400).send({ code: error.code, error: error.message });
  }
  throw error;
}

class CommercialWorldReleaseRequiredError extends Error {
  readonly code = "commercial_world_release_required";
}

function sendRegionalSimulationError(
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof RegionalSimulationConflictError) {
    return reply.code(409).send({ code: error.code, error: error.message });
  }
  if (
    error instanceof RegionalSimulationUnavailableError ||
    error instanceof RegionalSimulationSequenceError
  ) {
    return reply.code(503).send({ code: error.code, error: error.message });
  }
  if (error instanceof RangeError) {
    return reply.code(400).send({
      code: "regional_simulation_invalid_request",
      error: error.message,
    });
  }
  if (error instanceof Error) {
    const nativeCode = /^([a-z][a-z0-9_]*):/.exec(error.message)?.[1];
    if (nativeCode !== undefined) {
      const statusCode = [
        "duplicate_train",
        "idempotency_conflict",
        "revision_conflict",
        "state_hash_conflict",
      ].includes(nativeCode)
        ? 409
        : [
            "corrupt_state",
            "identity_exhausted",
            "publisher_sequence_gap",
            "sequence_exhausted",
          ].includes(nativeCode)
          ? 503
          : 400;
      return reply.code(statusCode).send({ code: nativeCode, error: error.message });
    }
    return reply.code(500).send({
      code: "regional_simulation_failed",
      error: "Regionaler Simulationsaufruf ist fehlgeschlagen.",
    });
  }
  throw error;
}

function regionalSimulationRouteErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error.validation !== undefined) {
    void reply.code(400).send({
      code: "regional_simulation_invalid_request",
      error: "Regionaler Simulationsauftrag hat ein ungueltiges Format.",
    });
    return;
  }
  request.log.error({ err: error }, "Regionaler Simulationsendpunkt fehlgeschlagen");
  void reply.code(500).send({
    code: "regional_simulation_failed",
    error: "Regionaler Simulationsaufruf ist fehlgeschlagen.",
  });
}

function sendPlanningQueueError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PlanningAuthorityError) {
    return reply.code(error.statusCode).send({ code: error.code, error: error.message });
  }
  if (error instanceof PlanningWorkerConflictError) {
    return reply.code(409).send({ code: error.failureCode, error: error.message });
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return reply.code(400).send({
      code: "planning_invalid_request",
      error: error.message,
    });
  }
  return sendError(reply, error);
}

function planningRouteErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error.validation !== undefined) {
    void reply.code(400).send({
      code: "planning_invalid_request",
      error: "Planning-Auftrag hat ein ungueltiges Format.",
    });
    return;
  }
  request.log.error({ err: error }, "Planning-Endpunkt fehlgeschlagen");
  void reply.code(500).send({
    code: "planning_failed",
    error: "Planning-Auftrag ist fehlgeschlagen.",
  });
}

async function isActivePlanningAuthorityAccount(
  db: IdentityDatabase,
  worldId: string,
  accountId: string,
): Promise<boolean> {
  try {
    const keycloakSubject = await resolveKeycloakSubject(db, worldId, accountId);
    const account = await getAccount(db, { worldId, keycloakSubject });
    return account?.id === accountId;
  } catch (error) {
    if (error instanceof AccountNotFoundError || error instanceof AccessRevokedError) {
      return false;
    }
    throw error;
  }
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

function decodeStartingCapitalPolicy(profile: typeof alphaWorldProfiles.$inferSelect): StartingCapitalPolicy | null {
  try {
    return validateStoredPublicWorldContract(profile).startingCapitalPolicy;
  } catch {
    return null;
  }
}

function supportedPublicEntryPolicy(policy: StartingCapitalPolicy | null): boolean {
  return policy !== null;
}

/**
 * Fester Namespace fuer den weltuebergreifenden Identitaets-Lock. Der zweite
 * Advisory-Lock-Schluessel ist der Postgres-Hash des Keycloak-Subjects. Eine
 * Hash-Kollision kann damit hoechstens zwei Beitritte kurz serialisieren, aber
 * weder einen fremden Zugang freigeben noch ein Slot-Limit umgehen.
 */
const PUBLIC_WORLD_SLOT_LOCK_NAMESPACE = 1_515_674_707;

async function requestPublicWorldAccessAtomically(
  db: IdentityDatabase,
  input: {
    readonly worldId: string;
    readonly keycloakSubject: string;
    readonly displayName: string;
    readonly acceptedWorldContractHash: string;
  },
): Promise<Awaited<ReturnType<typeof requestWorldAccess>>> {
  return db.transaction(async (tx) => {
    // guards:allow world-id — Der Lock ist absichtlich subject-global: Er
    // serialisiert die weltuebergreifende Slot-Entscheidung, waehrend alle
    // gelesenen und geschriebenen Fachzeilen weiterhin world_id tragen.
    await tx.execute(sql`select pg_advisory_xact_lock(
      ${PUBLIC_WORLD_SLOT_LOCK_NAMESPACE}, hashtext(${input.keycloakSubject})
    )`);

    // Weltabschluss und Markteintritt duerfen sich nicht ueberholen. Der
    // Writer fuer den Weltlebenszyklus verwendet dieselbe Weltzeile als Lock.
    await tx.execute(sql`select ${worlds.id} from ${worlds}
      where ${worlds.id} = ${input.worldId} for update`);
    const [targetWorld] = await tx
      .select({
        worldKind: worlds.worldKind,
        lifecycleStatus: worlds.lifecycleStatus,
        profile: alphaWorldProfiles,
      })
      .from(worlds)
      .leftJoin(alphaWorldProfiles, eq(alphaWorldProfiles.worldId, worlds.id))
      .where(eq(worlds.id, input.worldId))
      .limit(1);
    if (targetWorld === undefined || targetWorld.worldKind !== "public"
      || targetWorld.lifecycleStatus !== "active") {
      throw new AlphaConflictError(
        "Archivierte Welten sind schreibgeschuetzt.",
        "world_not_active",
      );
    }

    const contract = targetWorld.profile === null
      ? null
      : (() => {
          try {
            return validateStoredPublicWorldContract(targetWorld.profile);
          } catch {
            return null;
          }
        })();
    const startingCapitalPolicy = contract?.startingCapitalPolicy ?? null;
    if (targetWorld.profile === null || targetWorld.profile.state !== "running"
      || contract === null || !supportedPublicEntryPolicy(startingCapitalPolicy)) {
      throw new AlphaConflictError(
        "Der serverseitige Weltvertrag ist unvollstaendig und erlaubt keinen Markteintritt.",
        "world_contract_invalid",
      );
    }
    if (input.acceptedWorldContractHash !== targetWorld.profile.blueprintHash) {
      throw new AlphaConflictError(
        "Der aktuelle Weltvertrag muss vor dem Markteintritt bestaetigt werden.",
        "world_contract_confirmation_required",
      );
    }

    let commerciallyReleased = false;
    if (contract.blueprint.schemaVersion === ALPHA_WORLD_BLUEPRINT_SCHEMA
      && contract.blueprint.admission !== undefined) {
      const [participation] = await tx.select({ id: worldParticipations.id })
        .from(worldParticipations)
        .where(and(
          eq(worldParticipations.worldId, input.worldId),
          eq(worldParticipations.keycloakSubject, input.keycloakSubject),
          eq(worldParticipations.state, "active"),
        ))
        .limit(1);
      if (participation === undefined) {
        throw new CommercialWorldReleaseRequiredError(
          "Oeffentliche Weltteilnahmen werden erst nach kommerzieller Odoo-Freigabe provisioniert.",
        );
      }
      commerciallyReleased = true;
    }

    const memberships = await tx
      .select({ worldId: worldAccesses.worldId })
      .from(worldAccesses)
      .innerJoin(worlds, eq(worldAccesses.worldId, worlds.id))
      .where(and(
        eq(worldAccesses.keycloakSubject, input.keycloakSubject),
        eq(worldAccesses.status, "active"),
        eq(worlds.worldKind, "public"),
        eq(worlds.lifecycleStatus, "active"),
      ));
    if (!commerciallyReleased && !memberships.some((membership) => membership.worldId === input.worldId)) {
      const entitlements = await activeEntitlementsForSubject(tx, input.keycloakSubject);
      assertPublicWorldSlot(
        entitlements.map((record) => ({
          subject: record.keycloakSubject,
          productKind: record.productKind,
          status: record.status,
          validFrom: record.validFrom,
          validUntil: record.validUntil ?? undefined,
          quantity: Number(record.quantity),
        })),
        memberships.length,
      );
    }

    return requestWorldAccess(tx, {
      worldId: input.worldId,
      keycloakSubject: input.keycloakSubject,
      displayName: input.displayName,
      acceptedWorldContract: {
        hash: contract.blueprintHash,
        startingCapitalPolicy: contract.startingCapitalPolicy,
      },
    });
  });
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

function fleetResultView(output: FleetWorldInitialized | FleetCommandResult) {
  const view = {
    revision: output.state.revision,
    stateHash: output.stateHash,
    snapshotHash: output.snapshotHash,
    snapshot: output.snapshot,
  };
  return "idempotentReplay" in output
    ? { ...view, idempotentReplay: output.idempotentReplay }
    : view;
}

function sendFleetProducerError(
  reply: FastifyReply,
  error: unknown,
  authorityReleaseIsServerInput = false,
): FastifyReply {
  if (error instanceof FleetProducerConflictError) {
    return reply.code(409).send({ code: "fleet_conflict", error: error.message });
  }
  if (
    error instanceof FleetProducerUnavailableError
    || error instanceof FleetSnapshotValidationError
  ) {
    return reply.code(503).send({
      code: "fleet_unavailable",
      error: "Autoritativer M5-Flottenzustand ist voruebergehend nicht verfuegbar.",
    });
  }
  if (error instanceof Error) {
    const nativeCode = /^([a-z][a-z0-9_]*):/.exec(error.message)?.[1];
    if (
      nativeCode !== undefined
      && [
        "idempotency_conflict",
        "revision_conflict",
        "state_hash_mismatch",
        "time_regression",
      ].includes(nativeCode)
    ) {
      return reply.code(409).send({ code: "fleet_conflict", error: error.message });
    }
    if (
      !authorityReleaseIsServerInput
      && (
        nativeCode === "invalid_fleet_authority"
        || nativeCode === "invalid_json"
        || nativeCode === "unsupported_schema"
        || error.message.startsWith("M5-Kommando")
      )
    ) {
      return reply.code(400).send({ code: "fleet_invalid_request", error: error.message });
    }
  }
  return reply.code(503).send({
    code: "fleet_unavailable",
    error: "Autoritativer M5-Flottenzustand ist voruebergehend nicht verfuegbar.",
  });
}

function fleetRouteErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error.validation !== undefined) {
    void reply.code(400).send({
      code: "fleet_invalid_request",
      error: "M5-Flottenauftrag hat ein ungueltiges Format.",
    });
    return;
  }
  request.log.error({ err: error }, "M5-Flottenendpunkt fehlgeschlagen");
  void reply.code(503).send({
    code: "fleet_unavailable",
    error: "Autoritativer M5-Flottenzustand ist voruebergehend nicht verfuegbar.",
  });
}

const PLANNING_APPLY_ALTERNATIVE_SCHEMA = "planning-apply-alternative/v1" as const;
const PLANNING_TRAIN_AUTHORIZATION_ERROR = "Planungsaktion ist nicht fuer den betroffenen Zug autorisiert.";

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
    genReqId: requestCorrelationId,
    // Unbekannte Felder nicht still entfernen: Ein manipulierter Client soll
    // eine sichtbare 400-Antwort erhalten, statt den Eindruck zu gewinnen,
    // technische Ausschreibungswerte erfolgreich gesetzt zu haben.
    ajv: { customOptions: { removeAdditional: false } },
  });
  const observability = new ApiObservability(deps.extraMetricSources);
  observability.register(app);
  const authenticate = createAuthenticator(deps.verifyToken);
  registerWorldLifecycleGate(app, deps.db);
  const operations = deps.operations ?? new OperationsRegistry();
  const assertDirectAdminAllowed = () => {
    if (deps.adminControl === "nonproduction-direct" || process.env["NODE_ENV"] === "test") return;
    throw new AuthorizationError("Produktive Verwaltungsaktionen beginnen ausschliesslich in Odoo (ADR-0023).");
  };
  const cooperationAuthority = new GameCooperationAuthority(deps.db, deps.fleetAuthorityReleases ?? {});
  const cooperation = deps.cooperation ?? new CooperationService(
    deps.db,
    cooperationAuthority,
    deps.fleetRuntime === undefined ? undefined : new GameFleetAssetTransferWriter(deps.fleetRuntime),
  );
  const abuseServices = deps.alpha ?? deps.alphaAbuse;
  const economyQueueClock = deps.economyQueueClock ?? (() => new Date());
  const cooperationSimulationSecond = deps.cooperationSimulationSecond ?? (async (worldId: string) => {
    const [row] = await deps.db.select({ epoch: worlds.epoch, factor: alphaWorldProfiles.accelerationFactor }).from(worlds)
      .leftJoin(alphaWorldProfiles, eq(alphaWorldProfiles.worldId, worlds.id))
      .where(eq(worlds.id, worldId))
      .limit(1);
    if (row === undefined) throw new CooperationNotFoundError(`Welt '${worldId}' wurde nicht gefunden.`);
    const now = abuseServices?.clock?.() ?? new Date();
    const elapsed = Math.max(0, Math.floor((now.getTime() - row.epoch.getTime()) / 1_000));
    const atS = elapsed * (row.factor ?? 1);
    if (!Number.isSafeInteger(atS)) throw new CooperationValidationError("Simulationszeit liegt außerhalb sicherer Ganzzahlen.");
    return atS;
  });
  const guardSensitiveAction = async (
    request: FastifyRequest,
    subject: string,
    worldId: string,
    actionClass: string,
    target: string,
    replayKey: string,
  ) => {
    if (abuseServices !== undefined) await guardAlphaAction({ db: deps.db, services: abuseServices }, request, worldId, subject, actionClass, target, replayKey);
  };
  const guardCooperationAction = abuseServices === undefined ? undefined : async (
    request: FastifyRequest,
    subject: string,
    actionClass: string,
    target: string,
    replayKey: string,
  ) => {
    const params = request.params as Record<string, unknown>;
    const worldId = params["worldId"];
    if (typeof worldId !== "string") throw new CooperationValidationError("Missbrauchsschutz findet keine Weltbindung.");
    try {
      await guardAlphaAction({ db: deps.db, services: abuseServices }, request, worldId, subject, actionClass, target, replayKey);
    } catch (error) {
      if (error instanceof AlphaAuthorizationError || error instanceof AlphaValidationError || error instanceof AlphaConflictError) {
        throw new CooperationConflictError(error.message, error.code);
      }
      throw error;
    }
  };
  registerCooperationRoutes(app, {
    db: deps.db,
    cooperation,
    authenticate,
    simulationSecond: cooperationSimulationSecond,
    resourceCatalog: (worldId, operatorId) => cooperationAuthority.resourceCatalog(worldId, operatorId),
    guardAction: guardCooperationAction,
  });
  if (deps.alpha !== undefined) registerAlphaRoutes(app, { db: deps.db, authenticate, services: deps.alpha });
  registerLivemapReadRoutes(app, {
    db: deps.db,
    livemap: deps.livemap,
    readModel: deps.livemapReadModel,
    authenticate,
  });
  if (deps.infraPackageStaging !== undefined || deps.infraUploadKeys !== undefined) {
    if (deps.infraPackageStaging === undefined || deps.infraUploadKeys === undefined || deps.infraUploadKeys.length === 0) {
      throw new Error("Infra-Paketstaging braucht gemeinsam eine lokale Wurzel und mindestens einen Uploadschlüssel.");
    }
    registerInfraPackageUploadRoutes(app, deps.infraPackageStaging, deps.infraUploadKeys);
  }

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
    observability.observeHealth(report);
    return reply.code(report.status === "down" ? 503 : 200).send(report);
  });

  // Dieser Endpunkt ist absichtlich nicht mit Keycloak geschuetzt: Er ist die
  // isolierte Maschinen-Grenze von Odoo zum Game. Signatur, Zeitfenster,
  // Mandant, Akteur und typisierter Inhalt werden vor dem persistierten Queue-
  // Commit geprueft; der nachgelagerte Worker entscheidet fachlich erneut.
  app.post<{ Body: OdooWebhookEnvelope }>(
    "/integrations/odoo/webhooks",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["schemaVersion", "eventId", "eventType", "occurredAt", "correlationId", "tenantId", "actorReference", "command"],
          properties: {
            schemaVersion: { type: "string" }, eventId: { type: "string" }, eventType: { type: "string" },
            occurredAt: { type: "string", format: "date-time" }, correlationId: { type: "string" }, tenantId: { type: "string" },
            actorReference: { type: "string" }, command: { type: "object" },
          },
        },
      },
    },
    async (request, reply) => {
      if (deps.odooWebhookStore === undefined || deps.odooWebhookOptions === undefined) {
        return reply.code(503).send({ error: "Odoo-Webhook-Receiver ist nicht konfiguriert." });
      }
      const keyId = request.headers["x-zugfolge-odoo-key-id"];
      const timestamp = request.headers["x-zugfolge-odoo-timestamp"];
      const signature = request.headers["x-zugfolge-odoo-signature"];
      if (typeof keyId !== "string" || typeof timestamp !== "string" || typeof signature !== "string") {
        return reply.code(401).send({ error: "Signaturkopf fehlt." });
      }
      try {
        const result = await receiveOdooWebhook(
          deps.odooWebhookStore,
          { keyId, timestamp, signature, payload: request.body } satisfies SignedPayload<OdooWebhookEnvelope>,
          deps.odooWebhookOptions,
        );
        return reply.code(result.duplicate ? 200 : 202).send(result);
      } catch (error) {
        if (error instanceof WebhookSignatureError) return reply.code(401).send({ error: error.message, code: error.code });
        if (error instanceof WebhookValidationError) return reply.code(403).send({ error: error.message, code: error.code });
        throw error;
      }
    },
  );

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
        const ownedOperators = await deps.db.select({ id: operators.id }).from(operators).where(and(
          eq(operators.worldId, request.params.worldId),
          eq(operators.foundingAccountId, account.id),
        ));
        return reply.send(encodeEconomyValue(economyStateForPlayer(state, new Set(ownedOperators.map((operator) => operator.id)))));
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
        assertDirectAdminAllowed();
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
        await persistEconomyTransition(deps.db, { expectedRevision: null, ...started, committedAt: new Date(request.body.at * 1_000), enqueuedAt: economyQueueClock() });
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
        assertDirectAdminAllowed();
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
        await persistEconomyTransition(deps.db, { expectedRevision: state.revision, ...announced, committedAt: new Date(request.body.announcedAt * 1_000), enqueuedAt: economyQueueClock() });
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
      readonly vehicleReference: {
        readonly fleetRevision: number;
        readonly snapshotHash: string;
        readonly formationId: string;
        readonly personnelDutyIds?: readonly string[];
        readonly pathReservationIds?: readonly string[];
        readonly entryFacility?: {
          readonly schemaVersion: typeof PUBLIC_ENTRY_FACILITY_SCHEMA;
          readonly providerOperatorId: "public";
        };
      };
      readonly promises: { readonly extraSeats: number; readonly punctualityBasisPoints: number; readonly additionalStops: number };
    };
  }>(
    "/worlds/:worldId/economy/tenders/:tenderId/operators/:operatorId/bids",
    { preHandler: authenticate, schema: { params: { type: "object", required: ["worldId", "tenderId", "operatorId"], properties: { worldId: { type: "string", format: "uuid" }, tenderId: { type: "string", minLength: 1 }, operatorId: { type: "string", format: "uuid" } } }, body: { type: "object", required: ["expectedRevision", "commandId", "bidId", "orderingFeeCentsPerTrainKm", "vehicleReference", "promises"], additionalProperties: false, properties: { expectedRevision: { type: "integer", minimum: 0 }, commandId: { type: "string", minLength: 1 }, bidId: { type: "string", minLength: 1 }, orderingFeeCentsPerTrainKm: { type: "string", pattern: "^[0-9]+$" }, vehicleReference: { type: "object", required: ["fleetRevision", "snapshotHash", "formationId"], additionalProperties: false, properties: { fleetRevision: { type: "integer", minimum: 0 }, snapshotHash: { type: "string", pattern: "^[a-f0-9]{64}$" }, formationId: { type: "string", minLength: 1 }, personnelDutyIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } }, pathReservationIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } }, entryFacility: { type: "object", required: ["schemaVersion", "providerOperatorId"], additionalProperties: false, properties: { schemaVersion: { const: PUBLIC_ENTRY_FACILITY_SCHEMA }, providerOperatorId: { const: "public" } } } } }, promises: { type: "object", required: ["extraSeats", "punctualityBasisPoints", "additionalStops"], additionalProperties: false, properties: { extraSeats: { type: "integer", minimum: 0 }, punctualityBasisPoints: { type: "integer", minimum: 0, maximum: 10000 }, additionalStops: { type: "integer", minimum: 0 } } } } } } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        await guardSensitiveAction(request, identity.keycloakSubject, request.params.worldId, "tender-bid", request.params.tenderId, request.body.commandId);
        const state = await loadEconomyWorldState(deps.db, request.params.worldId);
        if (state === undefined) return reply.code(404).send({ error: "Wirtschaftswelt ist noch nicht gestartet." });
        requireExpectedRevision(request.params.worldId, state.revision, request.body.expectedRevision);
        const lifecycle = state.tenders.get(request.params.tenderId);
        if (lifecycle === undefined) return reply.code(404).send({ error: "Ausschreibung existiert nicht." });
        const snapshot = await loadFleetMobilizationSnapshot(deps.db, request.params.worldId, request.body.vehicleReference);
        let vehicle: ReturnType<typeof resolveVehicleConcept>;
        if (request.body.vehicleReference.entryFacility === undefined) {
          vehicle = resolveVehicleConcept(snapshot, request.body.vehicleReference, { operatorId: request.params.operatorId, serviceLineIds: lifecycle.tender.specification.lines, operatingFrom: lifecycle.tender.operatingFrom });
        } else {
          const reference = request.body.vehicleReference;
          const entryFacility = reference.entryFacility;
          if (entryFacility === undefined || reference.personnelDutyIds === undefined || reference.pathReservationIds === undefined) {
            throw new FleetSnapshotValidationError("Facility-Gebot braucht Personaldienste und Trassenreservierungen.");
          }
          const facility = await publicEntryFacilityForWorld(deps.db, request.params.worldId, lifecycle.tender.lotId);
          vehicle = resolvePublicEntryFacilityVehicleConcept(snapshot, {
            ...reference,
            personnelDutyIds: reference.personnelDutyIds,
            pathReservationIds: reference.pathReservationIds,
            entryFacility,
          }, {
            providerOperatorId: facility.providerOperatorId,
            signedLotVehicleIds: facility.signedLotVehicleIds,
            signedLotPersonnelDutyIds: facility.signedLotPersonnelDutyIds,
            signedLotPathReceiptIds: facility.signedLotPathReceiptIds,
            serviceLineIds: lifecycle.tender.specification.lines,
            operatingFrom: lifecycle.tender.operatingFrom,
          });
        }
        const account = await getAccount(deps.db, { worldId: request.params.worldId, keycloakSubject: identity.keycloakSubject });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Weltzugang.");
        const submittedAt = await cooperationSimulationSecond(request.params.worldId);
        const smallLot = lifecycle.tender.closesAt - lifecycle.tender.opensAt <= 2 * 86_400;
        const next = submitBid(state, request.body.commandId, request.params.tenderId, { id: request.body.bidId, operatorId: request.params.operatorId, orderingFeeCentsPerTrainKm: BigInt(request.body.orderingFeeCentsPerTrainKm), vehicle, promises: request.body.promises, submittedAt }, { accountId: account.id, period: Math.floor(submittedAt / (state.profile.periodWeeks * 7 * 86_400)), smallLot, minimumScore: 4_000 });
        await persistEconomyTransition(deps.db, { expectedRevision: state.revision, state: next, effects: { notices: [], journal: [] }, committedAt: new Date(submittedAt * 1_000), enqueuedAt: economyQueueClock() });
        return reply.code(201).send(encodeEconomyValue(economyStateForPlayer(next, new Set([request.params.operatorId]))));
      } catch (error) {
        return sendEconomyError(reply, error);
      }
    },
  );

  app.put<{
    Params: { worldId: string; tenderId: string; operatorId: string };
    Body: { readonly expectedRevision: number; readonly commandId: string; readonly reference: FleetMobilizationReference };
  }>(
    "/worlds/:worldId/economy/tenders/:tenderId/operators/:operatorId/mobilization",
    { preHandler: authenticate, schema: { params: { type: "object", required: ["worldId", "tenderId", "operatorId"], properties: { worldId: { type: "string", format: "uuid" }, tenderId: { type: "string", minLength: 1 }, operatorId: { type: "string", format: "uuid" } } }, body: { type: "object", required: ["expectedRevision", "commandId", "reference"], additionalProperties: false, properties: { expectedRevision: { type: "integer", minimum: 0 }, commandId: { type: "string", minLength: 1 }, reference: { type: "object", required: ["fleetRevision", "snapshotHash", "formationIds", "personnelDutyIds", "pathReservationIds"], additionalProperties: false, properties: { fleetRevision: { type: "integer", minimum: 0 }, snapshotHash: { type: "string", pattern: "^[a-f0-9]{64}$" }, formationIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, personnelDutyIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, pathReservationIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, entryFacility: { type: "object", required: ["schemaVersion", "providerOperatorId"], additionalProperties: false, properties: { schemaVersion: { const: PUBLIC_ENTRY_FACILITY_SCHEMA }, providerOperatorId: { const: "public" } } } } } } } } },
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
        if (request.body.reference.entryFacility === undefined) {
          verifyMobilizationReference(snapshot, request.body.reference, {
            operatorId: request.params.operatorId,
            winningFormationId: lifecycle.winningBid.vehicle.formationId,
            serviceLineIds: lifecycle.tender.specification.lines,
            operatingFrom: lifecycle.tender.operatingFrom,
          });
        } else {
          const facility = await publicEntryFacilityForWorld(deps.db, request.params.worldId, lifecycle.tender.lotId);
          verifyPublicEntryFacilityMobilizationReference(snapshot, request.body.reference, {
            providerOperatorId: facility.providerOperatorId,
            signedLotVehicleIds: facility.signedLotVehicleIds,
            signedLotPersonnelDutyIds: facility.signedLotPersonnelDutyIds,
            signedLotPathReceiptIds: facility.signedLotPathReceiptIds,
            winningFormationId: lifecycle.winningBid.vehicle.formationId,
            serviceLineIds: lifecycle.tender.specification.lines,
            operatingFrom: lifecycle.tender.operatingFrom,
          });
        }
        const submittedAt = await cooperationSimulationSecond(request.params.worldId);
        const next = submitMobilizationReference(state, { commandId: request.body.commandId, tenderId: request.params.tenderId, operatorId: request.params.operatorId, at: submittedAt, reference: request.body.reference });
        await persistEconomyTransition(deps.db, { expectedRevision: state.revision, state: next, effects: { notices: [], journal: [] }, committedAt: new Date(submittedAt * 1_000), enqueuedAt: economyQueueClock() });
        return reply.send(encodeEconomyValue(economyStateForPlayer(next, new Set([request.params.operatorId]))));
      } catch (error) {
        return sendEconomyError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string; operatorId: string; contractId: string };
    Body: { readonly expectedRevision: number; readonly commandId: string };
  }>(
    "/worlds/:worldId/economy/operators/:operatorId/contracts/:contractId/settlements",
    { preHandler: authenticate, schema: { params: { type: "object", required: ["worldId", "operatorId", "contractId"], properties: { worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" }, contractId: { type: "string", minLength: 1 } } }, body: { type: "object", required: ["expectedRevision", "commandId"], additionalProperties: false, properties: { expectedRevision: { type: "integer", minimum: 0 }, commandId: { type: "string", minLength: 1 } } } } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const state = await loadEconomyWorldState(deps.db, request.params.worldId);
        if (state === undefined) return reply.code(404).send({ error: "Wirtschaftswelt ist noch nicht gestartet." });
        requireExpectedRevision(request.params.worldId, state.revision, request.body.expectedRevision);
        const contract = state.contracts.get(request.params.contractId);
        if (contract?.operatorId !== request.params.operatorId) throw new AuthorizationError("Vertrag gehört einem anderen EVU.");
        const tender = state.tenders.get(request.params.contractId)?.tender;
        if (tender === undefined || contract === undefined) throw new Error("Serverseitige Vertragsgrundlage fehlt.");
        if (!Number.isSafeInteger(tender.periodDurationSeconds) || tender.periodDurationSeconds <= 0 || contract.endsAt <= contract.startsAt) {
          throw new Error("Serverseitige Vertragsperioden sind ungueltig.");
        }
        const epoch = await loadEconomyWorldEpoch(deps.db, request.params.worldId);
        const currentSimulationSecond = await cooperationSimulationSecond(request.params.worldId);
        if (!Number.isSafeInteger(currentSimulationSecond) || currentSimulationSecond < 0) throw new Error("Serverseitige Simulationszeit ist ungueltig.");
        const periodCount = Math.ceil((contract.endsAt - contract.startsAt) / tender.periodDurationSeconds);
        if (!Number.isSafeInteger(periodCount) || periodCount <= 0) throw new Error("Serverseitige Vertragsperiodenzahl ist ungueltig.");
        let period: number | undefined;
        for (let candidate = 0; candidate < periodCount; candidate += 1) {
          if (state.settledPeriods.has(`${contract.id}:${candidate}`)) continue;
          const candidateStart = contract.startsAt + candidate * tender.periodDurationSeconds;
          const candidateEnd = Math.min(contract.endsAt, candidateStart + tender.periodDurationSeconds);
          if (currentSimulationSecond >= candidateEnd) period = candidate;
          break;
        }
        if (period === undefined) return reply.code(409).send({ error: "Keine unabgerechnete Vertragsperiode ist bereits abgeschlossen." });
        const periodStartS = contract.startsAt + period * tender.periodDurationSeconds;
        const periodEndS = Math.min(contract.endsAt, periodStartS + tender.periodDurationSeconds);
        if (!Number.isSafeInteger(periodStartS) || !Number.isSafeInteger(periodEndS) || periodStartS >= contract.endsAt) throw new Error("Serverseitige Vertragsperiode liegt ausserhalb der Vertragslaufzeit.");
        const firstServiceDay = new Date(epoch.getTime() + periodStartS * 1_000).toISOString().slice(0, 10);
        const lastServiceDay = new Date(epoch.getTime() + Math.max(periodStartS, periodEndS - 1) * 1_000).toISOString().slice(0, 10);
        const reports = await deps.db.select().from(dailyOperationReports).where(and(
          eq(dailyOperationReports.worldId, request.params.worldId),
          eq(dailyOperationReports.operatorId, request.params.operatorId),
          sql`${dailyOperationReports.serviceDay} between ${firstServiceDay} and ${lastServiceDay}`,
        )).orderBy(asc(dailyOperationReports.serviceDay));
        const expectedServiceDays = Math.floor((Date.parse(lastServiceDay) - Date.parse(firstServiceDay)) / 86_400_000) + 1;
        if (reports.length !== expectedServiceDays) return reply.code(409).send({ error: "Serverseitige Betriebsberichte der Vertragsperiode sind unvollstaendig." });
        let total = 0;
        let punctual = 0;
        let cancellations = 0;
        let missingSeats = 0;
        let missedConnections = 0;
        let trainKm = 0n;
        let costCents = 0n;
        let contractPenaltyCents = 0n;
        const evidence: string[] = [];
        for (const report of reports) {
          const projection = report.projection as Readonly<Record<string, unknown>>;
          const contracts = projection["contracts"] as Readonly<Record<string, unknown>> | undefined;
          const contractEvidence = (contracts?.[contract.id] ?? contracts?.[contract.lotId]) as Readonly<Record<string, unknown>> | undefined;
          const trainRuns = contractEvidence?.["trainRuns"] as Readonly<Record<string, unknown>> | undefined;
          const settlements = contractEvidence?.["settlements"] as Readonly<Record<string, unknown>> | undefined;
          if (trainRuns === undefined || settlements === undefined) throw new Error("Serverseitiger Betriebsbericht ist unvollstaendig.");
          const dayTotal = Number(trainRuns["total"] ?? 0);
          const dayPunctual = Number(trainRuns["punctual"] ?? 0);
          const dayCancellations = Number(trainRuns["cancelled"] ?? 0);
          const dayMissingSeats = Number(trainRuns["missingSeats"] ?? 0);
          const dayMissedConnections = Number(trainRuns["missedConnections"] ?? 0);
          const dayTrainKm = BigInt(String(trainRuns["trainKm"] ?? "0"));
          const dayCosts = BigInt(String(settlements["costCents"] ?? "0"));
          const dayPenalties = BigInt(String(settlements["contractPenaltyCents"] ?? "0"));
          if (![dayTotal, dayPunctual, dayCancellations, dayMissingSeats, dayMissedConnections].every(Number.isSafeInteger)
            || [dayTotal, dayPunctual, dayCancellations, dayMissingSeats, dayMissedConnections].some((value) => value < 0)
            || dayPunctual + dayCancellations > dayTotal || dayTrainKm < 0n || dayCosts < 0n || dayPenalties < 0n) {
            throw new Error("Serverseitiger Betriebsbericht besitzt ungueltige Leistungs- oder Kostenwerte.");
          }
          const nextCounts: [number, number, number, number, number] = [
            total + dayTotal,
            punctual + dayPunctual,
            cancellations + dayCancellations,
            missingSeats + dayMissingSeats,
            missedConnections + dayMissedConnections,
          ];
          if (!nextCounts.every(Number.isSafeInteger)) throw new Error("Serverseitiger Betriebsbericht ueberschreitet sichere Ganzzahlgrenzen.");
          [total, punctual, cancellations, missingSeats, missedConnections] = nextCounts;
          trainKm += dayTrainKm;
          costCents += dayCosts;
          contractPenaltyCents += dayPenalties;
          evidence.push(`daily-report:${report.id}`);
        }
        if (trainKm > tender.specification.trainKmPerPeriod) throw new Error("Serverseitige Zugkilometer ueberschreiten die bestellte Periodenleistung.");
        const punctualityBasisPoints = total === 0 ? 0 : Number(BigInt(punctual) * 10_000n / BigInt(total));
        const reference = `daily-reports:${firstServiceDay}:${lastServiceDay}`;
        const costs = [
          ...(costCents === 0n ? [] : [{ amountCents: costCents, costType: "administration" as const, costCentreId: contract.lotId, reference }]),
          ...(contractPenaltyCents === 0n ? [] : [{ amountCents: contractPenaltyCents, costType: "penalty" as const, costCentreId: contract.lotId, reference }]),
        ];
        const settled = settleContractPeriod(state, { commandId: request.body.commandId, contractId: request.params.contractId, period, at: periodEndS, performance: { trainKm, punctualityBasisPoints, cancellations, missingSeats, missedConnections, evidence: ["vehicles", "personnel", "paths", ...evidence] }, costs });
        await persistEconomyTransition(deps.db, { expectedRevision: state.revision, state: settled.state, effects: settled.effects, committedAt: new Date(epoch.getTime() + periodEndS * 1_000), enqueuedAt: economyQueueClock() });
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
        assertDirectAdminAllowed();
        const state = await loadEconomyWorldState(deps.db, request.params.worldId);
        if (state === undefined) return reply.code(404).send({ error: "Wirtschaftswelt ist noch nicht gestartet." });
        requireExpectedRevision(request.params.worldId, state.revision, request.body.expectedRevision);
        const escalated = escalateOperator(state, { commandId: request.body.commandId, operatorId: request.params.operatorId, accountId: request.body.accountId, period: request.body.period, at: request.body.at, signals: { ...request.body.signals, liquidCents: BigInt(request.body.signals.liquidCents), twoPeriodNeedCents: BigInt(request.body.signals.twoPeriodNeedCents), overdueCents: BigInt(request.body.signals.overdueCents) } });
        await persistEconomyTransition(deps.db, { expectedRevision: state.revision, state: escalated.state, effects: escalated.effects, committedAt: new Date(request.body.at * 1_000), enqueuedAt: economyQueueClock() });
        return reply.send(encodeEconomyValue(escalated.decision));
      } catch (error) {
        return sendEconomyError(reply, error);
      }
    },
  );

  if (deps.fleetIngestToken !== undefined) {
    app.post<{
      Params: { worldId: string };
      Body: { readonly producedAt: number };
    }>(
      "/internal/worlds/:worldId/fleet/initialize",
      {
        errorHandler: fleetRouteErrorHandler,
        schema: {
          params: worldIdParam,
          body: fleetInitializeBody,
        },
      },
      async (request, reply) => {
        if (!bearerMatches(request.headers.authorization, deps.fleetIngestToken!)) {
          return reply.code(401).send({
            code: "fleet_unauthorized",
            error: "Ungueltige Fleet-Ingest-Autorisierung.",
          });
        }
        if (!(await worldExists(deps.db, request.params.worldId))) {
          return reply.code(404).send({ code: "world_not_found", error: "Welt existiert nicht." });
        }
        if (deps.fleetRuntime === undefined || deps.fleetAuthorityReleases === undefined) {
          return reply.code(503).send({
            code: "fleet_unavailable",
            error: "Autoritativer M5-Flottenzustand ist nicht konfiguriert.",
          });
        }
        const authorityRelease = deps.fleetAuthorityReleases[request.params.worldId];
        if (authorityRelease === undefined) {
          return reply.code(404).send({
            code: "fleet_authority_release_not_found",
            error: "Fuer diese Welt ist kein M5-Authority-Release konfiguriert.",
          });
        }
        try {
          const initialized = await initializeFleetProducer({
            db: deps.db as EconomyDatabase,
            runtime: deps.fleetRuntime,
            initialization: {
              schemaVersion: FLEET_INITIALIZE_SCHEMA,
              worldId: request.params.worldId,
              producedAt: request.body.producedAt,
              authorityRelease,
            },
            ingestedAt: new Date(),
          });
          return reply.send(fleetResultView(initialized));
        } catch (error) {
          return sendFleetProducerError(reply, error, true);
        }
      },
    );

    app.post<{
      Params: { worldId: string };
      Body: FleetCommandBody;
    }>(
      "/internal/worlds/:worldId/fleet/commands",
      {
        errorHandler: fleetRouteErrorHandler,
        schema: {
          params: worldIdParam,
          body: fleetCommandBody,
        },
      },
      async (request, reply) => {
        if (!bearerMatches(request.headers.authorization, deps.fleetIngestToken!)) {
          return reply.code(401).send({
            code: "fleet_unauthorized",
            error: "Ungueltige Fleet-Ingest-Autorisierung.",
          });
        }
        if (!(await worldExists(deps.db, request.params.worldId))) {
          return reply.code(404).send({ code: "world_not_found", error: "Welt existiert nicht." });
        }
        if (deps.fleetRuntime === undefined || deps.fleetAuthorityReleases === undefined) {
          return reply.code(503).send({
            code: "fleet_unavailable",
            error: "Autoritativer M5-Flottenzustand ist nicht konfiguriert.",
          });
        }
        if (deps.fleetAuthorityReleases[request.params.worldId] === undefined) {
          return reply.code(404).send({
            code: "fleet_authority_release_not_found",
            error: "Fuer diese Welt ist kein M5-Authority-Release konfiguriert.",
          });
        }
        try {
          const result = await applyFleetProducerCommand({
            db: deps.db as EconomyDatabase,
            runtime: deps.fleetRuntime,
            command: { ...request.body, worldId: request.params.worldId } as NativeFleetCommand,
            ingestedAt: new Date(),
          });
          return reply.send(fleetResultView(result));
        } catch (error) {
          return sendFleetProducerError(reply, error);
        }
      },
    );
  }

  if (deps.simulationIngestToken !== undefined) {
    app.post<{
      Params: { worldId: string; regionId: string };
      Body: Omit<
        RegionalSimulationInitialization,
        "schemaVersion" | "worldId" | "regionId"
      >;
    }>(
      "/internal/worlds/:worldId/regional-simulations/:regionId/initialize",
      {
        errorHandler: regionalSimulationRouteErrorHandler,
        schema: {
          params: regionalSimulationParams,
          body: regionalInitializationSchema,
        },
      },
      async (request, reply) => {
        if (!bearerMatches(request.headers.authorization, deps.simulationIngestToken!)) {
          return reply.code(401).send({
            code: "regional_simulation_unauthorized",
            error: "Ungueltige Simulations-Ingest-Autorisierung.",
          });
        }
        if (!(await worldExists(deps.db, request.params.worldId))) {
          return reply.code(404).send({
            code: "world_not_found",
            error: "Welt existiert nicht.",
          });
        }
        if (deps.regionalSimulation === undefined) {
          return reply.code(503).send({
            code: "regional_simulation_unavailable",
            error: "Regionaler Rust-Single-Writer ist nicht verfuegbar.",
          });
        }
        try {
          const initialized = await deps.regionalSimulation.initialize(
            {
              ...request.body,
              schemaVersion: REGIONAL_SIMULATION_INITIALIZE_SCHEMA,
              worldId: request.params.worldId,
              regionId: request.params.regionId,
            },
            new Date(),
          );
          return reply.code(201).send(initialized);
        } catch (error) {
          return sendRegionalSimulationError(reply, error);
        }
      },
    );

    app.post<{
      Params: { worldId: string; regionId: string; commandId: string };
      Body: RegionalSimulationCommandPayload;
    }>(
      "/internal/worlds/:worldId/regional-simulations/:regionId/commands/:commandId",
      {
        errorHandler: regionalSimulationRouteErrorHandler,
        schema: {
          params: regionalSimulationCommandParams,
          body: regionalCommandSchema,
        },
      },
      async (request, reply) => {
        if (!bearerMatches(request.headers.authorization, deps.simulationIngestToken!)) {
          return reply.code(401).send({
            code: "regional_simulation_unauthorized",
            error: "Ungueltige Simulations-Ingest-Autorisierung.",
          });
        }
        if (!(await worldExists(deps.db, request.params.worldId))) {
          return reply.code(404).send({
            code: "world_not_found",
            error: "Welt existiert nicht.",
          });
        }
        if (deps.regionalSimulation === undefined) {
          return reply.code(503).send({
            code: "regional_simulation_unavailable",
            error: "Regionaler Rust-Single-Writer ist nicht verfuegbar.",
          });
        }
        try {
          const result = await deps.regionalSimulation.apply(
            {
              worldId: request.params.worldId,
              regionId: request.params.regionId,
              commandId: request.params.commandId,
              command: request.body,
            },
            new Date(),
          );
          return reply.send(result);
        } catch (error) {
          return sendRegionalSimulationError(reply, error);
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
        const reservedEvent = request.body.events.find((event) =>
          RESERVED_SINGLE_WRITER_EVENT_TYPES.has(event.eventType),
        );
        if (reservedEvent !== undefined) {
          return reply.code(409).send({
            code: "reserved_single_writer_event_type",
            error: `Ereignistyp '${reservedEvent.eventType}' darf nur sein fachlicher Single-Writer schreiben.`,
          });
        }
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
        const after = request.query.after ?? 0;
        const ownedOperatorIds = new Set(
          (await listOperatorsForAccount(deps.db, identity.keycloakSubject))
            .filter((operator) =>
              operator.worldId === request.params.worldId
              && operator.foundingAccountId === account.id)
            .map((operator) => operator.id),
        );
        const rawEvents = await worldEventLog(deps.db, request.params.worldId).listAfter(
          after,
          request.query.limit ?? 500,
        );
        return reply.send(projectSimulationEventBatch(rawEvents, ownedOperatorIds, after));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string };
    Body: PlanningPlayerPathRequestBody;
  }>(
    "/worlds/:worldId/planning/path-requests",
    {
      preHandler: authenticate,
      errorHandler: planningRouteErrorHandler,
      schema: {
        params: worldIdParam,
        body: PLANNING_PLAYER_PATH_REQUEST_BODY_SCHEMA,
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({
          code: "planning_unauthorized",
          error: "Keine Identitaet.",
        });
      }
      if (!(await worldExists(deps.db, request.params.worldId))) {
        return reply.code(404).send({
          code: "world_not_found",
          error: "Welt existiert nicht.",
        });
      }
      try {
        const account = await getAccount(deps.db, {
          worldId: request.params.worldId,
          keycloakSubject: identity.keycloakSubject,
        });
        if (account === undefined) {
          throw new AuthorizationError("Kein aktiver Zugang zu dieser Welt.");
        }
        await guardSensitiveAction(request, identity.keycloakSubject, request.params.worldId, "path-window", request.body.requestId, request.body.requestId);
        const authoritativeBody = await resolveAuthoritativePlanningPathRequest(
          deps.db as EconomyDatabase,
          {
            worldId: request.params.worldId,
            accountId: account.id,
            body: request.body,
          },
        );
        const command = await queuePlanningPathRequest(deps.db, {
          worldId: request.params.worldId,
          requestingAccountId: account.id,
          body: authoritativeBody,
          submittedAt: new Date(),
        });
        return reply.code(202).send(command);
      } catch (error) {
        return sendPlanningQueueError(reply, error);
      }
    },
  );

  if (deps.simulationIngestToken !== undefined) {
    app.post<{
      Params: { worldId: string };
      Body: PlanningCoordinateAuthorityBody;
    }>(
      "/internal/worlds/:worldId/planning/coordinate",
      {
        errorHandler: planningRouteErrorHandler,
        schema: {
          params: worldIdParam,
          body: PLANNING_COORDINATE_AUTHORITY_BODY_SCHEMA,
        },
      },
      async (request, reply) => {
        if (!bearerMatches(request.headers.authorization, deps.simulationIngestToken!)) {
          return reply.code(401).send({
            code: "planning_unauthorized",
            error: "Ungueltige Simulations-Ingest-Autorisierung.",
          });
        }
        if (!(await worldExists(deps.db, request.params.worldId))) {
          return reply.code(404).send({
            code: "world_not_found",
            error: "Welt existiert nicht.",
          });
        }
        const authorityAccountId =
          deps.planningAuthorityAccountIds?.[request.params.worldId];
        if (authorityAccountId === undefined) {
          return reply.code(503).send({
            code: "planning_authority_unconfigured",
            error: "Planning-Authority ist fuer diese Welt nicht konfiguriert.",
          });
        }
        if (
          !(await isActivePlanningAuthorityAccount(
            deps.db,
            request.params.worldId,
            authorityAccountId,
          ))
        ) {
          return reply.code(503).send({
            code: "planning_authority_unavailable",
            error: "Konfiguriertes Planning-Authority-Konto ist nicht aktiv.",
          });
        }
        try {
          const command = await queuePlanningCoordinate(deps.db, {
            worldId: request.params.worldId,
            authorityAccountId,
            body: request.body,
            submittedAt: new Date(),
          });
          return reply.code(202).send(command);
        } catch (error) {
          return sendPlanningQueueError(reply, error);
        }
      },
    );
  }

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/planning/diagram",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        const account = await getAccount(deps.db, { worldId: request.params.worldId, keycloakSubject: identity.keycloakSubject });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Zugang zu dieser Welt.");
        const [planningWorld] = await deps.db.select({ epoch: worlds.epoch }).from(worlds)
          .where(eq(worlds.id, request.params.worldId)).limit(1);
        if (planningWorld === undefined) return reply.code(404).send({ error: "Welt fehlt." });
        const event = await worldEventLog(deps.db, request.params.worldId).latestOfType("planning.diagram");
        if (event === undefined) return reply.code(404).send({ error: "Noch kein Planner-Ergebnis veröffentlicht." });
        const parsed = planningProjectionForWorld(event.payload, request.params.worldId);
        if (parsed.projection === undefined) return reply.code(503).send({ error: parsed.error });
        return reply.send({
          sequence: event.sequence,
          timeBasis: { epoch: planningWorld.epoch.toISOString(), timeZone: "Europe/Berlin", operatingDayBoundaryS: 0 },
          data: parsed.projection,
        });
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
          throw new AuthorizationError(PLANNING_TRAIN_AUTHORIZATION_ERROR);
        }
        const [ownedRequest] = await deps.db
          .select({
            id: simulationCommands.id,
            operatorId: sql<string>`${simulationCommands.payload}->>'operatorId'`,
          })
          .from(simulationCommands)
          .where(and(
            eq(simulationCommands.worldId, request.params.worldId),
            eq(simulationCommands.requestingAccountId, account.id),
            eq(simulationCommands.commandType, "planning.path-request"),
            eq(simulationCommands.status, "processed"),
            eq(simulationCommands.resultEventSequence, event.sequence),
            sql`${simulationCommands.payload}->>'trainId' = ${offered.alternative.trainId}`,
          ))
          .limit(1);
        const [boundOperator] = ownedRequest === undefined
          ? []
          : await deps.db.select({ id: operators.id }).from(operators).where(and(
              eq(operators.worldId, request.params.worldId),
              eq(operators.id, ownedRequest.operatorId),
              eq(operators.foundingAccountId, account.id),
            )).limit(1);
        if (ownedRequest === undefined || boundOperator === undefined) {
          throw new AuthorizationError(PLANNING_TRAIN_AUTHORIZATION_ERROR);
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
            .where(and(
              eq(simulationCommands.worldId, request.params.worldId),
              eq(simulationCommands.status, "pending"),
              notInArray(simulationCommands.commandType, [...RESERVED_PLANNING_COMMAND_TYPES]),
            ))
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
        const [pending] = await deps.db
          .select({ commandType: simulationCommands.commandType })
          .from(simulationCommands)
          .where(and(
            eq(simulationCommands.worldId, request.params.worldId),
            eq(simulationCommands.id, request.params.commandId),
            eq(simulationCommands.status, "pending"),
          ))
          .limit(1);
        if (
          pending !== undefined &&
          RESERVED_PLANNING_COMMAND_TYPES.includes(
            pending.commandType as (typeof RESERVED_PLANNING_COMMAND_TYPES)[number],
          )
        ) {
          return reply.code(409).send({
            code: "reserved_planning_command_type",
            error: `Kommando '${pending.commandType}' darf nur der Planning-Worker abschliessen.`,
          });
        }
        const [updated] = await deps.db
          .update(simulationCommands)
          .set({ status: request.body.status, processedAt: new Date(request.body.processedAt), resultEventSequence: request.body.resultEventSequence, failureCode: request.body.failureCode })
          .where(and(
            eq(simulationCommands.worldId, request.params.worldId),
            eq(simulationCommands.id, request.params.commandId),
            eq(simulationCommands.status, "pending"),
            notInArray(simulationCommands.commandType, [...RESERVED_PLANNING_COMMAND_TYPES]),
          ))
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
        const feed = deps.livemap.initializedWorld(request.params.worldId);
        if (feed === undefined) {
          return reply.code(503).send({ error: "Livemap besitzt noch keinen autoritativen Rust-Initialsnapshot." });
        }
        return reply.send(feed.snapshot());
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
        if (deps.livemap === undefined) {
          return reply.code(503).send({ error: "Livemap-Publisher nicht verfügbar." });
        }
        const initializedFeed = deps.livemap.initializedWorld(request.params.worldId);
        if (initializedFeed === undefined) {
          return reply.code(503).send({ error: "Livemap besitzt noch keinen autoritativen Rust-Initialsnapshot." });
        }
        feed = initializedFeed;
      } catch (error) {
        if (error instanceof LivemapCapacityError) {
          return reply.code(503).send({ error: "Livemap vorübergehend ausgelastet." });
        }
        return sendError(reply, error);
      }
      const lastEventHeader = request.headers["last-event-id"];
      const rawLastEventId = Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader;
      const currentSnapshot = feed.snapshot();
      const cursor = rawLastEventId === undefined
        ? { streamId: currentSnapshot.streamId, sequence: currentSnapshot.sequence }
        : parseLivemapEventId(rawLastEventId);
      if (cursor === undefined) {
        return reply.code(400).send({
          error: "Last-Event-ID muss aus Streamkennung und nichtnegativer Sequenz bestehen.",
        });
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

      const subscription = feed.subscribeAfter(cursor, (delta) => {
        enqueue(`id: ${livemapEventId(delta)}\ndata: ${JSON.stringify(delta)}\n\n`);
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
        enqueue(`id: ${livemapEventId(delta)}\ndata: ${JSON.stringify(delta)}\n\n`);
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

  app.get("/public-world-contracts", { preHandler: authenticate }, async (request, reply) => {
    if (request.identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
    const rows = await deps.db.select({ world: worlds, profile: alphaWorldProfiles })
      .from(worlds)
      .innerJoin(alphaWorldProfiles, eq(alphaWorldProfiles.worldId, worlds.id))
      .where(and(eq(worlds.worldKind, "public"), eq(worlds.lifecycleStatus, "active"), eq(alphaWorldProfiles.state, "running")))
      .orderBy(asc(worlds.name), asc(worlds.id));
    const now = deps.publicWorldClock?.() ?? new Date();
    if (Number.isNaN(now.getTime())) throw new RangeError("Weltvertragszeit ist ungueltig.");
    const contracts = rows.map(({ world, profile }) => {
      const startingCapitalPolicy = decodeStartingCapitalPolicy(profile);
      const closesAt = profile.periodCount === null ? null : new Date(
        world.epoch.getTime() + profile.periodCount * world.schedulePeriodWeeks * 7 * 86_400_000,
      ).toISOString();
      return {
        schemaVersion: "zugfolge-public-world-contract/v1",
        contractHash: profile.blueprintHash,
        worldId: world.id,
        name: world.name,
        region: { id: profile.regionId, name: "Leipzig–Halle–Erfurt", variant: profile.regionVariant },
        noWipe: true,
        schedulePeriodWeeks: world.schedulePeriodWeeks,
        duration: profile.periodCount === null ? { kind: "unlimited" as const } : { kind: "periods" as const, periodCount: profile.periodCount },
        timeBasis: { mode: "realtime" as const, accelerationFactor: profile.accelerationFactor, epoch: world.epoch.toISOString(), timeZone: "Europe/Berlin" as const },
        entry: {
          status: !supportedPublicEntryPolicy(startingCapitalPolicy)
            ? "configuration-incomplete" as const
            : now.getTime() < world.epoch.getTime() ? "scheduled" as const : "open" as const,
          requiresContractConfirmation: true,
          opensAt: world.epoch.toISOString(),
          closesAt,
        },
        startingCapitalPolicy,
        releases: { infra: profile.infraReleaseHash, timetable: profile.timetableReleaseHash, fleet: profile.fleetReleaseHash, economy: profile.economyReleaseHash },
      };
    });
    return reply.send(contracts);
  });

  app.post<{ Params: { worldId: string }; Body: { displayName: string; acceptedWorldContractHash?: string } }>(
    "/worlds/:worldId/access",
    {
      preHandler: authenticate,
      schema: {
        params: worldIdParam,
        body: {
          type: "object",
          required: ["displayName"],
          additionalProperties: false,
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 64 },
            acceptedWorldContractHash: { type: "string", minLength: 1, maxLength: 64 },
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
        const [targetWorld] = await deps.db
          .select({
            epoch: worlds.epoch,
            worldKind: worlds.worldKind,
            lifecycleStatus: worlds.lifecycleStatus,
            profile: alphaWorldProfiles,
            tutorialSessionId: tutorialSessions.id,
          })
          .from(worlds)
          .leftJoin(alphaWorldProfiles, eq(alphaWorldProfiles.worldId, worlds.id))
          .leftJoin(tutorialSessions, eq(tutorialSessions.tutorialWorldId, worlds.id))
          .where(eq(worlds.id, request.params.worldId))
          .limit(1);
        if (targetWorld === undefined) {
          return reply.code(404).send({ code: "world_not_found", error: "Welt wurde nicht gefunden." });
        }
        if (targetWorld.lifecycleStatus !== "active") {
          return reply.code(409).send({ code: "world_not_active", error: "Archivierte Welten sind schreibgeschuetzt." });
        }
        if (targetWorld.worldKind === "private") {
          if (targetWorld.profile?.profileKind === "tutorial" || targetWorld.tutorialSessionId !== null) {
            return reply.code(403).send({
              code: "tutorial_session_required",
              error: "Tutorialwelten sind ausschliesslich ueber ihre gebundene Tutorialsitzung erreichbar.",
            });
          }
          return reply.code(403).send({
            code: "private_world_access_managed",
            error: "Zugang zu privaten Welten wird ausschliesslich serverseitig provisioniert.",
          });
        }
        if (targetWorld.worldKind === "public") {
          const accessAt = deps.publicWorldClock?.() ?? new Date();
          if (Number.isNaN(accessAt.getTime())) throw new RangeError("Weltzugangszeit ist ungueltig.");
          if (accessAt.getTime() < targetWorld.epoch.getTime()) {
            return reply.code(409).send({
              code: "world_not_open",
              error: "Die Welt ist noch nicht geoeffnet.",
              opensAt: targetWorld.epoch.toISOString(),
            });
          }
          const startingCapitalPolicy = targetWorld.profile === null ? null : decodeStartingCapitalPolicy(targetWorld.profile);
          if (targetWorld.profile === null || targetWorld.profile.state !== "running"
            || !supportedPublicEntryPolicy(startingCapitalPolicy)) {
            return reply.code(409).send({
              code: "world_contract_invalid",
              error: "Der serverseitige Weltvertrag ist unvollstaendig und erlaubt keinen Markteintritt.",
            });
          }
          if (request.body.acceptedWorldContractHash !== targetWorld.profile.blueprintHash) {
            return reply.code(409).send({
              code: "world_contract_confirmation_required",
              error: "Der aktuelle Weltvertrag muss vor dem Markteintritt bestaetigt werden.",
              contractHash: targetWorld.profile.blueprintHash,
            });
          }
          const account = await requestPublicWorldAccessAtomically(deps.db, {
            worldId: request.params.worldId,
            keycloakSubject: identity.keycloakSubject,
            displayName: request.body.displayName,
            acceptedWorldContractHash: request.body.acceptedWorldContractHash,
          });
          return reply.code(201).send(account);
        }
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

  app.post<{ Body: { name: string; schedulePeriodWeeks: number; epoch: string } }>(
    "/private-worlds",
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: "object", additionalProperties: false, required: ["name", "schedulePeriodWeeks", "epoch"],
          properties: { name: { type: "string", minLength: 1, maxLength: 80 }, schedulePeriodWeeks: { type: "integer", minimum: 3, maximum: 8 }, epoch: { type: "string", format: "date-time" } },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        const entitlements = await activeEntitlementsForSubject(deps.db, identity.keycloakSubject);
        assertPrivateWorldEntitlement(entitlements.map((record) => ({ subject: record.keycloakSubject, productKind: record.productKind, status: record.status, validFrom: record.validFrom, validUntil: record.validUntil ?? undefined, quantity: Number(record.quantity) })));
        const [world] = await deps.db.insert(worlds).values({ name: request.body.name, schedulePeriodWeeks: request.body.schedulePeriodWeeks, epoch: new Date(request.body.epoch), worldKind: "private", rankingStatus: "unranked" }).returning();
        if (world === undefined) throw new Error("Private Welt konnte nicht angelegt werden.");
        await requestWorldAccess(deps.db, { worldId: world.id, keycloakSubject: identity.keycloakSubject, displayName: identity.displayName });
        return reply.code(201).send(world);
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
        assertDirectAdminAllowed();
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

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/starting-capital-policy",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
      try {
        const account = await getAccount(deps.db, {
          worldId: request.params.worldId,
          keycloakSubject: identity.keycloakSubject,
        });
        if (account === undefined) throw new NoAccountInWorldError(request.params.worldId);
        return reply.send(serializeStartingCapitalPolicy(
          await startingCapitalPolicyForWorld(deps.db, request.params.worldId),
        ));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

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
        const [world] = await deps.db.select({ worldKind: worlds.worldKind }).from(worlds)
          .where(eq(worlds.id, request.params.worldId)).limit(1);
        const founder = {
          worldId: request.params.worldId,
          foundingKeycloakSubject: identity.keycloakSubject,
          name: request.body.name,
        };
        const operator = world?.worldKind === "public"
          ? await foundPublicOperatorWithStartingCapital(deps.db, founder)
          : await foundOperator(deps.db, founder);
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
  // M8 — weltgeheftete Störungsrichtlinie und auditierter manueller Modus
  app.get<{ Params: { worldId: string }; Querystring: { atS?: number } }>(
    "/worlds/:worldId/disruptions/policy",
    {
      preHandler: authenticate,
      schema: {
        params: worldIdParam,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { atS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 } },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        const account = await getAccount(deps.db, { worldId: request.params.worldId, keycloakSubject: identity.keycloakSubject });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Zugang zu dieser Welt.");
        const [policy] = await deps.db.select().from(disruptionPolicies).where(and(
          eq(disruptionPolicies.worldId, request.params.worldId),
          lte(disruptionPolicies.validFromS, request.query.atS ?? 0),
        )).orderBy(desc(disruptionPolicies.validFromS), desc(disruptionPolicies.version)).limit(1);
        return policy === undefined
          ? reply.code(404).send({ error: "Für diese Welt ist keine wirksame Störungsrichtlinie veröffentlicht." })
          : reply.send(policy);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string };
    Body: {
      readonly requestedAtS: number;
      readonly effectiveAtS: number;
      readonly plannedWorksMode: "REALISTIC" | "SIMULATED" | "MANUAL";
      readonly operationalIncidentMode: "REALISTIC" | "SIMULATED" | "MANUAL";
      readonly providerSetId?: string;
      readonly simulationProfile: Record<string, unknown>;
      readonly rulesetVersion: string;
      readonly reason: string;
    };
  }>(
    "/worlds/:worldId/disruptions/policies",
    {
      preHandler: authenticate,
      schema: {
        params: worldIdParam,
        body: {
          type: "object",
          required: ["requestedAtS", "effectiveAtS", "plannedWorksMode", "operationalIncidentMode", "simulationProfile", "rulesetVersion", "reason"],
          additionalProperties: false,
          properties: {
            requestedAtS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            effectiveAtS: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            plannedWorksMode: { type: "string", enum: ["REALISTIC", "SIMULATED", "MANUAL"] },
            operationalIncidentMode: { type: "string", enum: ["REALISTIC", "SIMULATED", "MANUAL"] },
            providerSetId: { type: "string", minLength: 1, maxLength: 200 },
            simulationProfile: { type: "object" },
            rulesetVersion: { type: "string", minLength: 1, maxLength: 200 },
            reason: { type: "string", minLength: 8, maxLength: 1_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireWorldAdminAccount(deps.db, request.params.worldId, identity.keycloakSubject);
        assertDirectAdminAllowed();
        const account = await getAccount(deps.db, { worldId: request.params.worldId, keycloakSubject: identity.keycloakSubject });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Weltadministrator.");
        const [world] = await deps.db.select().from(worlds).where(eq(worlds.id, request.params.worldId)).limit(1);
        if (world === undefined) return reply.code(404).send({ error: "Welt existiert nicht." });
        const periodSeconds = world.schedulePeriodWeeks * 7 * 86_400;
        if (request.body.effectiveAtS <= request.body.requestedAtS || request.body.effectiveAtS % periodSeconds !== 0) {
          return reply.code(400).send({ error: "Policywechsel muss an einem künftigen veröffentlichten Fahrplanstichtag liegen." });
        }
        const realistic = request.body.plannedWorksMode === "REALISTIC" || request.body.operationalIncidentMode === "REALISTIC";
        if (realistic && request.body.providerSetId === undefined) {
          return reply.code(400).send({ error: "REALISTIC benötigt ein benanntes, rechtegeprüftes Provider-Set." });
        }
        if (realistic) {
          const [provider] = await deps.db.select({
            rightsStatus: disruptionProviderStates.rightsStatus,
            enabled: disruptionProviderStates.enabled,
            rightsReference: disruptionProviderStates.rightsReference,
          }).from(disruptionProviderStates).where(and(
            eq(disruptionProviderStates.worldId, request.params.worldId),
            eq(disruptionProviderStates.providerSetId, request.body.providerSetId!),
          )).limit(1);
          if (provider?.rightsStatus !== "approved" || provider.enabled !== "enabled" || provider.rightsReference === null) {
            return reply.code(400).send({ error: "Provider-Set ist fuer diese Welt nicht vollstaendig rechtegeprueft und aktiviert." });
          }
        }
        const [latest] = await deps.db.select({ version: disruptionPolicies.version }).from(disruptionPolicies)
          .where(eq(disruptionPolicies.worldId, request.params.worldId))
          .orderBy(desc(disruptionPolicies.version)).limit(1);
        const version = (latest?.version ?? 0) + 1;
        const [saved] = await deps.db.insert(disruptionPolicies).values({
          worldId: request.params.worldId,
          version,
          status: "scheduled",
          plannedWorksMode: request.body.plannedWorksMode,
          operationalIncidentMode: request.body.operationalIncidentMode,
          providerSetId: request.body.providerSetId,
          simulationProfile: request.body.simulationProfile,
          rulesetVersion: request.body.rulesetVersion,
          validFromS: request.body.effectiveAtS,
          requestedByAccountId: account.id,
          changeReason: request.body.reason,
          publishedAt: new Date(world.epoch.getTime() + request.body.requestedAtS * 1_000),
        }).returning();
        return reply.code(201).send(saved);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string };
    Body: {
      readonly idempotencyKey: string;
      readonly regionId: string;
      readonly kind: "planned" | "unplanned";
      readonly publishedAtS: number;
      readonly startsAtS: number;
      readonly endsAtS: number;
      readonly positionMm: number;
      readonly causeCode: number;
      readonly fineCauseId: string;
      readonly cause: string;
      readonly affectedResources: readonly Record<string, unknown>[];
      readonly affectedResource: string;
      readonly affectedTrainRunIds: readonly string[];
      readonly delaySeconds: number;
      readonly effect: {
        readonly kind: "closure" | "single-track" | "speed-restriction" | "platform-change" | "traffic-hold" | "route-deviation" | "vehicle-restriction" | "platform-usable-length";
      };
    };
  }>(
    "/worlds/:worldId/disruptions/manual",
    {
      preHandler: authenticate,
      schema: {
        params: worldIdParam,
        body: {
          type: "object",
          required: ["idempotencyKey", "regionId", "kind", "publishedAtS", "startsAtS", "endsAtS", "positionMm", "causeCode", "fineCauseId", "cause", "affectedResources", "affectedResource", "affectedTrainRunIds", "delaySeconds", "effect"],
          additionalProperties: false,
          properties: {
            idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
            regionId: { type: "string", minLength: 1, maxLength: 200 },
            kind: { type: "string", enum: ["planned", "unplanned"] },
            publishedAtS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            startsAtS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            endsAtS: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            positionMm: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            causeCode: { type: "integer", minimum: 10, maximum: 90 },
            fineCauseId: { type: "string", minLength: 3, maxLength: 160, pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)*$" },
            cause: { type: "string", minLength: 8, maxLength: 1_000 },
            affectedResources: { type: "array", minItems: 1, maxItems: 1_000, items: { type: "object" } },
            affectedResource: { type: "string", minLength: 1, maxLength: 500 },
            affectedTrainRunIds: { type: "array", maxItems: 10_000, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
            delaySeconds: { type: "integer", minimum: 0, maximum: 604_800 },
            effect: {
              type: "object",
              required: ["kind"],
              additionalProperties: true,
              properties: {
                kind: { type: "string", enum: ["closure", "single-track", "speed-restriction", "platform-change", "traffic-hold", "route-deviation", "vehicle-restriction", "platform-usable-length"] },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireWorldAdminAccount(deps.db, request.params.worldId, identity.keycloakSubject);
        assertDirectAdminAllowed();
        if (request.body.startsAtS >= request.body.endsAtS) return reply.code(400).send({ error: "Störungsende muss nach dem Beginn liegen." });
        if (request.body.publishedAtS > request.body.startsAtS) return reply.code(400).send({ error: "Veröffentlichung darf nicht nach dem Beginn liegen." });
        const account = await getAccount(deps.db, { worldId: request.params.worldId, keycloakSubject: identity.keycloakSubject });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Weltadministrator.");
        let [command] = await deps.db.insert(simulationCommands).values({
          worldId: request.params.worldId,
          requestingAccountId: account.id,
          idempotencyKey: request.body.idempotencyKey,
          commandType: "disruption.manual",
          payload: { worldId: request.params.worldId, ...request.body },
          submittedAt: new Date(),
        }).onConflictDoNothing({ target: [simulationCommands.worldId, simulationCommands.requestingAccountId, simulationCommands.idempotencyKey] }).returning();
        if (command === undefined) {
          [command] = await deps.db.select().from(simulationCommands).where(and(
            eq(simulationCommands.worldId, request.params.worldId),
            eq(simulationCommands.requestingAccountId, account.id),
            eq(simulationCommands.idempotencyKey, request.body.idempotencyKey),
          )).limit(1);
        }
        if (command === undefined) throw new Error("Audit-Kommando konnte nicht gespeichert oder geladen werden.");
        if (deps.regionalSimulation === undefined) return reply.code(202).send(command);
        const result = await deps.regionalSimulation.apply(
          {
            worldId: request.params.worldId,
            regionId: request.body.regionId,
            commandId: `manual-disruption:${command.id}`,
            command: {
              type: "register-disruption",
              disruption: {
                disruptionId: command.id,
                kind: request.body.kind,
                publishedAtS: request.body.publishedAtS,
                startsAtS: request.body.startsAtS,
                validUntilS: request.body.endsAtS,
                positionMm: request.body.positionMm,
                causeCode: request.body.causeCode,
                fineCauseId: request.body.fineCauseId,
                effect: request.body.effect.kind,
                affectedResource: request.body.affectedResource,
                affectedTrainRunIds: request.body.affectedTrainRunIds,
                delaySeconds: request.body.delaySeconds,
              },
            },
          },
          command.submittedAt,
        );
        const [processed] = await deps.db.update(simulationCommands).set({
          status: "processed",
          processedAt: new Date(),
          failureCode: null,
        }).where(and(
          eq(simulationCommands.worldId, request.params.worldId),
          eq(simulationCommands.id, command.id),
        )).returning();
        return reply.send({ command: processed ?? command, result });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

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
        body: { type: "object", required: ["idempotencyKey", "action", "reason"], additionalProperties: false, properties: { idempotencyKey: { type: "string", minLength: 1, maxLength: 128 }, action: { type: "string", enum: ACTIONS }, reason: { type: "string", minLength: 8, maxLength: 500 } } },
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
        const submittedAt = await cooperationSimulationSecond(request.params.worldId);
        let [command] = await deps.db.insert(simulationCommands).values({
          worldId: request.params.worldId,
          requestingAccountId: account.id,
          idempotencyKey: request.body.idempotencyKey,
          commandType: "dispatch.manual-override",
          payload: { operatorId: request.params.operatorId, decisionId: request.params.decisionId, action: request.body.action, reason: request.body.reason, at: submittedAt },
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
        await requireWorldAdminAccount(deps.db, request.params.worldId, identity.keycloakSubject);
        assertDirectAdminAllowed();
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
        await requireWorldAdminAccount(deps.db, request.params.worldId, identity.keycloakSubject);
        assertDirectAdminAllowed();
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
        const asOf = deps.mailboxClock?.() ?? new Date();
        const inbox = await listInbox(deps.db, {
          worldId: request.params.worldId,
          requestingKeycloakSubject: identity.keycloakSubject,
          asOf,
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
        const asOf = deps.mailboxClock?.() ?? new Date();
        const message = await acknowledgeMessage(deps.db, {
          worldId: request.params.worldId,
          messageId: request.params.messageId,
          actingKeycloakSubject: identity.keycloakSubject,
          acknowledgedAt: asOf,
        });
        return reply.send(projectInboxMessage(message, asOf));
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
        assertDirectAdminAllowed();
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
