/** Ausschließlich reproduzierbare Test-/Browserbelege; keine produktiven Fahrzeug- oder Signeridentitäten. */
import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, operators, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { applyFleetProducerCommand, initializeFleetProducer, loadFleetProducerCheckpoint, type FleetProducerCheckpoint } from "@zugfolge/economy";
import { requestWorldAccess, type IdentityDatabase } from "@zugfolge/identity";
import { conductorInteriorRuntimeFromAddon, loadConductorInteriorRuntime, loadOperatingRuntime, operatingRuntimeFromAddon,
  FLEET_FORMATION_COMMAND_SCHEMA, FLEET_INITIALIZE_SCHEMA, type FleetAuthorityReleaseV2, type FleetRuntime, type InteriorGeometryPolicyV1,
  type NativeFleetFormationIntent } from "@zugfolge/runtime-native";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConductorInteriorService } from "./conductor-interior.js";
import { loadConductorInteriorDeployment } from "./conductor-interior-configuration.js";

export const INTERIOR_FIXTURE_WORLD = "00000000-0000-4000-8000-000000000387";
export const INTERIOR_FIXTURE_OPERATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const INTERIOR_FIXTURE_OTHER_OPERATOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const INTERIOR_FIXTURE_SUBJECT = "interior-fixture-owner";
export const INTERIOR_FIXTURE_PERIOD = "interior-fixture-period";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const executable = process.platform === "win32" ? ".exe" : "";
export const interiorFixtureCompiler = process.env["ZUGFOLGE_VEHICLE_CATALOG_TEST_BINARY"] ?? resolve(ROOT, `target/debug/zugfolge-vehicle-catalog${executable}`);
export const interiorFixtureBinary = process.env["ZUGFOLGE_INTERIOR_TEST_BINARY"] ?? resolve(ROOT, `target/debug/examples/interior_json${executable}`);
export const hasInteriorNativeFixture = existsSync(interiorFixtureCompiler) && existsSync(interiorFixtureBinary)
  && (process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] !== undefined || process.env["ZUGFOLGE_FLEET_TEST_BINARY"] !== undefined);

