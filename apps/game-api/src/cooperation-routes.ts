import {
  CooperationAuthorizationError,
  CooperationConflictError,
  CooperationNotFoundError,
  CooperationService,
  CooperationValidationError,
  type CooperationPage,
  type VehicleTransferResult,
} from "@zugfolge/cooperation";
import { operators, type OperatorContract, type VehicleMarketListing } from "@zugfolge/db";
import { AuthorizationError, getAccount, type IdentityDatabase } from "@zugfolge/identity";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { createAuthenticator } from "./auth.js";
import type { CooperationResourceCatalog } from "./cooperation-authority.js";

const worldParams = {
  type: "object",
  required: ["worldId"],
  additionalProperties: false,
  properties: { worldId: { type: "string", format: "uuid" } },
} as const;

const operatorParams = {
  type: "object",
  required: ["worldId", "operatorId"],
  additionalProperties: false,
  properties: {
    worldId: { type: "string", format: "uuid" },
    operatorId: { type: "string", format: "uuid" },
  },
} as const;

const pageQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    cursor: { type: "string", minLength: 1, maxLength: 96 },
    view: { type: "string", enum: ["actionable", "archive", "all"], default: "actionable" },
    deadlineBeforeS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const;

type PageQuery = {
  readonly limit?: number;
  readonly cursor?: string;
  readonly view?: "actionable" | "archive" | "all";
  readonly deadlineBeforeS?: number;
};

const CONTRACT_SCHEMA_VERSION = "zugfolge-operator-contract/v1" as const;
const LISTING_SCHEMA_VERSION = "zugfolge-vehicle-market-listing/v1" as const;
const PAGE_SCHEMA_VERSION = "zugfolge-cooperation-page/v1" as const;
const TRANSFER_SCHEMA_VERSION = "zugfolge-vehicle-transfer-result/v1" as const;

function sendCooperationError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof CooperationAuthorizationError || error instanceof AuthorizationError) {
    return reply.code(403).send({ error: error.message });
  }
  if (error instanceof CooperationNotFoundError) return reply.code(404).send({ error: error.message });
  if (error instanceof CooperationConflictError) return reply.code(409).send({ code: error.code, error: error.message });
  if (error instanceof CooperationValidationError) return reply.code(400).send({ code: error.code, error: error.message });
  throw error;
}

function apiPayload(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(apiPayload);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, apiPayload(entry)]));
  }
  return value;
}

function recordPayload(value: object): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, apiPayload(entry)]));
}

function contractPayload(value: OperatorContract): Readonly<Record<string, unknown>> {
  return { schemaVersion: CONTRACT_SCHEMA_VERSION, ...recordPayload(value) };
}

function listingPayload(value: VehicleMarketListing): Readonly<Record<string, unknown>> {
  return { schemaVersion: LISTING_SCHEMA_VERSION, ...recordPayload(value) };
}

function pagePayload<T extends OperatorContract | VehicleMarketListing>(
  value: CooperationPage<T>,
  serializeItem: (item: T) => Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: PAGE_SCHEMA_VERSION,
    items: value.items.map(serializeItem),
    nextCursor: value.nextCursor,
  };
}

function transferPayload(value: VehicleTransferResult): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: TRANSFER_SCHEMA_VERSION,
    ...recordPayload(value),
    listing: listingPayload(value.listing),
    ...(value.contract === undefined ? {} : { contract: contractPayload(value.contract) }),
  };
}

async function actingAccount(db: IdentityDatabase, worldId: string, subject: string) {
  const account = await getAccount(db, { worldId, keycloakSubject: subject });
  if (account === undefined) throw new AuthorizationError("Kein aktiver Weltzugang.");
  return account;
}

async function requireOwner(db: IdentityDatabase, worldId: string, operatorId: string, subject: string) {
  const account = await actingAccount(db, worldId, subject);
  const [operator] = await db.select({ foundingAccountId: operators.foundingAccountId }).from(operators).where(and(
    eq(operators.worldId, worldId), eq(operators.id, operatorId),
  )).limit(1);
  if (operator === undefined) throw new CooperationNotFoundError(`EVU '${operatorId}' existiert nicht in dieser Welt.`);
  if (operator.foundingAccountId !== account.id) throw new CooperationAuthorizationError(`Identität darf nicht für EVU '${operatorId}' handeln.`);
  return account;
}

