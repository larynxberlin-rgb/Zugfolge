import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArtAtlasManifest } from "../../packages/conductor-art/dist/index.js";
import { createInteriorNativeFixture, interiorFixtureAccess, INTERIOR_FIXTURE_WORLD, INTERIOR_FIXTURE_PERIOD,
  hasInteriorNativeFixture } from "../../apps/game-api/dist/conductor-interior.native-fixture.js";
import { startInteriorPreviewServer } from "./server.mjs";

const failure = (code) => Object.assign(new Error(code), { code });
const CASES = [
  { id: "regional-row", label: "Nahverkehr · Reihensitze", description: "Drei Kästen, 120 Sitz- und 40 Stehplätze, vier Türen je Seite und zwei WCs." },
  { id: "regional-double", label: "Doppelstock · Gegenübersitze", description: "Drei Kästen mit zwei Decks, 200 Sitz- und 20 Stehplätze, sechs Türen je Seite und drei WCs." },
  { id: "regional-folding", label: "Nahverkehr · Klappsitze", description: "Drei Kästen, 96 Sitz- und 48 Stehplätze, acht Türen je Seite und acht Kinderwagenflächen." },
  { id: "configuration-missing", label: "Unvollständiger Konfigurationsbeleg", description: "Dasselbe M5-Fahrzeug ohne Innenraumbeleg: Der Katalog bleibt betrieblich gültig, der Einstieg wird verweigert." },
];

/** Lokaler Abnahmenachweis mit echtem Compiler, M5, DB, Autorisierung und Rust.
 * Der kurzlebige Testschlüssel wird ausschließlich im Fixture erzeugt. Keine Weltaktivierung.
 */
export async function createNativeInteriorPreviewBackend() {
  if (!hasInteriorNativeFixture) throw failure("preview_native_dependencies_missing");
  const complete = await createInteriorNativeFixture();
  let incomplete;
  try {
    incomplete = await createInteriorNativeFixture({ missingConfigurationVehicleId: "fixture-interior-vehicle-1" });
    const period = complete.signed.deployment.period(INTERIOR_FIXTURE_WORLD, INTERIOR_FIXTURE_PERIOD, complete.clock.nowMs);
    if (!period) throw failure("preview_period_missing");
    const manifestBytes = await readFile(join(complete.signed.document.periods[0].artDirectory, "manifest.json"));
    if (createHash("sha256").update(manifestBytes).digest("hex") !== period.artPin.manifestSha256) throw failure("preview_manifest_changed");
    const manifest = parseArtAtlasManifest(JSON.parse(manifestBytes.toString("utf8")));
    const receipt = JSON.parse(await readFile(join(complete.compiled.output, "vehicle-catalog-compile-receipt-v4.json"), "utf8"));
    const incompleteReceipt = JSON.parse(await readFile(join(incomplete.compiled.output, "vehicle-catalog-compile-receipt-v4.json"), "utf8"));
    const evidence = {
      source: "Explizit fiktive M5-Spielkonfigurationen; keine realen Baureihendaten",
      compiler: "zugfolge-vehicle-catalog · tatsächliche kompilierte Source- und Seeddateien",
      compilerOutputSetHash: receipt.outputSetSha256,
      persistence: "PGlite mit echten Migrationen und FleetProducer-Checkpoints",
      worldId: INTERIOR_FIXTURE_WORLD, periodId: INTERIOR_FIXTURE_PERIOD,
      simulationTimeMs: complete.clock.nowMs, fleetRevision: complete.checkpoint.state.revision,
      fleetStateHash: complete.checkpoint.stateHash, snapshotHash: complete.checkpoint.snapshotHash,
      authorityReleaseHash: complete.checkpoint.state.authorityReleaseHash,
      artManifestHash: period.artPin.manifestSha256,
      artVerification: "Freigegebener Korpus mit geprüftem temporärem Testschlüssel; keine produktive Signatur",
      nativeGeometry: true, browserSuppliedLayout: false,
    };
    async function current(caseId) {
      const index = CASES.findIndex((item) => item.id === caseId);
      if (index < 0) throw failure("preview_case_missing");
      const fixture = index === 3 ? incomplete : complete;
      return fixture.service.layout(interiorFixtureAccess(fixture.checkpoint, index === 3 ? 1 : index + 1));
    }
    return Object.freeze({
      async listCases() {
        return { schemaVersion: "conductor-interior-preview-cases/v1", cases: structuredClone(CASES),
          art: { manifest: structuredClone(manifest), manifestSha256: period.artPin.manifestSha256, verification: evidence.artVerification },
          evidence: structuredClone(evidence) };
      },
      async loadCase(caseId) {
        try {
          const layout = await current(caseId);
          return { layout, evidence: { ...evidence, layoutHash: layout.layoutHash, formationId: layout.binding.formationId } };
        } catch (error) {
          if (error.code !== "interior_configuration_missing" || caseId !== "configuration-missing") throw error;
          return { issue: { code: error.code, message: `Fahrzeug ${error.vehicleId}: vollständiger M5-Beleg vehicleConfiguration fehlt.` },
            evidence: { ...evidence, fleetStateHash: incomplete.checkpoint.stateHash, snapshotHash: incomplete.checkpoint.snapshotHash,
              authorityReleaseHash: incomplete.checkpoint.state.authorityReleaseHash, compilerOutputSetHash: incompleteReceipt.outputSetSha256,
              rejectedVehicleId: error.vehicleId } };
        }
      },
      async findPath(caseId, input) {
        const layout = await current(caseId);
        return complete.runtimes.interior.path({ schemaVersion: "conductor-interior-path-input/v1", ...input, layout });
      },
      async checkMovement(caseId, input) {
        const layout = await current(caseId);
        return complete.runtimes.interior.movement({ schemaVersion: "conductor-interior-movement-input/v1", ...input, layout });
      },
      artFile(fileId) { return period.atlas.file(INTERIOR_FIXTURE_WORLD, fileId); },
      async close() { await Promise.all([complete.client.close(), incomplete.client.close()]); },
    });
  } catch (error) {
    await Promise.all([complete.client.close(), incomplete?.client.close()]); throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const backend = await createNativeInteriorPreviewBackend();
  try {
    const server = await startInteriorPreviewServer({ port: Number(process.env.CONDUCTOR_INTERIOR_PORT ?? 4187), backend });
    process.stdout.write(`Innenraumprüfung mit echtem M5/Rust: http://127.0.0.1:${server.address().port}\n`);
    let stopping = false;
    const stop = () => { if (!stopping) { stopping = true; server.close(async () => { await backend.close(); process.exit(0); }); } };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  } catch (error) { await backend.close(); throw error; }
}
