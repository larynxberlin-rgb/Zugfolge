import {
  CooperationAuthorizationError,
  CooperationConflictError,
  CooperationNotFoundError,
  CooperationService,
  CooperationValidationError,
} from "@zugfolge/cooperation";
import { operators } from "@zugfolge/db";
import { AuthorizationError, getAccount, type IdentityDatabase } from "@zugfolge/identity";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { createAuthenticator } from "./auth.js";

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
    readonly guardAction?: (request: FastifyRequest, subject: string, actionClass: string, target: string, replayKey: string) => Promise<void>;
  },
): void {
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
      offeredAtS: number;
      idempotencyKey: string;
    };
  }>("/worlds/:worldId/operators/:operatorId/contracts", {
    preHandler: deps.authenticate,
    schema: {
      params: operatorParams,
      body: {
        type: "object",
        additionalProperties: false,
        required: ["offereeOperatorId", "contractType", "subject", "terms", "priceCents", "validFromS", "validUntilS", "responseDeadlineS", "terminationNoticeS", "offeredAtS", "idempotencyKey"],
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
          offeredAtS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
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
      return reply.code(201).send(apiPayload(await deps.cooperation.offerContract({
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
        offeredAtS: request.body.offeredAtS,
        idempotencyKey: request.body.idempotencyKey,
      })));
    } catch (error) {
      return sendCooperationError(reply, error);
    }
  });

  app.get<{ Params: { worldId: string; operatorId: string } }>(
    "/worlds/:worldId/operators/:operatorId/contracts",
    { preHandler: deps.authenticate, schema: { params: operatorParams } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await requireOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        return reply.send(apiPayload(await deps.cooperation.listContracts(request.params.worldId, request.params.operatorId)));
      } catch (error) {
        return sendCooperationError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string; operatorId: string; contractId: string };
    Body: { response: "accept" | "reject"; atS: number };
  }>("/worlds/:worldId/operators/:operatorId/contracts/:contractId/respond", {
    preHandler: deps.authenticate,
    schema: {
      params: { type: "object", required: ["worldId", "operatorId", "contractId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" }, contractId: { type: "string", format: "uuid" } } },
      body: { type: "object", required: ["response", "atS"], additionalProperties: false, properties: { response: { type: "string", enum: ["accept", "reject"] }, atS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } } },
    },
  }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
    try {
      await deps.guardAction?.(request, identity.keycloakSubject, "operator-contract", request.params.contractId, `${request.params.contractId}:${request.body.response}`);
      const account = await requireOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
      const contract = await deps.cooperation.respondToContract({
        worldId: request.params.worldId,
        contractId: request.params.contractId,
        actingAccountId: account.id,
        atS: request.body.atS,
        response: request.body.response,
      });
      if (contract.offereeOperatorId !== request.params.operatorId) throw new CooperationAuthorizationError("Antwortendes EVU ist nicht die empfangende Partei.");
      return reply.send(apiPayload(contract));
    } catch (error) {
      return sendCooperationError(reply, error);
    }
  });

  app.post<{
    Params: { worldId: string; operatorId: string; contractId: string };
    Body: { atS: number; reason: string; nonPerformance?: boolean };
  }>("/worlds/:worldId/operators/:operatorId/contracts/:contractId/end", {
    preHandler: deps.authenticate,
    schema: {
      params: { type: "object", required: ["worldId", "operatorId", "contractId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" }, contractId: { type: "string", format: "uuid" } } },
      body: { type: "object", required: ["atS", "reason"], additionalProperties: false, properties: { atS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, reason: { type: "string", minLength: 8, maxLength: 500 }, nonPerformance: { type: "boolean", default: false } } },
    },
  }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
    try {
      await deps.guardAction?.(request, identity.keycloakSubject, "operator-contract", request.params.contractId, `${request.params.contractId}:end:${request.body.reason}`);
      const account = await requireOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
      return reply.send(apiPayload(await deps.cooperation.terminateContract({
        worldId: request.params.worldId,
        contractId: request.params.contractId,
        actingAccountId: account.id,
        atS: request.body.atS,
        reason: request.body.reason,
        nonPerformance: request.body.nonPerformance,
      })));
    } catch (error) {
      return sendCooperationError(reply, error);
    }
  });

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/vehicle-market/listings",
    { preHandler: deps.authenticate, schema: { params: worldParams } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        await actingAccount(deps.db, request.params.worldId, identity.keycloakSubject);
        return reply.send(apiPayload(await deps.cooperation.listListings(request.params.worldId)));
      } catch (error) {
        return sendCooperationError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string; operatorId: string; vehicleId: string };
    Body: { listingType: "sale" | "rental"; priceCents: string; rentalValidUntilS?: number; listedAtS: number; expiresAtS: number; idempotencyKey: string };
  }>("/worlds/:worldId/operators/:operatorId/vehicles/:vehicleId/listings", {
    preHandler: deps.authenticate,
    schema: {
      params: { type: "object", required: ["worldId", "operatorId", "vehicleId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" }, vehicleId: { type: "string", minLength: 1, maxLength: 200 } } },
      body: { type: "object", required: ["listingType", "priceCents", "listedAtS", "expiresAtS", "idempotencyKey"], additionalProperties: false, properties: { listingType: { type: "string", enum: ["sale", "rental"] }, priceCents: { type: "string", pattern: "^[1-9][0-9]*$" }, rentalValidUntilS: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, listedAtS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, expiresAtS: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, idempotencyKey: { type: "string", minLength: 1, maxLength: 200 } } },
    },
  }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
    try {
      await deps.guardAction?.(request, identity.keycloakSubject, "vehicle-market", request.params.vehicleId, request.body.idempotencyKey);
      const account = await requireOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
      return reply.code(201).send(apiPayload(await deps.cooperation.createListing({
        worldId: request.params.worldId,
        vehicleId: request.params.vehicleId,
        offeringOperatorId: request.params.operatorId,
        actingAccountId: account.id,
        listingType: request.body.listingType,
        priceCents: BigInt(request.body.priceCents),
        rentalValidUntilS: request.body.rentalValidUntilS,
        listedAtS: request.body.listedAtS,
        expiresAtS: request.body.expiresAtS,
        idempotencyKey: request.body.idempotencyKey,
      })));
    } catch (error) {
      return sendCooperationError(reply, error);
    }
  });

  app.post<{
    Params: { worldId: string; listingId: string };
    Body: { buyerOperatorId: string; atS: number; reservedUntilS: number; expectedRevision: number };
  }>("/worlds/:worldId/vehicle-market/listings/:listingId/reserve", {
    preHandler: deps.authenticate,
    schema: {
      params: { type: "object", required: ["worldId", "listingId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, listingId: { type: "string", format: "uuid" } } },
      body: { type: "object", required: ["buyerOperatorId", "atS", "reservedUntilS", "expectedRevision"], additionalProperties: false, properties: { buyerOperatorId: { type: "string", format: "uuid" }, atS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, reservedUntilS: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, expectedRevision: { type: "integer", minimum: 1 } } },
    },
  }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
    try {
      await deps.guardAction?.(request, identity.keycloakSubject, "vehicle-market", request.params.listingId, `${request.params.listingId}:reserve:${request.body.expectedRevision}`);
      const account = await requireOwner(deps.db, request.params.worldId, request.body.buyerOperatorId, identity.keycloakSubject);
      return reply.send(apiPayload(await deps.cooperation.reserveListing({
        worldId: request.params.worldId,
        listingId: request.params.listingId,
        buyerOperatorId: request.body.buyerOperatorId,
        actingAccountId: account.id,
        atS: request.body.atS,
        reservedUntilS: request.body.reservedUntilS,
        expectedRevision: request.body.expectedRevision,
      })));
    } catch (error) {
      return sendCooperationError(reply, error);
    }
  });

  app.post<{
    Params: { worldId: string; listingId: string };
    Body: { buyerOperatorId: string; atS: number; expectedRevision: number; idempotencyKey: string };
  }>("/worlds/:worldId/vehicle-market/listings/:listingId/transfer", {
    preHandler: deps.authenticate,
    schema: {
      params: { type: "object", required: ["worldId", "listingId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, listingId: { type: "string", format: "uuid" } } },
      body: { type: "object", required: ["buyerOperatorId", "atS", "expectedRevision", "idempotencyKey"], additionalProperties: false, properties: { buyerOperatorId: { type: "string", format: "uuid" }, atS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, expectedRevision: { type: "integer", minimum: 1 }, idempotencyKey: { type: "string", minLength: 1, maxLength: 200 } } },
    },
  }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
    try {
      await deps.guardAction?.(request, identity.keycloakSubject, "vehicle-market", request.params.listingId, request.body.idempotencyKey);
      const account = await requireOwner(deps.db, request.params.worldId, request.body.buyerOperatorId, identity.keycloakSubject);
      return reply.send(apiPayload(await deps.cooperation.transferListing({
        worldId: request.params.worldId,
        listingId: request.params.listingId,
        buyerOperatorId: request.body.buyerOperatorId,
        actingAccountId: account.id,
        atS: request.body.atS,
        expectedRevision: request.body.expectedRevision,
        idempotencyKey: request.body.idempotencyKey,
      })));
    } catch (error) {
      return sendCooperationError(reply, error);
    }
  });

  app.post<{
    Params: { worldId: string; listingId: string };
    Body: { buyerOperatorId: string; atS: number; reasonCode: string; idempotencyKey: string };
  }>("/worlds/:worldId/vehicle-market/listings/:listingId/reverse", {
    preHandler: deps.authenticate,
    schema: {
      params: { type: "object", required: ["worldId", "listingId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, listingId: { type: "string", format: "uuid" } } },
      body: { type: "object", required: ["buyerOperatorId", "atS", "reasonCode", "idempotencyKey"], additionalProperties: false, properties: { buyerOperatorId: { type: "string", format: "uuid" }, atS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, reasonCode: { type: "string", minLength: 1, maxLength: 200 }, idempotencyKey: { type: "string", minLength: 1, maxLength: 200 } } },
    },
  }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
    try {
      await deps.guardAction?.(request, identity.keycloakSubject, "vehicle-market", request.params.listingId, request.body.idempotencyKey);
      const account = await requireOwner(deps.db, request.params.worldId, request.body.buyerOperatorId, identity.keycloakSubject);
      return reply.send(apiPayload(await deps.cooperation.reverseTransfer({
        worldId: request.params.worldId,
        listingId: request.params.listingId,
        buyerOperatorId: request.body.buyerOperatorId,
        actingAccountId: account.id,
        atS: request.body.atS,
        reasonCode: request.body.reasonCode,
        idempotencyKey: request.body.idempotencyKey,
      })));
    } catch (error) {
      return sendCooperationError(reply, error);
    }
  });

  app.post<{
    Params: { worldId: string; operatorId: string; listingId: string };
    Body: { atS: number; expectedRevision: number };
  }>("/worlds/:worldId/operators/:operatorId/vehicle-market/listings/:listingId/cancel", {
    preHandler: deps.authenticate,
    schema: {
      params: { type: "object", required: ["worldId", "operatorId", "listingId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" }, listingId: { type: "string", format: "uuid" } } },
      body: { type: "object", required: ["atS", "expectedRevision"], additionalProperties: false, properties: { atS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, expectedRevision: { type: "integer", minimum: 1 } } },
    },
  }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
    try {
      await deps.guardAction?.(request, identity.keycloakSubject, "vehicle-market", request.params.listingId, `${request.params.listingId}:cancel:${request.body.expectedRevision}`);
      const account = await requireOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
      return reply.send(apiPayload(await deps.cooperation.cancelListing({
        worldId: request.params.worldId,
        listingId: request.params.listingId,
        offeringOperatorId: request.params.operatorId,
        actingAccountId: account.id,
        atS: request.body.atS,
        expectedRevision: request.body.expectedRevision,
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

  app.post<{
    Params: { worldId: string; operatorId: string; vehicleId: string };
    Body: {
      atS: number;
      expectedRevision: number;
      odometerMetres: string;
      conditionBasisPoints: number;
      damages: readonly Readonly<Record<string, unknown>>[];
      maintenanceDeadlines: readonly Readonly<Record<string, unknown>>[];
      bindings: Readonly<Record<string, unknown>>;
      idempotencyKey: string;
    };
  }>("/worlds/:worldId/operators/:operatorId/vehicles/:vehicleId/condition", {
    preHandler: deps.authenticate,
    schema: {
      params: { type: "object", required: ["worldId", "operatorId", "vehicleId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" }, vehicleId: { type: "string", minLength: 1, maxLength: 200 } } },
      body: { type: "object", required: ["atS", "expectedRevision", "odometerMetres", "conditionBasisPoints", "damages", "maintenanceDeadlines", "bindings", "idempotencyKey"], additionalProperties: false, properties: {
        atS: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        expectedRevision: { type: "integer", minimum: 1 },
        odometerMetres: { type: "string", pattern: "^[0-9]+$" },
        conditionBasisPoints: { type: "integer", minimum: 0, maximum: 10_000 },
        damages: { type: "array", maxItems: 1_000, items: { type: "object" } },
        maintenanceDeadlines: { type: "array", maxItems: 1_000, items: { type: "object" } },
        bindings: { type: "object" },
        idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
      } },
    },
  }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
    try {
      await deps.guardAction?.(request, identity.keycloakSubject, "vehicle-condition", request.params.vehicleId, request.body.idempotencyKey);
      const account = await requireOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
      return reply.send(apiPayload(await deps.cooperation.updateVehicleCondition({
        worldId: request.params.worldId, vehicleId: request.params.vehicleId,
        actingOperatorId: request.params.operatorId, actingAccountId: account.id,
        atS: request.body.atS, expectedRevision: request.body.expectedRevision,
        odometerMetres: BigInt(request.body.odometerMetres), conditionBasisPoints: request.body.conditionBasisPoints,
        damages: request.body.damages, maintenanceDeadlines: request.body.maintenanceDeadlines,
        bindings: request.body.bindings, idempotencyKey: request.body.idempotencyKey,
      })));
    } catch (error) {
      return sendCooperationError(reply, error);
    }
  });
}
