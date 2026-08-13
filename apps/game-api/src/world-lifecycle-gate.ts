import { worlds } from "@zugfolge/db";
import type { IdentityDatabase } from "@zugfolge/identity";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Datenschutz- und Rechtsbehelfsaktionen bleiben auch nach dem Weltende
 * erreichbar. Sie veraendern keinen Spielzustand und duerfen deshalb nicht an
 * den fachlichen Welt-Lebenszyklus gekoppelt werden.
 */
const NON_DOMAIN_MUTATION_ROUTES = new Set([
  "/worlds/:worldId/me/erase",
  "/worlds/:worldId/accounts/:accountId/erase",
  "/worlds/:worldId/abuse-sanctions/:sanctionId/appeal",
]);

function worldIdFrom(request: FastifyRequest): string | undefined {
  const params = request.params as Record<string, unknown>;
  return typeof params["worldId"] === "string" ? params["worldId"] : undefined;
}

/**
 * Zentraler Schreibschutz fuer alle HTTP-Fachmutationen mit Weltbindung.
 * Fachservices pruefen ihre eigenen Zustandsuebergaenge weiterhin selbst; der
 * Gate verhindert zusaetzlich, dass eine vergessene Einzelroute archivierte
 * Welten wieder veraendert.
 */
export function registerWorldLifecycleGate(app: FastifyInstance, db: IdentityDatabase): void {
  const assertActiveWorld = async (request: FastifyRequest, reply: FastifyReply) => {
    const worldId = worldIdFrom(request);
    if (worldId === undefined) return;

    const [world] = await db
      .select({ lifecycleStatus: worlds.lifecycleStatus })
      .from(worlds)
      .where(eq(worlds.id, worldId))
      .limit(1);
    if (world === undefined) {
      return reply.code(404).send({ code: "world_not_found", error: "Welt wurde nicht gefunden." });
    }
    if (world.lifecycleStatus !== "active") {
      return reply.code(409).send({
        code: "world_not_active",
        error: "Archivierte Welten sind schreibgeschuetzt.",
      });
    }
  };

  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!methods.some((method) => MUTATING_METHODS.has(method))) return;
    if (!route.url.includes(":worldId") || NON_DOMAIN_MUTATION_ROUTES.has(route.url)) return;
    const existing = route.preHandler;
    route.preHandler = existing === undefined
      ? assertActiveWorld
      : Array.isArray(existing)
        ? [...existing, assertActiveWorld]
        : [existing, assertActiveWorld];
  });
}
