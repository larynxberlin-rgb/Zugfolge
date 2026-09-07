import { AccessRevokedError } from "@zugfolge/identity";
import { ConductorSessionError, type ConductorCommandV1 } from "@zugfolge/runtime-native";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ConductorAccessError, type ConductorAccess } from "./conductor-context.js";
import type { ConductorSessionService } from "./conductor-session-service.js";

const id = { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" };
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const params = { type: "object", additionalProperties: false, required: ["worldId", "operatorId", "trainRunId"], properties: {
  worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" }, trainRunId: id } };
const point = { type: "object", additionalProperties: false, required: ["vehicleId", "bodyId", "deckId", "xMm", "yMm"], properties: {
  vehicleId: id, bodyId: id, deckId: { type: "string", enum: ["main", "lower", "upper"] }, xMm: integer, yMm: integer } };
const actionFields: Record<string, readonly string[]> = {
  start_session: [], detach_session: [], resume_session: [], end_session: [], move: ["to", "transitionEdgeId"],
  start_inspection: ["passengerKey"], choose_dialogue_option: ["optionId"], request_police: ["optionId"],
};
const actionProperties = { type: { type: "string", enum: Object.keys(actionFields) }, to: point,
  transitionEdgeId: { ...id, type: ["string", "null"] }, passengerKey: id, optionId: id };
export const conductorCommandBodySchema = { type: "object", additionalProperties: false,
  required: ["schemaVersion", "worldId", "trainRunId", "sessionId", "expectedRevision", "expectedManifestRevision", "idempotencyKey", "action"],
  properties: { schemaVersion: { const: "conductor-command/v1" }, worldId: { type: "string", format: "uuid" }, trainRunId: id,
    sessionId: id, expectedRevision: integer, expectedManifestRevision: { ...integer, type: ["integer", "null"] }, idempotencyKey: id,
    action: { type: "object", additionalProperties: false, properties: actionProperties,
      oneOf: Object.entries(actionFields).map(([type, fields]) => ({ required: ["type", ...fields], properties: { type: { const: type } },
        not: { anyOf: Object.keys(actionProperties).filter((key) => key !== "type" && !fields.includes(key)).map((key) => ({ required: [key] })) } })) } } };
// Fastify's removeAdditional must not silently discard attempted private facts.
function exactCommandInput(value: unknown): void {
  const exact = (row: unknown, keys: readonly string[]) => row !== null && typeof row === "object" && !Array.isArray(row)
    && Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
  if (!exact(value, conductorCommandBodySchema.required)) throw new ConductorAccessError(400, "conductor_request_invalid", "Die Sitzungsanfrage enthält ungültige Felder.");
  const body = value as Record<string, unknown>, action = body["action"] as Record<string, unknown> | null;
  const type = action?.["type"];
  if (typeof type !== "string" || !Object.hasOwn(actionFields, type) || !exact(action, ["type", ...actionFields[type]!])
    || type === "move" && !exact(action?.["to"], ["vehicleId", "bodyId", "deckId", "xMm", "yMm"]))
    throw new ConductorAccessError(400, "conductor_request_invalid", "Die Handlung enthält ungültige Felder.");
}
type Params = { worldId: string; operatorId: string; trainRunId: string };

function failure(error: unknown): { status: number; code: string; error: string } {
  if (error instanceof ConductorAccessError) return { status: error.statusCode, code: error.code, error: error.message };
  if (error instanceof AccessRevokedError) return { status: 403, code: "conductor_access_denied", error: "Dein Zugang zu dieser Fahrt ist nicht mehr aktiv." };
  if (error instanceof ConductorSessionError) return { status: error.code === "session_transport_invalid" ? 503 : 409,
    code: error.code, error: "Die Handlung passt nicht mehr zum bestätigten Sitzungsstand. Lade den aktuellen Stand." };
  return { status: 503, code: "conductor_unavailable", error: "Der Schaffnermodus ist momentan nicht verfügbar." };
}
export function registerConductorSessionRoutes(app: FastifyInstance, deps: {
  readonly conductorSessions?: ConductorSessionService;
  readonly authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}): void {
  const base = "/worlds/:worldId/operators/:operatorId/trains/:trainRunId/conductor-sessions";
  const streams = new Map<string, number>();
  const routeOptions = { preHandler: deps.authenticate, errorHandler(error: Error & { validation?: unknown }, request: FastifyRequest, reply: FastifyReply) {
    const result = error.validation === undefined ? failure(error) : { status: 400, code: "conductor_request_invalid", error: "Die Sitzungsanfrage ist ungültig." };
    request.log.info({ event: "conductor_request_result", outcome: "rejected", code: result.code });
    void reply.header("cache-control", "private, no-store").code(result.status).send({ code: result.code, error: result.error });
  } };
  const access = (request: FastifyRequest<{ Params: Params }>): ConductorAccess => {
    if (request.identity === undefined) throw new ConductorAccessError(401, "conductor_unauthenticated", "Kein Zugriffstoken übermittelt.");
    return { ...request.params, keycloakSubject: request.identity.keycloakSubject };
  };
  const service = () => {
    if (deps.conductorSessions === undefined) throw new ConductorAccessError(503, "conductor_disabled", "Der Schaffnermodus ist für diese Welt noch nicht freigegeben.");
    return deps.conductorSessions;
  };
  app.get<{ Params: Params }>(base, { ...routeOptions, schema: { params } }, async (request, reply) => {
    reply.header("cache-control", "private, no-store"); return service().availability(access(request));
  });
  app.get<{ Params: Params }>(`${base}/snapshot`, { ...routeOptions, schema: { params } }, async (request, reply) => {
    reply.header("cache-control", "private, no-store"); return service().snapshot(access(request));
  });
  app.get<{ Params: Params }>(`${base}/report`, { ...routeOptions, schema: { params } }, async (request, reply) => {
    reply.header("cache-control", "private, no-store"); return service().report(access(request));
  });
  app.get<{ Params: Params }>(`${base}/art`, { ...routeOptions, schema: { params } }, async (request, reply) => {
    reply.header("cache-control", "private, no-store"); return service().art(access(request));
  });
  app.get<{ Params: Params; Querystring: { targetNodeId: string } }>(`${base}/path`, { ...routeOptions,
    schema: { params, querystring: { type: "object", additionalProperties: false, required: ["targetNodeId"], properties: { targetNodeId: id } } } }, async (request, reply) => {
    reply.header("cache-control", "private, no-store"); return service().path(access(request), request.query.targetNodeId);
  });
  app.get<{ Params: Params & { fileId: string } }>(`${base}/atlas/:fileId`, { ...routeOptions,
    schema: { params: { ...params, required: [...params.required, "fileId"], properties: { ...params.properties, fileId: id } } } }, async (request, reply) => {
    const bytes = await service().atlasFile(access(request), request.params.fileId);
    return reply.header("cache-control", "private, no-store").header("x-content-type-options", "nosniff").type("image/png").send(Buffer.from(bytes));
  });
  app.post<{ Params: Params; Body: ConductorCommandV1 }>(base, { ...routeOptions, bodyLimit: 16_384,
    preValidation: async (request) => { exactCommandInput(request.body); },
    schema: { params, body: conductorCommandBodySchema } }, async (request, reply) => {
    const result = await service().command(access(request), request.body);
    request.log.info({ event: "conductor_request_result", worldId: request.params.worldId, action: request.body.action.type,
      outcome: "committed", revision: result.snapshot.revision });
    reply.header("cache-control", "private, no-store"); return result;
  });
  app.get<{ Params: Params; Querystring: { afterSequence?: number } }>(`${base}/events`, { ...routeOptions,
    schema: { params, querystring: { type: "object", additionalProperties: false, properties: { afterSequence: integer } } } }, async (request, reply) => {
    const caller = access(request), sessions = service();
    const header = request.headers["last-event-id"];
    if (header !== undefined && (typeof header !== "string" || !/^(0|[1-9]\d{0,15})$/u.test(header) || !Number.isSafeInteger(Number(header))))
      throw new ConductorAccessError(400, "conductor_sequence_invalid", "Die Ereigniskennung ist ungültig.");
    let sequence = header === undefined ? request.query.afterSequence ?? 0 : Number(header);
    const first = await sessions.changes(caller, sequence);
    const streamKey = `${caller.worldId}\u0000${caller.keycloakSubject}`;
    if ((streams.get(streamKey) ?? 0) >= 2) throw new ConductorAccessError(429, "conductor_stream_limit", "Für diese Sitzung sind bereits zwei Verbindungen geöffnet.");
    streams.set(streamKey, (streams.get(streamKey) ?? 0) + 1);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "private, no-store",
      "connection": "keep-alive", "x-accel-buffering": "no" });
    let closed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (closed) return;
      closed = true; if (timer !== undefined) clearTimeout(timer);
      const count = (streams.get(streamKey) ?? 1) - 1; if (count === 0) streams.delete(streamKey); else streams.set(streamKey, count);
    };
    request.raw.on("aborted", finish); reply.raw.on("close", finish);
    const emit = (value: Awaited<ReturnType<ConductorSessionService["changes"]>>) => {
      if (closed) return;
      if (reply.raw.writableLength > 2 * 1024 * 1024) { finish(); reply.raw.destroy(); return; }
      if (value.reset || sequence === 0) {
        sequence = value.response.snapshot.sequence;
        reply.raw.write(`id: ${sequence}\nevent: snapshot\ndata: ${JSON.stringify(value.response)}\n\n`);
      } else for (const snapshot of value.snapshots) {
        sequence = snapshot.sequence;
        reply.raw.write(`id: ${sequence}\nevent: state\ndata: ${JSON.stringify(snapshot)}\n\n`);
      }
      if (value.response.scene !== null) reply.raw.write(`event: scene\ndata: ${JSON.stringify({ schemaVersion: "conductor-scene-update/v1",
        worldId: caller.worldId, trainRunId: caller.trainRunId, sessionId: value.response.snapshot.sessionId,
        sequence: value.response.snapshot.sequence, scene: value.response.scene })}\n\n`);
      if (value.response.control !== null) reply.raw.write(`event: control\ndata: ${JSON.stringify({ schemaVersion: "conductor-control-update/v1",
        worldId: caller.worldId, trainRunId: caller.trainRunId, sessionId: value.response.snapshot.sessionId,
        sequence: value.response.snapshot.sequence, control: value.response.control })}\n\n`);
      if (value.response.snapshot.status === "ended") { finish(); reply.raw.end(); }
    };
    emit(first);
    const next = async () => {
      if (closed) return;
      try { emit(await sessions.changes(caller, sequence)); }
      catch (error) {
        const problem = failure(error);
        reply.raw.write(`event: unavailable\ndata: ${JSON.stringify({ code: problem.code, error: problem.error })}\n\n`);
        finish(); reply.raw.end(); return;
      }
      if (!closed) timer = setTimeout(() => { void next(); }, 1000);
    };
    if (!closed) timer = setTimeout(() => { void next(); }, 1000);
  });
}
