/** Plattformübergreifende M7-Abnahme: echter Rust-Kern bis zur API-Berichtsprojektion. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { PGlite } from "@electric-sql/pglite";
import { validateWorldBlueprint, type AlphaWorldBlueprint } from "@zugfolge/alpha";
import { alphaWorldProfiles, MIGRATIONS_FOLDER, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { operatingProgramTemplates, type OperatingProgram } from "@zugfolge/dispatch";
import { encodeEconomyValue } from "@zugfolge/economy";
import { buildApp } from "@zugfolge/game-api";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

interface RustAcceptance {
  readonly schema: "zugfolge-m7-acceptance/v1";
  readonly simulatedThroughSeconds: number;
  readonly stateHash: string;
  readonly decisionHash: string;
  readonly events: readonly {
    readonly payload?: { readonly explanation?: { readonly program_checksum?: string } };
  }[];
}

const worldId = "11111111-1111-1111-1111-111111111111";
const simulationToken = "m7-e2e-simulation-token";
const accessToken = "m7-e2e-owner-token";
const subject = "m7-e2e-owner";
const worldContract: AlphaWorldBlueprint = {
  schemaVersion: "zugfolge-alpha-world-blueprint/v1",
  regionId: "mitteldeutschland-b",
  regionVariant: "B",
  seed: 7n,
  profileKind: "public",
  accelerationFactor: 1,
  periodCount: null,
  startingCapitalPolicy: { kind: "finite", amountCents: "0" },
  releases: {
    infra: "a".repeat(64),
    timetable: "b".repeat(64),
    fleet: "c".repeat(64),
    economy: "d".repeat(64),
  },
  lots: [{
    lotId: "m7-reference-lot",
    contractEndsAtPeriod: 2,
    trainRunIds: ["m7-reference-train"],
    pathReceiptIds: ["m7-reference-path"],
    vehicleIds: ["m7-reference-vehicle"],
    personnelDutyIds: ["m7-reference-duty"],
    circulationIds: ["m7-reference-circulation"],
    operatingProgramIds: ["m7-reference-program"],
  }],
  conflictCheckHash: "e".repeat(64),
  tenderCalendarHash: "f".repeat(64),
};
const worldContractHash = validateWorldBlueprint(worldContract);
const client = new PGlite();
const db = drizzle(client, { schema });
await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
await db.insert(worlds).values({ id: worldId, name: "M7-Abnahmewelt", schedulePeriodWeeks: 4, epoch: new Date("2026-08-11T00:00:00Z") });
await db.insert(alphaWorldProfiles).values({
  worldId,
  profileKind: worldContract.profileKind,
  regionId: worldContract.regionId,
  regionVariant: worldContract.regionVariant,
  worldSeed: worldContract.seed,
  accelerationFactor: worldContract.accelerationFactor,
  infraReleaseHash: worldContract.releases.infra,
  timetableReleaseHash: worldContract.releases.timetable,
  fleetReleaseHash: worldContract.releases.fleet,
  economyReleaseHash: worldContract.releases.economy,
  blueprint: encodeEconomyValue(worldContract),
  blueprintHash: worldContractHash,
  periodCount: worldContract.periodCount,
  state: "running",
  startedAtS: 0,
});
const app = buildApp({
  db,
  verifyToken: async (token) => {
    if (token !== accessToken) throw new Error("falsches Testtoken");
    return { keycloakSubject: subject, displayName: "M7 E2E" };
  },
  simulationIngestToken: simulationToken,
  // Dieser Harnisch verbraucht die Aktivierung unten mit dem echten M7-Rust-Erzeuger.
  dispatchConsumerReady: (requestedWorldId) => requestedWorldId === worldId,
  logger: false,
});
await app.ready();

try {
  const auth = { authorization: `Bearer ${accessToken}` };
  const access = await app.inject({
    method: "POST",
    url: `/worlds/${worldId}/access`,
    headers: auth,
    payload: { displayName: "M7 E2E", acceptedWorldContractHash: worldContractHash },
  });
  assert.equal(access.statusCode, 201);
  const founded = await app.inject({ method: "POST", url: `/worlds/${worldId}/operators`, headers: auth, payload: { name: "M7-Bahn" } });
  assert.equal(founded.statusCode, 201);
  const operatorId = founded.json<{ id: string }>().id;
  const base = `/worlds/${worldId}/operators/${operatorId}`;

  const program = operatingProgramTemplates(worldId, operatorId, 1)[0]!;
  const saved = await app.inject({ method: "POST", url: `${base}/operating-programs`, headers: auth, payload: { program } });
  assert.equal(saved.statusCode, 201);
  const persisted = saved.json<{ checksum: string; canonicalProgram: OperatingProgram }>();
  const persistedChecksum = persisted.checksum;
  const activated = await app.inject({ method: "POST", url: `${base}/operating-programs/1/activate`, headers: auth });
  assert.equal(activated.statusCode, 202);
  const activationCommand = activated.json<{ command: { readonly commandType: string; readonly payload: { readonly checksum: string; readonly program: OperatingProgram } } }>().command;
  assert.equal(activationCommand.commandType, "dispatch.activate-program");
  assert.equal(activationCommand.payload.checksum, persistedChecksum);

  const acceptanceArguments = ["run", "--quiet", "--locked", "-p", "zugfolge-m7-acceptance", "--", worldId, operatorId, JSON.stringify(activationCommand.payload.program)];
  const runAcceptance = () => spawnSync("cargo", acceptanceArguments, {
    cwd: new URL("../../..", import.meta.url),
    encoding: "utf8",
    windowsHide: true,
  });
  const rust = runAcceptance();
  assert.equal(rust.status, 0, rust.stderr);
  const repeatedRust = runAcceptance();
  assert.equal(repeatedRust.status, 0, repeatedRust.stderr);
  assert.equal(repeatedRust.stdout, rust.stdout, "Gleiche Programmversion und Kommandos müssen bitgleiche Kernereignisse liefern");
  const acceptance = JSON.parse(rust.stdout) as RustAcceptance;
  assert.equal(acceptance.schema, "zugfolge-m7-acceptance/v1");
  assert.equal(acceptance.simulatedThroughSeconds, 172_800);
  assert.match(acceptance.stateHash, /^[a-f0-9]{64}$/);
  assert.match(acceptance.decisionHash, /^[a-f0-9]{64}$/);
  assert.ok(acceptance.events.length >= 2);
  const coreChecksum = acceptance.events.find((event) => event.payload?.explanation?.program_checksum !== undefined)?.payload?.explanation?.program_checksum;
  assert.equal(coreChecksum, persistedChecksum, "Rust-Kern und TypeScript-Persistenz müssen dieselbe kanonische Programmversion sehen");

  const ingested = await app.inject({ method: "POST", url: `/internal/worlds/${worldId}/simulation/events`, headers: { authorization: `Bearer ${simulationToken}` }, payload: { events: acceptance.events } });
  assert.equal(ingested.statusCode, 202, ingested.body);
  const operations = await app.inject({ method: "GET", url: `${base}/operations`, headers: auth });
  assert.equal(operations.statusCode, 200);
  assert.equal(operations.json<{ majorEvents: unknown[] }>().majorEvents.length, 1);
  const report = await app.inject({ method: "POST", url: `${base}/operations/reports/2026-08-11/generate`, headers: auth });
  assert.equal(report.statusCode, 201, report.body);
  const projection = report.json<{ projection: { trainRuns: { total: number; punctual: number }; infrastructureEffects: string[] } }>().projection;
  assert.ok(projection.trainRuns.total >= 1);
  assert.ok(projection.trainRuns.punctual >= 1);
  assert.deepEqual(projection.infrastructureEffects, ["Abzweig Gröbers"]);
  process.stdout.write(`${JSON.stringify({ status: "ok", simulatedHours: 48, eventCount: acceptance.events.length, stateHash: acceptance.stateHash, decisionHash: acceptance.decisionHash })}\n`);
} finally {
  await app.close();
  await client.close();
}