export function callInteriorFixtureRust(binary: string, args: string[], input: unknown): string {
  const result = spawnSync(binary, args, { input: JSON.stringify(input), encoding: "utf8", maxBuffer: 128 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Der echte Rust-Prüfprozess ist fehlgeschlagen.");
  return result.stdout;
}
function unsupported(): never { throw new Error("Dieser Beleg ruft keine Betriebsengine-Kommandos auf."); }
export function interiorFixtureRuntimes() {
  const fleetBinary = process.env["ZUGFOLGE_FLEET_TEST_BINARY"];
  const fleet: FleetRuntime = fleetBinary === undefined ? loadOperatingRuntime() : operatingRuntimeFromAddon({
    initializeFleetWorld: (input) => callInteriorFixtureRust(fleetBinary, [], { operation: "initialize", input: JSON.parse(input) }),
    verifyFleetWorldState: (state, expectedStateHash) => callInteriorFixtureRust(fleetBinary, [], { operation: "verify", state: JSON.parse(state), expectedStateHash }),
    applyFleetCommand: (state, command, replayReceipt) => callInteriorFixtureRust(fleetBinary, [], { operation: "apply", state: JSON.parse(state), command: JSON.parse(command),
      ...(replayReceipt === undefined ? {} : { replayReceipt: JSON.parse(replayReceipt) }) }),
    initializeOperatingWorld: unsupported, applyOperatingTransition: unsupported, verifyFleetMobilizationSnapshot: unsupported,
  });
  const interior = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] !== undefined ? loadConductorInteriorRuntime() : conductorInteriorRuntimeFromAddon({
    buildConductorInterior: (input) => callInteriorFixtureRust(interiorFixtureBinary, ["build"], JSON.parse(input)),
    bindConductorInterior: (input) => callInteriorFixtureRust(interiorFixtureBinary, ["bind"], JSON.parse(input)),
    projectConductorPassengersV2: (input) => callInteriorFixtureRust(interiorFixtureBinary, ["project-v2"], JSON.parse(input)),
    findConductorInteriorPath: (input) => callInteriorFixtureRust(interiorFixtureBinary, ["path"], JSON.parse(input)),
    checkConductorInteriorMovement: (input) => callInteriorFixtureRust(interiorFixtureBinary, ["movement"], JSON.parse(input)),
  });
  return { fleet, interior };
}

/** UUID-/Testvarianten werden am Seed vor dem Compiler geändert, niemals am Authority-Ergebnis. */
export function compileInteriorFixture(directory: string, missingConfigurationVehicleId?: string) {
  const fixtureDirectory = resolve(ROOT, "crates/zugfolge-fleet/tests/fixtures");
  const seed = JSON.parse(readFileSync(join(fixtureDirectory, "vehicle-world-seed-v3-interior.json"), "utf8"));
  for (const rows of [seed.assets, seed.personnelPools, seed.pathReceipts]) for (const row of rows) row.operatorId = INTERIOR_FIXTURE_OPERATOR;
  for (const asset of seed.assets) if (asset.id === missingConfigurationVehicleId) delete asset.vehicleConfiguration;
  seed.pathReceipts.push({ ...structuredClone(seed.pathReceipts[0]), id: "fixture-path-other", numericRouteId: 3002, operatorId: INTERIOR_FIXTURE_OTHER_OPERATOR });
  const seedPath = join(directory, "world-seed.json"), output = join(directory, "compiled");
  writeFileSync(seedPath, JSON.stringify(seed));
  const compiled = spawnSync(interiorFixtureCompiler, [join(fixtureDirectory, "vehicle-catalog-source-v2-interior.json"), seedPath, output], { encoding: "utf8", windowsHide: true });
  if (compiled.status !== 0) throw new Error(compiled.stderr);
  const authority = JSON.parse(readFileSync(join(output, "fleet-authority-release-v2.json"), "utf8")) as FleetAuthorityReleaseV2;
  return { authority, formations: seed.formations as NativeFleetFormationIntent[], producedAt: Number(seed.producedAt), output };
}

/** Generisches, explizites Spielprofil: Kasten-/Deckmaße sind keine Baureihenbehauptung. */
export function interiorFixtureGeometry(authority: FleetAuthorityReleaseV2): InteriorGeometryPolicyV1 {
  return { schemaVersion: "conductor-interior-geometry-policy/v1", policyId: "explicit-fixture-geometry-v1",
    vehicleTypes: authority.assets.map((asset, variant) => ({ vehicleTypeId: asset.vehicleTypeId,
      configurationHash: asset.vehicleConfiguration === undefined ? null : callInteriorFixtureRust(interiorFixtureBinary, ["configuration-hash"], asset.vehicleConfiguration).trim(),
      artFamily: variant === 1 ? "regional-double" : "regional-single",
      bodies: [24_000, 24_000, 22_000].map((lengthMm, body) => ({ bodyId: `body-${body + 1}`, lengthMm, widthMm: 3000,
        deckIds: variant === 1 ? ["lower", "upper"] : ["main"], entranceDeckId: variant === 1 ? "lower" : "main",
        doorPositionsMm: variant === 0 ? (body === 0 ? [7000, 17000] : [12000]) : variant === 1 ? [7000, 17000] : body === 2 ? [7000, 17000] : [5000, 12000, 19000],
        stairs: variant === 1 ? [{ stairId: "stairs-1", fromDeckId: "lower", toDeckId: "upper", atMm: 3500 }] : [],
        gapAfterMm: 0, frontGangway: body > 0, rearGangway: body < 2,
      })) })) };
}

/** Echte freigegebene Grafikbytes; die neu erzeugte Signeridentität gilt ausschließlich für diesen Test. */
export async function interiorFixtureDeployment(directory: string, geometryPolicy: InteriorGeometryPolicyV1) {
  const artDirectory = resolve(ROOT, "assets/conductor-art/v1");
  const bytes = readFileSync(join(artDirectory, "manifest.json")), manifest = JSON.parse(bytes.toString("utf8"));
  const digest = createHash("sha256").update(bytes).digest("hex"), keyId = "temporary-integration-test-only";
  const keys = generateKeyPairSync("ed25519");
  const deployment = { schemaVersion: "conductor-interior-deployment/v1", worldId: INTERIOR_FIXTURE_WORLD, periods: [{
    periodId: INTERIOR_FIXTURE_PERIOD, validFromMs: 100_000, validUntilMs: 400_000, geometryPolicy,
    geometryPolicyHash: callInteriorFixtureRust(interiorFixtureBinary, ["policy-hash"], geometryPolicy).trim(),
    artPin: { schemaVersion: "art-atlas-world-pin/v1", worldId: INTERIOR_FIXTURE_WORLD, releaseId: manifest.releaseId, manifestSha256: digest },
    artSignature: { algorithm: "ed25519", keyId, signedHash: digest, valueBase64: sign(null, Buffer.from(digest, "utf8"), keys.privateKey).toString("base64") }, artDirectory,
  }] };
  const path = join(directory, "interior-deployment.json"), trustedKeysPath = join(directory, "test-public-keys.json");
  writeFileSync(path, JSON.stringify(deployment));
  writeFileSync(trustedKeysPath, JSON.stringify({ [keyId]: keys.publicKey.export({ type: "spki", format: "pem" }) }));
  const expectedSha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  const input = { path, expectedSha256, trustedKeysPath, worldId: INTERIOR_FIXTURE_WORLD };
  return { deployment: await loadConductorInteriorDeployment(input), input, document: deployment };
}

export async function initializeInteriorFixtureDatabase(db: IdentityDatabase) {
  await db.insert(worlds).values({ id: INTERIOR_FIXTURE_WORLD, name: "Fiktive konfigurierte Innenraumtestwelt", schedulePeriodWeeks: 3, epoch: new Date(0) });
  const account = await requestWorldAccess(db, { worldId: INTERIOR_FIXTURE_WORLD, keycloakSubject: INTERIOR_FIXTURE_SUBJECT, displayName: "Prüfeigentümer" });
  const other = await requestWorldAccess(db, { worldId: INTERIOR_FIXTURE_WORLD, keycloakSubject: "interior-fixture-other", displayName: "Anderer Prüfeigentümer" });
  await db.insert(operators).values([
    { id: INTERIOR_FIXTURE_OPERATOR, worldId: INTERIOR_FIXTURE_WORLD, foundingAccountId: account.id, name: "Fiktiver Prüfverkehr" },
    { id: INTERIOR_FIXTURE_OTHER_OPERATOR, worldId: INTERIOR_FIXTURE_WORLD, foundingAccountId: other.id, name: "Anderer fiktiver Prüfverkehr" },
  ]);
}

export async function createInteriorNativeFixture(options: { missingConfigurationVehicleId?: string; form?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "zugfolge-interior-evidence-"));
  const compiled = compileInteriorFixture(directory, options.missingConfigurationVehicleId), runtimes = interiorFixtureRuntimes();
  const signed = await interiorFixtureDeployment(directory, interiorFixtureGeometry(compiled.authority));
  const client = new PGlite(), db = drizzle(client, { schema });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await initializeInteriorFixtureDatabase(db);
    await initializeFleetProducer({ db, runtime: runtimes.fleet, ingestedAt: new Date(100_000), initialization: {
      schemaVersion: FLEET_INITIALIZE_SCHEMA, worldId: INTERIOR_FIXTURE_WORLD, producedAt: compiled.producedAt, authorityRelease: compiled.authority } });
    if (options.form !== false) for (const [index, formation] of compiled.formations.entries()) {
      const previous = (await loadFleetProducerCheckpoint(db, INTERIOR_FIXTURE_WORLD))!;
      await applyFleetProducerCommand({ db, runtime: runtimes.fleet, ingestedAt: new Date(101_000 + index * 1000), command: {
        schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA, worldId: INTERIOR_FIXTURE_WORLD, commandId: `interior-fixture-form-${index}`,
        expectedStateHash: previous.stateHash, expectedRevision: previous.state.revision, atS: 101 + index,
        formationId: formation.id, vehicleIds: formation.vehicleIds, pathReceiptId: formation.pathReceiptId } });
    }
    const clock = { nowMs: 110_000 };
    const dependencies = { db, fleetRuntime: runtimes.fleet, interiorRuntime: runtimes.interior, deployment: signed.deployment, committedTimeForWorld: () => clock.nowMs };
    const service = new ConductorInteriorService(dependencies);
    const checkpoint = (await loadFleetProducerCheckpoint(db, INTERIOR_FIXTURE_WORLD))!;
    return { directory, compiled, runtimes, signed, client, db, clock, dependencies, service, checkpoint };
  } catch (error) { await client.close(); throw error; }
}
export function interiorFixtureAccess(checkpoint: FleetProducerCheckpoint, formation = 1) {
  return { worldId: INTERIOR_FIXTURE_WORLD, operatorId: INTERIOR_FIXTURE_OPERATOR, keycloakSubject: INTERIOR_FIXTURE_SUBJECT,
    formationId: `fixture-interior-formation-${formation}`, periodId: INTERIOR_FIXTURE_PERIOD, expectedFleetStateHash: checkpoint.stateHash };
}
