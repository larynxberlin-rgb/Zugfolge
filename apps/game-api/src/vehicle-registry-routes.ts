import { vehicleRegistryEntries, vehicleRegistryEvents, worldAccesses } from "@zugfolge/db";
import { backfillFleetVehicleRegistry } from "@zugfolge/economy";
import type { IdentityDatabase } from "@zugfolge/identity";
import { and, asc, eq, gt, ilike, or } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { createAuthenticator } from "./auth.js";

const worldParams = {
  type: "object", required: ["worldId"], additionalProperties: false,
  properties: { worldId: { type: "string", format: "uuid" } },
} as const;
const vehicleParams = {
  ...worldParams, required: ["worldId", "vehicleId"],
  properties: { ...worldParams.properties, vehicleId: { type: "string", minLength: 1, maxLength: 200 } },
} as const;
const pageQuery = {
  type: "object", additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    cursor: { type: "string", minLength: 1, maxLength: 200 },
    query: { type: "string", maxLength: 100 },
  },
} as const;
type PageQuery = { limit?: number; cursor?: string; query?: string };

/** Öffentliche Spielweltdaten: Ein Weltzugang genügt, ein eigenes EVU ist nicht erforderlich. */
export function registerVehicleRegistryRoutes(app: FastifyInstance, deps: {
  readonly db: IdentityDatabase;
  readonly authenticate: ReturnType<typeof createAuthenticator>;
}): void {
  async function allowed(worldId: string, subject: string | undefined, reply: FastifyReply): Promise<boolean> {
    if (subject === undefined) { reply.code(401).send({ error: "Keine Identität." }); return false; }
    const [access] = await deps.db.select({ status: worldAccesses.status }).from(worldAccesses)
      .where(and(eq(worldAccesses.worldId, worldId), eq(worldAccesses.keycloakSubject, subject))).limit(1);
    if (access?.status !== "active") { reply.code(403).send({ error: "Kein aktiver Weltzugang." }); return false; }
    await backfillFleetVehicleRegistry(deps.db, worldId);
    return true;
  }
  app.get<{ Params: { worldId: string }; Querystring: PageQuery }>("/worlds/:worldId/vehicle-register", {
    preHandler: deps.authenticate, schema: { params: worldParams, querystring: pageQuery },
  }, async (request, reply) => {
    const { worldId } = request.params;
    if (!await allowed(worldId, request.identity?.keycloakSubject, reply)) return;
    const { limit = 50, cursor, query = "" } = request.query;
    // LIKE-Metazeichen sind Suchtext, keine Möglichkeit, den Suchfilter aufzuweiten.
    const pattern = `%${query.trim().replace(/[\\%_]/g, "\\$&")}%`;
    const rows = await deps.db.select().from(vehicleRegistryEntries).where(and(
      eq(vehicleRegistryEntries.worldId, worldId),
      cursor === undefined ? undefined : gt(vehicleRegistryEntries.vehicleId, cursor),
      query.trim() === "" ? undefined : or(ilike(vehicleRegistryEntries.vehicleId, pattern), ilike(vehicleRegistryEntries.classDesignation, pattern)),
    )).orderBy(asc(vehicleRegistryEntries.vehicleId)).limit(limit + 1);
    return reply.send({ schemaVersion: "zugfolge-vehicle-register-page/v1", worldId,
      items: rows.slice(0, limit).map((entry) => ({ schemaVersion: "zugfolge-vehicle-register/v1", ...entry })),
      nextCursor: rows.length > limit ? rows[limit - 1]!.vehicleId : null });
  });
  app.get<{ Params: { worldId: string; vehicleId: string } }>("/worlds/:worldId/vehicle-register/:vehicleId", {
    preHandler: deps.authenticate, schema: { params: vehicleParams },
  }, async (request, reply) => {
    const { worldId, vehicleId } = request.params;
    if (!await allowed(worldId, request.identity?.keycloakSubject, reply)) return;
    const [entry] = await deps.db.select().from(vehicleRegistryEntries)
      .where(and(eq(vehicleRegistryEntries.worldId, worldId), eq(vehicleRegistryEntries.vehicleId, vehicleId))).limit(1);
    if (entry === undefined) return reply.code(404).send({ error: "Fahrzeug ist in dieser Welt nicht erfasst." });
    return reply.send({ schemaVersion: "zugfolge-vehicle-register/v1", ...entry });
  });
  app.get<{ Params: { worldId: string; vehicleId: string }; Querystring: PageQuery }>("/worlds/:worldId/vehicle-register/:vehicleId/history", {
    preHandler: deps.authenticate, schema: { params: vehicleParams, querystring: {
      ...pageQuery, properties: { limit: pageQuery.properties.limit, cursor: { type: "string", pattern: "^(0|[1-9][0-9]*)$", maxLength: 10 } },
    } },
  }, async (request, reply) => {
    const { worldId, vehicleId } = request.params;
    if (!await allowed(worldId, request.identity?.keycloakSubject, reply)) return;
    const { limit = 50, cursor } = request.query;
    if (cursor !== undefined && Number(cursor) > 2_147_483_647) return reply.code(400).send({ error: "Ungültige Historienrevision." });
    const [entry] = await deps.db.select({ vehicleId: vehicleRegistryEntries.vehicleId }).from(vehicleRegistryEntries)
      .where(and(eq(vehicleRegistryEntries.worldId, worldId), eq(vehicleRegistryEntries.vehicleId, vehicleId))).limit(1);
    if (entry === undefined) return reply.code(404).send({ error: "Fahrzeug ist in dieser Welt nicht erfasst." });
    const rows = await deps.db.select().from(vehicleRegistryEvents).where(and(
      eq(vehicleRegistryEvents.worldId, worldId), eq(vehicleRegistryEvents.vehicleId, vehicleId),
      cursor === undefined ? undefined : gt(vehicleRegistryEvents.fleetRevision, Number(cursor)),
    )).orderBy(asc(vehicleRegistryEvents.fleetRevision)).limit(limit + 1);
    return reply.send({ schemaVersion: "zugfolge-vehicle-register-history-page/v1", worldId, vehicleId,
      items: rows.slice(0, limit), nextCursor: rows.length > limit ? String(rows[limit - 1]!.fleetRevision) : null });
  });
}
