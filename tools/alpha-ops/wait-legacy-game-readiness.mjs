#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import { waitForGameReadiness } from "./wait-game-readiness.mjs";

const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const postgresModule = requireFromDb("postgres");
const postgres = postgresModule.default ?? postgresModule;

export const LEGACY_REVISION_BASELINE_SCHEMA = "zugfolge-legacy-revision-baseline/v2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  invariant(Number.isSafeInteger(parsed) && parsed > 0, `${label} muss eine positive Ganzzahl sein.`);
  return parsed;
}

function canonicalPositiveIntegerString(value, label) {
  invariant(typeof value === "string" && /^[1-9][0-9]*$/u.test(value), `${label} ist keine positive kanonische Ganzzahl.`);
  return value;
}

function canonicalNonnegativeIntegerString(value, label) {
  invariant(typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value), `${label} ist keine nichtnegative kanonische Ganzzahl.`);
  return value;
}

function canonicalWorldId(value, label) {
  invariant(typeof value === "string" && UUID.test(value), `${label} ist keine kanonische UUID.`);
  return value;
}

function canonicalRegionIds(value, label) {
  invariant(Array.isArray(value) && value.length > 0, `${label} besitzt keine Region.`);
  let previous;
  for (const regionId of value) {
    invariant(typeof regionId === "string" && regionId.length > 0 && regionId.length <= 200, `${label} besitzt eine ungueltige Regions-ID.`);
    invariant(previous === undefined || previous.localeCompare(regionId, "en") < 0, `${label} ist nicht eindeutig kanonisch sortiert.`);
    previous = regionId;
  }
  return value;
}

export function validateLegacyRevisionBaseline(value) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), "Legacy-Revisionsbaseline fehlt.");
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["regionCount", "regionIds", "revisionTotal", "schema", "worldId"]),
    "Legacy-Revisionsbaseline besitzt unbekannte oder fehlende Felder.",
  );
  invariant(value.schema === LEGACY_REVISION_BASELINE_SCHEMA, "Legacy-Revisionsbaseline besitzt ein unbekanntes Schema.");
  canonicalPositiveIntegerString(value.regionCount, "Legacy-Revisionsbaseline.regionCount");
  canonicalRegionIds(value.regionIds, "Legacy-Revisionsbaseline.regionIds");
  invariant(value.regionCount === String(value.regionIds.length), "Legacy-Revisionsbaseline bindet Regionszahl und Regionsmenge nicht gleich.");
  canonicalNonnegativeIntegerString(value.revisionTotal, "Legacy-Revisionsbaseline.revisionTotal");
  canonicalWorldId(value.worldId, "Legacy-Revisionsbaseline.worldId");
  return value;
}

export async function inspectLegacyRevisionHead(sql, worldId) {
  const boundWorldId = canonicalWorldId(worldId, "Legacy-Revisionskopf.worldId");
  const rows = await sql.unsafe(`
    select
      region_id,
      revision::text as revision,
      publisher_sequence::text as publisher_sequence
    from regional_simulation_states
    where world_id = $1::uuid
    order by region_id
  `, [boundWorldId]);
  invariant(rows.length > 0, "Legacy-Revisionskopf besitzt keine Region fuer die attestierte Welt.");
  const regionIds = [];
  let revisionTotal = 0n;
  for (const row of rows) {
    invariant(typeof row.region_id === "string" && row.region_id.length > 0 && row.region_id.length <= 200, "Legacy-Revisionskopf besitzt eine ungueltige Regions-ID.");
    const revision = canonicalNonnegativeIntegerString(row.revision, "Legacy-Revisionskopf.revision");
    const publisherSequence = canonicalNonnegativeIntegerString(row.publisher_sequence, "Legacy-Revisionskopf.publisherSequence");
    invariant(revision === publisherSequence, "Legacy-Revisionskopf besitzt eine Publishersequenz-Luecke.");
    regionIds.push(row.region_id);
    revisionTotal += BigInt(revision);
  }
  canonicalRegionIds(regionIds, "Legacy-Revisionskopf.regionIds");
  const baseline = {
    schema: LEGACY_REVISION_BASELINE_SCHEMA,
    regionCount: String(regionIds.length),
    regionIds,
    revisionTotal: revisionTotal.toString(),
    worldId: boundWorldId,
  };
  return Object.freeze(baseline);
}

