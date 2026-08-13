import { createRequire } from "node:module";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL fehlt.");

const deploymentPaths = JSON.parse(process.env.ALPHA_WORLD_RELEASE_PATHS_JSON ?? "[]");
if (!Array.isArray(deploymentPaths) || deploymentPaths.length !== 1 || typeof deploymentPaths[0] !== "string") {
  throw new Error("Der Produktions-Bootstrap braucht genau ein signiertes Weltdeployment.");
}
const trustedKeys = JSON.parse(process.env.INFRA_RELEASE_TRUSTED_KEYS_JSON ?? "{}");

const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const postgresModule = requireFromDb("postgres");
const postgres = postgresModule.default ?? postgresModule;
const { drizzle } = requireFromDb("drizzle-orm/postgres-js");
const { eq } = requireFromDb("drizzle-orm");

const schema = await import("../../packages/db/dist/schema/index.js");
const { loadSignedAlphaWorldDeployment } = await import("../../apps/game-api/dist/alpha-world-start.js");
const { ensureSignedPlanningAuthority } = await import("../../apps/game-api/dist/odoo-admin-handlers.js");
const signed = await loadSignedAlphaWorldDeployment(deploymentPaths[0], trustedKeys);
const definition = signed.deployment.worldDefinition;
if (definition.kind !== "public" || definition.rankingStatus !== "ranked") {
  throw new Error("Der statische Produktions-Bootstrap ist ausschliesslich fuer die signierte oeffentliche Welt erlaubt.");
}

const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client, { schema });
try {
  await db.insert(schema.worlds).values({
    id: signed.deployment.worldId,
    name: definition.name,
    schedulePeriodWeeks: definition.schedulePeriodWeeks,
    epoch: new Date(definition.epoch),
    worldKind: "public",
    rankingStatus: "ranked",
    lifecycleStatus: "active",
  }).onConflictDoNothing({ target: schema.worlds.id });

  const [stored] = await db.select().from(schema.worlds)
    .where(eq(schema.worlds.id, signed.deployment.worldId)).limit(1);
  if (
    stored?.name !== definition.name
    || stored.schedulePeriodWeeks !== definition.schedulePeriodWeeks
    || stored.epoch.getTime() !== new Date(definition.epoch).getTime()
    || stored.worldKind !== "public"
    || stored.rankingStatus !== "ranked"
    || stored.lifecycleStatus !== "active"
  ) throw new Error(`DB-Welt '${signed.deployment.worldId}' widerspricht dem signierten Vertrag.`);

  await ensureSignedPlanningAuthority(db, signed);
  process.stdout.write(`${JSON.stringify({
    bootstrapped: true,
    worldId: signed.deployment.worldId,
    deploymentHash: signed.deploymentHash,
  })}\n`);
} finally {
  await client.end({ timeout: 5 });
}
