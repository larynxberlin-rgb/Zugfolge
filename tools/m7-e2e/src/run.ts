/** Plattformübergreifende M7-Abnahme: echter Rust-Kern bis zur API-Berichtsprojektion. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, operators, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { operatingProgramTemplates, type OperatingProgram } from "@zugfolge/dispatch";
import { buildApp } from "@zugfolge/game-api";
import { eq } from "drizzle-orm";
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
const operatorId = "22222222-2222-2222-2222-222222222222";
const simulationToken = "m7-e2e-simulation-token";
const accessToken = "m7-e2e-owner-token";
const subject = "m7-e2e-owner";
const client = new PGlite();
const db = drizzle(client, { schema });
await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
await db.insert(worlds).values({ id: worldId, name: "M7-Abnahmewelt", schedulePeriodWeeks: 4, epoch: new Date("2026-08-11T00:00:00Z") });
const app = buildApp({
  db,
  verifyToken: async (token) => {
    if (token !== accessToken) throw new Error("falsches Testtoken");
    return { keycloakSubject: subject, displayName: "M7 E2E" };
  },
  simulationIngestToken: simulationToken,
  logger: false,
});
await app.ready();

try {
  const auth = { authorization: `Bearer ${accessToken}` };
  const access = await app.inject({ method: "POST", url: `/worlds/${worldId}/access`, headers: auth, payload: { displayName: "M7 E2E" } });
  assert.equal(access.statusCode, 201);
  const founded = await app.inject({ method: "POST", url: `/worlds/${worldId}/operators`, headers: auth, payload: { name: "M7-Bahn" } });
  assert.equal(founded.statusCode, 201);
  const generatedOperatorId = founded.json<{ id: string }>().id;
  await db.update(operators).set({ id: operatorId }).where(eq(operators.id, generatedOperatorId));
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
