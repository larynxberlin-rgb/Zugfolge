import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireFromDatabase = createRequire(
  new URL("../../packages/db/package.json", import.meta.url),
);
const postgresModule = requireFromDatabase("postgres");
const postgres = postgresModule.default ?? postgresModule;
const { drizzle } = requireFromDatabase("drizzle-orm/postgres-js");
const { migrate } = requireFromDatabase("drizzle-orm/postgres-js/migrator");

const databaseUrl = process.env["TEST_DATABASE_URL"];
const nativeAddonPath = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"];
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("TEST_DATABASE_URL fehlt.");
}
if (nativeAddonPath === undefined || nativeAddonPath.length === 0) {
  throw new Error("ZUGFOLGE_RUNTIME_NATIVE_PATH fehlt.");
}

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const deploymentPath = process.env["ALPHA_WORLD_RELEASE_PATH"];
if (deploymentPath === undefined || deploymentPath.length === 0) {
  throw new Error("ALPHA_WORLD_RELEASE_PATH fehlt.");
}
const publicKeyPath = fileURLToPath(
  new URL("../../ops/keys/zugfolge-alpha-2026-ed25519-public.pem", import.meta.url),
);

const [databaseModule, schema, runtimeModule, livemapModule, dispatchModule, workerModule, worldStartModule] =
  await Promise.all([
    import("../../packages/db/dist/index.js"),
    import("../../packages/db/dist/schema/index.js"),
    import("../../packages/runtime-native/dist/index.js"),
    import("../../packages/livemap/dist/index.js"),
    import("../../packages/dispatch/dist/index.js"),
    import("../../apps/game-api/dist/regional-simulation-worker.js"),
    import("../../apps/game-api/dist/alpha-world-start.js"),
  ]);

const client = postgres(databaseUrl, { max: 8 });
const db = drizzle(client, { schema });

try {
  await migrate(db, { migrationsFolder: databaseModule.MIGRATIONS_FOLDER });

  const health = await databaseModule.createDatabaseHealthCheck(db).check();
  if (health.status !== "ok") {
    throw new Error(`PostgreSQL-Schema ist nicht gesund: ${JSON.stringify(health)}`);
  }

  const publicKey = await readFile(publicKeyPath, "utf8");
  const signed = await worldStartModule.loadSignedAlphaWorldDeployment(deploymentPath, {
    "zugfolge-alpha-2026": publicKey,
  });
  const worldId = signed.deployment.worldId;
  const definition = signed.deployment.worldDefinition;
  const epoch = new Date(definition.epoch);

  await db
    .insert(schema.worlds)
    .values({
      id: worldId,
      name: definition.name,
      schedulePeriodWeeks: definition.schedulePeriodWeeks,
      epoch,
      worldKind: "public",
      rankingStatus: "ranked",
      lifecycleStatus: "active",
      createdAt: epoch,
    })
    .onConflictDoNothing();

  const fleetRuntime = runtimeModule.loadOperatingRuntime(nativeAddonPath);
  const regionalRuntime = runtimeModule.loadRegionalSimulationRuntime(nativeAddonPath);
  const livemap = new livemapModule.LivemapRegistry({
    maxFeeds: 4,
    idleTtlMs: 60_000,
    historyLimit: 32,
    now: () => 0,
    createStreamId: () => "m14-real-postgres",
  });
  const operations = new dispatchModule.OperationsRegistry(8, 32);
  const worker = new workerModule.RegionalSimulationWorker(
    db,
    regionalRuntime,
    livemap,
    operations,
  );
  const port = new worldStartModule.ProductionWorldStartPort(
    db,
    signed,
    fleetRuntime,
    worker,
    livemap,
    operations,
  );

  const firstProfile = await worldStartModule.startSignedAlphaWorld(db, signed, port);
  const secondProfile = await worldStartModule.startSignedAlphaWorld(db, signed, port);
  if (firstProfile.state !== "running" || secondProfile.state !== "running") {
    throw new Error("Der produktive Weltstart erreichte den Zustand running nicht.");
  }
  if (firstProfile.blueprintHash !== secondProfile.blueprintHash) {
    throw new Error("Der idempotente Wiederanlauf lieferte einen anderen Weltentwurf.");
  }

  const verification = await port.verify(worldId, signed.deployment.blueprint);
  if (
    !verification.economyReady ||
    !verification.fleetReady ||
    !verification.regionalSimulationReady ||
    !verification.livemapReady ||
    !verification.operationsCenterReady ||
    !verification.odooProjectionQueued
  ) {
    throw new Error(`Produktionsprojektionen sind unvollstaendig: ${JSON.stringify(verification)}`);
  }

  const expectedTrainRuns = signed.deployment.blueprint.lots.flatMap(
    (lot) => lot.trainRunIds,
  ).length;
  if (verification.runningTrainRunIds.length !== expectedTrainRuns) {
    throw new Error(
      `Eigenbetrieb deckt ${verification.runningTrainRunIds.length}/${expectedTrainRuns} Zugfahrten.`,
    );
  }

  const [versions, counts, regionalHeads] = await Promise.all([
    client`
      select
        current_setting('server_version') as postgres_version,
        postgis_full_version() as postgis_version
    `,
    client`
      select
        (select count(*)::int from alpha_world_profiles where world_id = ${worldId}) as profiles,
        (select count(*)::int from economy_world_states where world_id = ${worldId}) as economy_states,
        (select count(*)::int from fleet_world_checkpoints where world_id = ${worldId}) as fleet_checkpoints,
        (select count(*)::int from regional_simulation_states where world_id = ${worldId}) as regional_states,
        (select count(*)::int from domain_events where world_id = ${worldId}) as domain_events,
        (select count(*)::int from odoo_projection_outbox where world_id = ${worldId}) as odoo_outbox
    `,
    client`
      select region_id, revision::text, publisher_sequence::text, state_hash
      from regional_simulation_states
      where world_id = ${worldId}
      order by region_id
    `,
  ]);

  if (
    counts[0].profiles !== 1 ||
    counts[0].economy_states !== 1 ||
    counts[0].fleet_checkpoints !== 1 ||
    counts[0].regional_states !== 1 ||
    counts[0].odoo_outbox !== 1
  ) {
    throw new Error(`Persistenznachweis ist unvollstaendig: ${JSON.stringify(counts[0])}`);
  }

  process.stdout.write(
    `${JSON.stringify({
      schema: "zugfolge-m14-real-postgres-world-start-evidence/v1",
      repositoryRoot,
      worldId,
      deploymentHash: signed.deploymentHash,
      blueprintHash: firstProfile.blueprintHash,
      state: firstProfile.state,
      health,
      postgres: versions[0],
      counts: counts[0],
      projections: {
        economy: verification.economyReady,
        fleet: verification.fleetReady,
        regionalSimulation: verification.regionalSimulationReady,
        livemap: verification.livemapReady,
        operationsCenter: verification.operationsCenterReady,
        odooOutbox: verification.odooProjectionQueued,
      },
      lots: verification.lotIds.length,
      runningTrainRuns: verification.runningTrainRunIds.length,
      regionalHeads,
      idempotentRestart: true,
    })}\n`,
  );
} finally {
  await client.end({ timeout: 5 });
}
