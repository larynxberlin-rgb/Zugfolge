import { alphaWorldProfiles, tutorialSessions, worlds } from "@zugfolge/db";
import type { IdentityDatabase } from "@zugfolge/identity";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

export interface ServerWorldScope {
  readonly worldId: string;
  readonly publicOrigin: string;
}

/** Ein Server besitzt eine Spielwelt; Tutorialinstanzen bleiben an diese gebunden. */
export function serverWorldScope(worldId: string, publicGameUrl: string): ServerWorldScope {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(worldId)) {
    throw new Error("ZUGFOLGE_WORLD_ID muss die UUID der einzigen Spielwelt dieses Servers sein.");
  }
  const url = new URL(publicGameUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:"))
    || url.username !== "" || url.password !== "" || url.pathname !== "/"
    || url.search !== "" || url.hash !== "" || url.hostname.includes("*")) {
    throw new Error("PUBLIC_GAME_URL muss die feste HTTPS-Origin der Welt-Subdomain sein (lokal auch HTTP).");
  }
  return Object.freeze({ worldId: worldId.toLowerCase(), publicOrigin: url.origin });
}

export function assertServerWorldInventory(scope: ServerWorldScope, rows: readonly {
  readonly worldId: string;
  readonly lifecycleStatus: string;
  readonly profileKind: string | null;
  readonly publicWorldId: string | null;
}[]): void {
  for (const row of rows) {
    // Versiegelte Vorgeschichte bleibt erhalten; Startup/Registry laden sie nicht als laufende Welt.
    if (row.lifecycleStatus === "archived") continue;
    if (row.worldId === scope.worldId && row.profileKind !== "tutorial") continue;
    if (row.worldId !== scope.worldId && row.profileKind === "tutorial" && row.publicWorldId === scope.worldId) continue;
    throw new Error(`Welt '${row.worldId}' verletzt die Serverbindung an '${scope.worldId}'; nur deren Tutorialinstanzen sind zusaetzlich erlaubt.`);
  }
}

export async function serverWorldIds(db: IdentityDatabase, scope: ServerWorldScope): Promise<ReadonlySet<string>> {
  const tutorials = await db.select({ worldId: tutorialSessions.tutorialWorldId }).from(tutorialSessions)
    .innerJoin(alphaWorldProfiles, eq(alphaWorldProfiles.worldId, tutorialSessions.tutorialWorldId))
    .where(and(eq(tutorialSessions.publicWorldId, scope.worldId), eq(alphaWorldProfiles.profileKind, "tutorial")));
  return new Set([scope.worldId, ...tutorials.map((row) => row.worldId)]);
}

export async function assertServerWorldDatabase(db: IdentityDatabase, scope: ServerWorldScope): Promise<void> {
  // guards:allow world-id — Der Prozessstart prueft das gesamte Serverinventar auf fremde Welten.
  const rows = await db.select({ worldId: worlds.id, lifecycleStatus: worlds.lifecycleStatus, profileKind: alphaWorldProfiles.profileKind, publicWorldId: tutorialSessions.publicWorldId })
    .from(worlds).leftJoin(alphaWorldProfiles, eq(alphaWorldProfiles.worldId, worlds.id))
    .leftJoin(tutorialSessions, eq(tutorialSessions.tutorialWorldId, worlds.id));
  assertServerWorldInventory(scope, rows);
}

export function registerServerWorldScope(app: FastifyInstance, db: IdentityDatabase, scope: ServerWorldScope): void {
  const host = new URL(scope.publicOrigin).host;
  app.addHook("onRequest", async (request, reply) => {
    // Interne Liveness/Readiness muss auch ueber die Loopback-Adresse funktionieren.
    if (request.routeOptions.url === "/health" || request.routeOptions.url === "/health/ready") return;
    // Forwarded-Host wird bewusst nicht als Autoritaet verwendet. Der Proxy erhaelt den originalen Host.
    if (request.headers.host?.toLowerCase() !== host) {
      return reply.code(421).send({ code: "world_host_mismatch", error: "Diese Subdomain gehoert nicht zu diesem Weltserver." });
    }
  });
  app.addHook("preValidation", async (request, reply) => {
    const worldId = (request.params as Record<string, unknown>)["worldId"];
    if (typeof worldId !== "string" || worldId === scope.worldId) return;
    if (!(await serverWorldIds(db, scope)).has(worldId)) {
      return reply.code(404).send({ code: "world_not_found", error: "Diese Welt wird von diesem Server nicht angeboten." });
    }
  });
}
