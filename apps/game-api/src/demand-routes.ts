import { AccessRevokedError, getAccount, type IdentityDatabase } from "@zugfolge/identity";
import { listOperatorsForAccount } from "@zugfolge/operators";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { DemandError } from "./demand-store.js";
import { demandHash } from "./demand-store.js";
import type { DemandService } from "./demand-service.js";
import type { SpfvService } from "./spfv-service.js";
import { parseSpfvDraft } from "./spfv-service.js";

export interface DemandReadService extends Pick<DemandService, "overview" | "train" | "manifest"> {}
export interface DemandRouteDependencies {
  readonly db: IdentityDatabase;
  readonly authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  readonly demand?: DemandReadService;
  readonly spfv?: Pick<SpfvService, "catalog" | "preview" | "confirm">;
  readonly guardPlanning?: (request: FastifyRequest, worldId: string, target: string, replayKey: string) => Promise<void>;
}

const pagination = { type: "object", additionalProperties: false, properties: {
  cursor: { type: "string", maxLength: 100 }, limit: { type: "integer", minimum: 1, maximum: 50 },
} } as const;
const parameterProperties = {
  worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" },
  trainId: { type: "string", minLength: 1, maxLength: 300 },
} as const;
function params(keys: readonly string[]) {
  return { type: "object", additionalProperties: false, required: keys,
    properties: Object.fromEntries(keys.map((key) => [key, parameterProperties[key as keyof typeof parameterProperties]])) };
}

export async function authorizeDemand(deps: Pick<DemandRouteDependencies, "db">, request: FastifyRequest, worldId: string, operatorId?: string): Promise<string> {
  if (request.identity === undefined) throw new DemandError(401, "Bitte melde dich an.");
  let account;
  try { account = await getAccount(deps.db, { worldId, keycloakSubject: request.identity.keycloakSubject }); }
  catch (error) { if (error instanceof AccessRevokedError) throw new DemandError(403, "Kein aktiver Zugang zu dieser Welt."); throw error; }
  if (account === undefined) throw new DemandError(403, "Kein aktiver Zugang zu dieser Welt.");
  if (operatorId !== undefined) {
    const owned = await listOperatorsForAccount(deps.db, request.identity.keycloakSubject, worldId);
    if (!owned.some((operator) => operator.id === operatorId && operator.worldId === worldId && operator.foundingAccountId === account.id)) throw new DemandError(403, "Dieses Unternehmen gehört nicht zu deinem Zugang.");
  }
  return account.id;
}

export function demandRouteError(error: Error, _request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof DemandError) { void reply.code(error.statusCode).send({ error: error.message }); return; }
  if ("validation" in error) { void reply.code(400).send({ error: "Bitte prüfe die Eingaben." }); return; }
  if ("statusCode" in error && Number.isInteger(error.statusCode) && Number(error.statusCode) >= 400 && Number(error.statusCode) < 500) {
    void reply.code(Number(error.statusCode)).send({ error: Number(error.statusCode) === 429
      ? "Zu viele Anfragen. Bitte versuche es später erneut." : "Die Anfrage konnte nicht verarbeitet werden." }); return;
  }
  // DB-Fehler können vollständige Journalparameter einschließlich verdeckter Merkmale tragen.
  reply.log.error({ failure: "demand_request_failed" }, "Nachfrageanfrage fehlgeschlagen");
  void reply.code(503).send({ error: "Nachfragedaten sind momentan nicht verfügbar." });
}

export function registerDemandRoutes(app: FastifyInstance, deps: DemandRouteDependencies): void {
  const service = () => { if (deps.demand === undefined) throw new DemandError(503, "Für diese Welt sind noch keine Nachfragedaten freigegeben."); return deps.demand; };
  app.get<{ Params: { worldId: string }; Querystring: { cursor?: string; limit?: number } }>(
    "/worlds/:worldId/demand/overview", { preHandler: deps.authenticate, errorHandler: demandRouteError, schema: { params: params(["worldId"]), querystring: pagination } },
    async (request) => { await authorizeDemand(deps, request, request.params.worldId); return service().overview(request.params.worldId, request.query.cursor, request.query.limit); },
  );
  app.get<{ Params: { worldId: string; trainId: string } }>(
    "/worlds/:worldId/demand/trains/:trainId", { preHandler: deps.authenticate, errorHandler: demandRouteError, schema: { params: params(["worldId", "trainId"]) } },
    async (request) => { await authorizeDemand(deps, request, request.params.worldId); return service().train(request.params.worldId, request.params.trainId); },
  );
  app.get<{ Params: { worldId: string; operatorId: string; trainId: string }; Querystring: { cursor?: string; limit?: number } }>(
    "/worlds/:worldId/operators/:operatorId/demand/trains/:trainId/manifest", { preHandler: deps.authenticate, errorHandler: demandRouteError, schema: { params: params(["worldId", "operatorId", "trainId"]), querystring: pagination } },
    async (request) => { const { worldId, operatorId, trainId } = request.params; await authorizeDemand(deps, request, worldId, operatorId); return service().manifest(worldId, operatorId, trainId, request.query.cursor, request.query.limit); },
  );
  const spfv = () => { if (deps.spfv === undefined) throw new DemandError(503, "Fernverkehrsplanung wartet auf freigegebene Nachfrage- und Flottendaten."); return deps.spfv; };
  app.get<{ Params: { worldId: string; operatorId: string } }>(
    "/worlds/:worldId/operators/:operatorId/spfv/catalog", { preHandler: deps.authenticate, errorHandler: demandRouteError, schema: { params: params(["worldId", "operatorId"]) } },
    async (request) => { const { worldId, operatorId } = request.params; const accountId = await authorizeDemand(deps, request, worldId, operatorId); return spfv().catalog({ worldId, operatorId, accountId }); },
  );
  app.post<{ Params: { worldId: string; operatorId: string }; Body: unknown }>(
    "/worlds/:worldId/operators/:operatorId/spfv/preview", { preHandler: deps.authenticate, errorHandler: demandRouteError, bodyLimit: 16_384, schema: { params: params(["worldId", "operatorId"]), body: { type: "object" } } },
    async (request) => { const { worldId, operatorId } = request.params; const accountId = await authorizeDemand(deps, request, worldId, operatorId);
      const draft = parseSpfvDraft(request.body);
      await deps.guardPlanning?.(request, worldId, operatorId, demandHash(draft));
      return spfv().preview({ worldId, operatorId, accountId }, draft); },
  );
  app.post<{ Params: { worldId: string; operatorId: string }; Body: { previewId: string; commandId: string } }>(
    "/worlds/:worldId/operators/:operatorId/spfv/confirm", { preHandler: deps.authenticate, errorHandler: demandRouteError, schema: { params: params(["worldId", "operatorId"]), body: {
      type: "object", additionalProperties: false, required: ["previewId", "commandId"], properties: { previewId: { type: "string", minLength: 1, maxLength: 200 }, commandId: { type: "string", minLength: 1, maxLength: 200 } },
    } } },
    async (request) => { const { worldId, operatorId } = request.params; const accountId = await authorizeDemand(deps, request, worldId, operatorId);
      await deps.guardPlanning?.(request, worldId, request.body.previewId, request.body.commandId);
      return spfv().confirm({ worldId, operatorId, accountId }, request.body); },
  );
}
