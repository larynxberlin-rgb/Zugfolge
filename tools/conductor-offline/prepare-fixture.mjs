/** Originaler M5-/Betriebs-/M10-Quellproduzent, vor jeder lokalen Kontrollkonfiguration. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nativeExample, outputPath, repository, root } from "./paths.mjs";
import { verifyNativeKernel } from "./native/verify-native.mjs";

await verifyNativeKernel();
const binary = nativeExample("session_fixture", "ZUGFOLGE_SESSION_FIXTURE_BINARY");
const result = spawnSync(binary, ["2"], { cwd: repository, encoding: "utf8", windowsHide: true,
  maxBuffer: 16 * 1024 * 1024 });
if (result.error || result.status !== 0) throw new Error("Das vorhandene Originalprogramm session_fixture 2 konnte die Demoquelle nicht erzeugen.");
const fixture = JSON.parse(result.stdout);
assert.equal(fixture.testOnly, true);
for (const key of ["source", "demand", "initialState", "access", "infrastructure", "materialization"]) {
  assert.ok(fixture[key] && typeof fixture[key] === "object", `Originalquelle unvollständig: ${key}`);
}
await writeFile(resolve(root, "data/fixture.json"), result.stdout);
await writeFile(outputPath("fixture-preparation.json"), JSON.stringify({
  schemaVersion: "conductor-offline-fixture-export/v1", testOnly: true,
  source: "crates/zugfolge-conductor-session/examples/session_fixture.rs", argument: "2",
  fixtureFileSha256: createHash("sha256").update(result.stdout).digest("hex"),
  next: ["prepare-data.mjs", "prepare-control.mjs", "prepare-practice.mjs 0", "prepare-scene.mjs"],
}, null, 2) + "\n");
process.stdout.write("Originale Doppelstock-Demoquelle erzeugt; Kontroll-, Übungs- und Szenenvorbereitung folgen vor dem Build.\n");