export async function waitForLegacyGameReadiness({
  baseUrl,
  baseline,
  maximumWaitMs = 7_200_000,
  pollIntervalMs = 5_000,
  readinessWait = waitForGameReadiness,
  inspectRevisionHead,
  worldId,
  now = Date.now,
  sleep = (durationMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, durationMs)),
  onProgress = () => undefined,
}) {
  const expected = validateLegacyRevisionBaseline(baseline);
  const boundWorldId = canonicalWorldId(worldId, "Legacy-Readiness.worldId");
  invariant(expected.worldId === boundWorldId, "Legacy-Revisionsbaseline gehoert nicht zur attestierten Vorgaengerwelt.");
  invariant(typeof inspectRevisionHead === "function", "Legacy-Revisionsinspektor fehlt.");
  const maximum = positiveInteger(maximumWaitMs, "Maximale Legacy-Readiness-Wartezeit");
  const poll = positiveInteger(pollIntervalMs, "Legacy-Readiness-Pollintervall");
  const startedAtMs = now();

  while (true) {
    const elapsedMs = now() - startedAtMs;
    invariant(elapsedMs <= maximum, `Legacy-Game erzeugte innerhalb von ${maximum} ms keine neue autoritative Revision.`);
    await readinessWait({
      baseUrl,
      maximumWaitMs: Math.max(1, maximum - elapsedMs),
      onProgress,
    });
    const current = validateLegacyRevisionBaseline(await inspectRevisionHead(boundWorldId));
    invariant(current.worldId === boundWorldId, "Legacy-Revisionsinspektion wechselte die attestierte Vorgaengerwelt.");
    invariant(current.regionCount === expected.regionCount && JSON.stringify(current.regionIds) === JSON.stringify(expected.regionIds), "Legacy-Game veraenderte waehrend des Startgates die exakte Menge autoritativer Regionen.");
    if (BigInt(current.revisionTotal) > BigInt(expected.revisionTotal)) return current;
    const remainingMs = maximum - (now() - startedAtMs);
    invariant(remainingMs > 0, `Legacy-Game erzeugte innerhalb von ${maximum} ms keine neue autoritative Revision.`);
    await sleep(Math.min(poll, remainingMs));
  }
}

async function withDatabase(callback) {
  const databaseUrl = process.env.PRODUCTION_RECOVERY_GAME_RESTORED_DATABASE_URL;
  invariant(typeof databaseUrl === "string" && databaseUrl.length > 0, "PRODUCTION_RECOVERY_GAME_RESTORED_DATABASE_URL fehlt.");
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, idle_timeout: 5 });
  try {
    return await callback(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  const command = process.argv[2];
  const worldId = canonicalWorldId(process.env.PRODUCTION_RECOVERY_PREVIOUS_WORLD_ID, "PRODUCTION_RECOVERY_PREVIOUS_WORLD_ID");
  if (command === "baseline") {
    const baseline = await withDatabase((sql) => inspectLegacyRevisionHead(sql, worldId));
    process.stdout.write(`${JSON.stringify(baseline)}\n`);
    return;
  }
  if (command === "wait") {
    const baseUrl = process.argv[3] ?? "http://game-api:3000";
    const baseline = validateLegacyRevisionBaseline(JSON.parse(process.argv[4] ?? "null"));
    const maximumWaitMs = process.argv[5] === undefined
      ? 7_200_000
      : positiveInteger(process.argv[5], "Maximale Legacy-Readiness-Wartezeit");
    const result = await withDatabase((sql) => waitForLegacyGameReadiness({
      baseUrl,
      baseline,
      maximumWaitMs,
      inspectRevisionHead: (boundWorldId) => inspectLegacyRevisionHead(sql, boundWorldId),
      worldId,
      onProgress: ({ elapsedMs, progressAgeSeconds }) => {
        process.stdout.write(
          `Legacy-Game-Catch-up aktiv: ${Math.floor(elapsedMs / 1_000)} s, letzter Fortschritt ${progressAgeSeconds} s alt.\n`,
        );
      },
    }));
    process.stdout.write(`Legacy-Game ist ready und hat Revision ${result.revisionTotal} erreicht.\n`);
    return;
  }
  throw new Error("Aufruf: wait-legacy-game-readiness.mjs baseline|wait [BASE_URL BASELINE_JSON MAXIMUM_WAIT_MS]");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 65;
  });
}