export function registerCooperationRoutes(
  app: FastifyInstance,
  deps: {
    readonly db: IdentityDatabase;
    readonly cooperation: CooperationService;
    readonly authenticate: ReturnType<typeof createAuthenticator>;
    readonly simulationSecond: (worldId: string) => Promise<number>;
    readonly resourceCatalog: (worldId: string, operatorId: string) => Promise<CooperationResourceCatalog>;
    readonly guardAction?: (request: FastifyRequest, subject: string, actionClass: string, target: string, replayKey: string) => Promise<void>;
  },
): void {
  app.get<{ Params: { worldId: string; operatorId: string } }>(
    "/worlds/:worldId/operators/:operatorId/cooperation-resources",
    { preHandler: deps.authenticate, schema: { params: operatorParams } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        return reply.send(apiPayload(await deps.resourceCatalog(request.params.worldId, request.params.operatorId)));
      } catch (error) {
        return sendCooperationError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string; operatorId: string };
    Body: {
      offereeOperatorId: string;
      contractType: "traction" | "vehicle-rental" | "connection" | "disruption-assistance";
      subject: Readonly<Record<string, unknown>>;
      terms: Readonly<Record<string, unknown>>;
      priceCents: string;
      validFromS: number;
      validUntilS: number;
      responseDeadlineS: number;
      terminationNoticeS: number;
      idempotencyKey: string;
    };
  }>("/worlds/:worldId/operators/:operatorId/contracts", {
    preHandler: deps.authenticate,
    schema: {
      params: operatorParams,
      body: {
        type: "object",
        additionalProperties: false,
        required: ["offereeOperatorId", "contractType", "subject", "terms", "priceCents", "validFromS", "validUntilS", "responseDeadlineS", "terminationNoticeS", "idempotencyKey"],
        properties: {
          offereeOperatorId: { type: "string", format: "uuid" },
          contractType: { type: "string", enum: ["traction", "vehicle-rental", "connection", "disruption-assistance"] },
          subject: { type: "object" },
          terms: { type: "object" },
          priceCents: { type: "string", pattern: "^[0-9]+$" },
          validFromS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          validUntilS: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          responseDeadlineS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          terminationNoticeS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
    },
  }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
    try {
      await deps.guardAction?.(request, identity.keycloakSubject, "operator-contract", request.body.offereeOperatorId, request.body.idempotencyKey);
      const account = await requireOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
      const offeredAtS = await deps.simulationSecond(request.params.worldId);
      return reply.code(201).send(contractPayload(await deps.cooperation.offerContract({
        worldId: request.params.worldId,
        offerorOperatorId: request.params.operatorId,
        offereeOperatorId: request.body.offereeOperatorId,
        offeredByAccountId: account.id,
        contractType: request.body.contractType,
        subject: request.body.subject,
        terms: request.body.terms,
        priceCents: BigInt(request.body.priceCents),
        validFromS: request.body.validFromS,
        validUntilS: request.body.validUntilS,
        responseDeadlineS: request.body.responseDeadlineS,
        terminationNoticeS: request.body.terminationNoticeS,
        offeredAtS,
        idempotencyKey: request.body.idempotencyKey,
      })));
    } catch (error) {
      return sendCooperationError(reply, error);
    }
  });

  app.get<{ Params: { worldId: string; operatorId: string }; Querystring: PageQuery }>(
    "/worlds/:worldId/operators/:operatorId/contracts",
    { preHandler: deps.authenticate, schema: { params: operatorParams, querystring: pageQuery } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        return reply.send(pagePayload(
          await deps.cooperation.pageContracts(request.params.worldId, request.params.operatorId, request.query),
          contractPayload,
        ));
      } catch (error) {
        return sendCooperationError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string; operatorId: string; contractId: string };
    Body: { response: "accept" | "reject"; idempotencyKey: string };
  }>("/worlds/:worldId/operators/:operatorId/contracts/:contractId/respond", {
    preHandler: deps.authenticate,
    schema: {
      params: { type: "object", required: ["worldId", "operatorId", "contractId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" }, contractId: { type: "string", format: "uuid" } } },
      body: { type: "object", required: ["response", "idempotencyKey"], additionalProperties: false, properties: { response: { type: "string", enum: ["accept", "reject"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 200 } } },
    },
  }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
    try {
      await deps.guardAction?.(request, identity.keycloakSubject, "operator-contract", request.params.contractId, request.body.idempotencyKey);
      const account = await requireOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
      const atS = await deps.simulationSecond(request.params.worldId);
      const contract = await deps.cooperation.respondToContract({
        worldId: request.params.worldId,
        contractId: request.params.contractId,
        actingOperatorId: request.params.operatorId,
        actingAccountId: account.id,
        atS,
        response: request.body.response,
        idempotencyKey: request.body.idempotencyKey,
      });
      return reply.send(contractPayload(contract));
    } catch (error) {
      return sendCooperationError(reply, error);
    }
  });

  app.post<{
    Params: { worldId: string; operatorId: string; contractId: string };
    Body: { reason: string; idempotencyKey: string };
  }>("/worlds/:worldId/operators/:operatorId/contracts/:contractId/end", {
    preHandler: deps.authenticate,
    schema: {
      params: { type: "object", required: ["worldId", "operatorId", "contractId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" }, contractId: { type: "string", format: "uuid" } } },
      body: { type: "object", required: ["reason", "idempotencyKey"], additionalProperties: false, properties: { reason: { type: "string", minLength: 8, maxLength: 500 }, idempotencyKey: { type: "string", minLength: 1, maxLength: 200 } } },
    },
  }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
    try {
      await deps.guardAction?.(request, identity.keycloakSubject, "operator-contract", request.params.contractId, request.body.idempotencyKey);
      const account = await requireOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
      const atS = await deps.simulationSecond(request.params.worldId);
      return reply.send(contractPayload(await deps.cooperation.terminateContract({
        worldId: request.params.worldId,
        contractId: request.params.contractId,
        actingOperatorId: request.params.operatorId,
        actingAccountId: account.id,
        atS,
        reason: request.body.reason,
        idempotencyKey: request.body.idempotencyKey,
      })));
    } catch (error) {
      return sendCooperationError(reply, error);
    }
  });

  app.post<{
    Params: { worldId: string; operatorId: string; contractId: string };
    Body: { reason: string; evidenceReference: string; idempotencyKey: string };
  }>("/worlds/:worldId/operators/:operatorId/contracts/:contractId/non-performance", {
    preHandler: deps.authenticate,
    schema: {
      params: { type: "object", required: ["worldId", "operatorId", "contractId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" }, contractId: { type: "string", format: "uuid" } } },
      body: { type: "object", required: ["reason", "evidenceReference", "idempotencyKey"], additionalProperties: false, properties: { reason: { type: "string", minLength: 8, maxLength: 500 }, evidenceReference: { type: "string", pattern: "^daily-operation-report/v1:[0-9]{4}-[0-9]{2}-[0-9]{2}$", maxLength: 64 }, idempotencyKey: { type: "string", minLength: 1, maxLength: 200 } } },
    },
  }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
    try {
      await deps.guardAction?.(request, identity.keycloakSubject, "operator-contract", request.params.contractId, request.body.idempotencyKey);
      const account = await requireOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
      const atS = await deps.simulationSecond(request.params.worldId);
      return reply.send(contractPayload(await deps.cooperation.terminateContract({
        worldId: request.params.worldId,
        contractId: request.params.contractId,
        actingOperatorId: request.params.operatorId,
        actingAccountId: account.id,
        atS,
        reason: request.body.reason,
        evidenceReference: request.body.evidenceReference,
        idempotencyKey: request.body.idempotencyKey,
      })));
    } catch (error) {
      return sendCooperationError(reply, error);
    }
  });

  app.get<{ Params: { worldId: string }; Querystring: PageQuery }>(
    "/worlds/:worldId/vehicle-market/listings",
    { preHandler: deps.authenticate, schema: { params: worldParams, querystring: pageQuery } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await actingAccount(deps.db, request.params.worldId, identity.keycloakSubject);
        return reply.send(pagePayload(
          await deps.cooperation.pageListings(request.params.worldId, request.query),
          listingPayload,
        ));
      } catch (error) {
        return sendCooperationError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string; operatorId: string; vehicleId: string };
    Body: { listingType: "sale" | "rental"; priceCents: string; rentalValidUntilS?: number; expiresAtS: number; idempotencyKey: string };
  }>("/worlds/:worldId/operators/:operatorId/vehicles/:vehicleId/listings", {
    preHandler: deps.authenticate,
    schema: {
      params: { type: "object", required: ["worldId", "operatorId", "vehicleId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" }, vehicleId: { type: "string", minLength: 1, maxLength: 200 } } },
      body: { type: "object", required: ["listingType", "priceCents", "expiresAtS", "idempotencyKey"], additionalProperties: false, properties: { listingType: { type: "string", enum: ["sale", "rental"] }, priceCents: { type: "string", pattern: "^[1-9][0-9]*$" }, rentalValidUntilS: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, expiresAtS: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, idempotencyKey: { type: "string", minLength: 1, maxLength: 200 } } },
    },
  }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
    try {
      await deps.guardAction?.(request, identity.keycloakSubject, "vehicle-market", request.params.vehicleId, request.body.idempotencyKey);
      const account = await requireOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
      const listedAtS = await deps.simulationSecond(request.params.worldId);
      return reply.code(201).send(listingPayload(await deps.cooperation.createListing({
        worldId: request.params.worldId,
        vehicleId: request.params.vehicleId,
        offeringOperatorId: request.params.operatorId,
        actingAccountId: account.id,
        listingType: request.body.listingType,
        priceCents: BigInt(request.body.priceCents),
        rentalValidUntilS: request.body.rentalValidUntilS,
        listedAtS,
        expiresAtS: request.body.expiresAtS,
        idempotencyKey: request.body.idempotencyKey,
      })));
    } catch (error) {
      return sendCooperationError(reply, error);
    }
  });

  app.post<{
    Params: { worldId: string; listingId: string };
    Body: { buyerOperatorId: string; expectedRevision: number; idempotencyKey: string };
  }>("/worlds/:worldId/vehicle-market/listings/:listingId/reserve", {
    preHandler: deps.authenticate,
    schema: {
      params: { type: "object", required: ["worldId", "listingId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, listingId: { type: "string", format: "uuid" } } },
      body: { type: "object", required: ["buyerOperatorId", "expectedRevision", "idempotencyKey"], additionalProperties: false, properties: { buyerOperatorId: { type: "string", format: "uuid" }, expectedRevision: { type: "integer", minimum: 1 }, idempotencyKey: { type: "string", minLength: 1, maxLength: 200 } } },
    },
  }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
    try {
      await deps.guardAction?.(request, identity.keycloakSubject, "vehicle-market", request.params.listingId, request.body.idempotencyKey);
      const account = await requireOwner(deps.db, request.params.worldId, request.body.buyerOperatorId, identity.keycloakSubject);
      const atS = await deps.simulationSecond(request.params.worldId);
      return reply.send(listingPayload(await deps.cooperation.reserveListing({
        worldId: request.params.worldId,
        listingId: request.params.listingId,
        buyerOperatorId: request.body.buyerOperatorId,
        actingAccountId: account.id,
        atS,
        expectedRevision: request.body.expectedRevision,
        idempotencyKey: request.body.idempotencyKey,
      })));
    } catch (error) {
      return sendCooperationError(reply, error);
    }
  });

  app.post<{
    Params: { worldId: string; listingId: string };
    Body: { buyerOperatorId: string; expectedRevision: number; idempotencyKey: string };
  }>("/worlds/:worldId/vehicle-market/listings/:listingId/transfer", {
    preHandler: deps.authenticate,
    schema: {
      params: { type: "object", required: ["worldId", "listingId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, listingId: { type: "string", format: "uuid" } } },
      body: { type: "object", required: ["buyerOperatorId", "expectedRevision", "idempotencyKey"], additionalProperties: false, properties: { buyerOperatorId: { type: "string", format: "uuid" }, expectedRevision: { type: "integer", minimum: 1 }, idempotencyKey: { type: "string", minLength: 1, maxLength: 200 } } },
    },
  }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
    try {
      await deps.guardAction?.(request, identity.keycloakSubject, "vehicle-market", request.params.listingId, request.body.idempotencyKey);
      const account = await requireOwner(deps.db, request.params.worldId, request.body.buyerOperatorId, identity.keycloakSubject);
      const atS = await deps.simulationSecond(request.params.worldId);
      return reply.send(transferPayload(await deps.cooperation.transferListing({
        worldId: request.params.worldId,
        listingId: request.params.listingId,
        buyerOperatorId: request.body.buyerOperatorId,
        actingAccountId: account.id,
        atS,
        expectedRevision: request.body.expectedRevision,
        idempotencyKey: request.body.idempotencyKey,
      })));
    } catch (error) {
      return sendCooperationError(reply, error);
    }
  });

  app.post<{
    Params: { worldId: string; listingId: string };
    Body: { buyerOperatorId: string; reasonCode: string; idempotencyKey: string };
  }>("/worlds/:worldId/vehicle-market/listings/:listingId/reverse", {
    preHandler: deps.authenticate,
    schema: {
      params: { type: "object", required: ["worldId", "listingId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, listingId: { type: "string", format: "uuid" } } },
      body: { type: "object", required: ["buyerOperatorId", "reasonCode", "idempotencyKey"], additionalProperties: false, properties: { buyerOperatorId: { type: "string", format: "uuid" }, reasonCode: { type: "string", minLength: 1, maxLength: 200 }, idempotencyKey: { type: "string", minLength: 1, maxLength: 200 } } },
    },
  }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
    try {
      await deps.guardAction?.(request, identity.keycloakSubject, "vehicle-market", request.params.listingId, request.body.idempotencyKey);
      const account = await requireOwner(deps.db, request.params.worldId, request.body.buyerOperatorId, identity.keycloakSubject);
      const atS = await deps.simulationSecond(request.params.worldId);
      return reply.send(transferPayload(await deps.cooperation.reverseTransfer({
        worldId: request.params.worldId,
        listingId: request.params.listingId,
        buyerOperatorId: request.body.buyerOperatorId,
        actingAccountId: account.id,
        atS,
        reasonCode: request.body.reasonCode,
        idempotencyKey: request.body.idempotencyKey,
      })));
    } catch (error) {
      return sendCooperationError(reply, error);
    }
  });

  app.post<{
    Params: { worldId: string; operatorId: string; listingId: string };
    Body: { expectedRevision: number; idempotencyKey: string };
  }>("/worlds/:worldId/operators/:operatorId/vehicle-market/listings/:listingId/cancel", {
    preHandler: deps.authenticate,
    schema: {
      params: { type: "object", required: ["worldId", "operatorId", "listingId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" }, listingId: { type: "string", format: "uuid" } } },
      body: { type: "object", required: ["expectedRevision", "idempotencyKey"], additionalProperties: false, properties: { expectedRevision: { type: "integer", minimum: 1 }, idempotencyKey: { type: "string", minLength: 1, maxLength: 200 } } },
    },
  }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
    try {
      await deps.guardAction?.(request, identity.keycloakSubject, "vehicle-market", request.params.listingId, request.body.idempotencyKey);
      const account = await requireOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
      const atS = await deps.simulationSecond(request.params.worldId);
      return reply.send(listingPayload(await deps.cooperation.cancelListing({
        worldId: request.params.worldId,
        listingId: request.params.listingId,
        offeringOperatorId: request.params.operatorId,
        actingAccountId: account.id,
        atS,
        expectedRevision: request.body.expectedRevision,
        idempotencyKey: request.body.idempotencyKey,
      })));
    } catch (error) {
      return sendCooperationError(reply, error);
    }
  });

  app.get<{ Params: { worldId: string; operatorId: string } }>(
    "/worlds/:worldId/operators/:operatorId/vehicles",
    { preHandler: deps.authenticate, schema: { params: operatorParams } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        return reply.send(apiPayload(await deps.cooperation.listOwnedVehicles(
          request.params.worldId,
          request.params.operatorId,
        )));
      } catch (error) {
        return sendCooperationError(reply, error);
      }
    },
  );

  app.get<{ Params: { worldId: string; vehicleId: string } }>(
    "/worlds/:worldId/vehicles/:vehicleId/history",
    {
      preHandler: deps.authenticate,
      schema: { params: { type: "object", required: ["worldId", "vehicleId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, vehicleId: { type: "string", minLength: 1, maxLength: 200 } } } },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await actingAccount(deps.db, request.params.worldId, identity.keycloakSubject);
        return reply.send(apiPayload(await deps.cooperation.listVehicleHistory(request.params.worldId, request.params.vehicleId)));
      } catch (error) {
        return sendCooperationError(reply, error);
      }
    },
  );

}
