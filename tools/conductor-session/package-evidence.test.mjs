import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, dirname, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { packageConductorEvidence } from "./package-evidence.mjs";

test("binds all browser artifacts deterministically and rejects changed images, missing proofs, browser errors and escaping paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "conductor-evidence-")), revision = "a".repeat(40);
  try {
    await mkdir(join(root, "screenshots"));
    // A one-pixel test PNG is fixture data only, never an acceptance screenshot.
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j00sAAAAASUVORK5CYII=", "base64");
    await writeFile(join(root, "screenshots/test.png"), image);
    const report = { evidence: { worldId: "test-world", trainRunId: "test-train" }, pageErrors: [], screenshots: [{ file: "test.png", sha256: createHash("sha256").update(image).digest("hex") }] };
    for (const [file, schemaVersion] of [["browser-report.json", "conductor-session-browser-proof/v1"], ["scene-browser-report.json", "conductor-session-scene-browser-proof/v1"],
      ["control-browser-report.json", "conductor-control-browser-proof/v1"], ["capacity-browser-report.json", "conductor-session-capacity-browser-proof/v1"],
      ["manifest-browser-report.json", "conductor-manifest-browser-proof/v1"], ["acceptance-browser-report.json", "conductor-acceptance-browser-proof/v1"]]) await writeFile(join(root, file), JSON.stringify({ ...report, schemaVersion }));
    const dialogue = { schemaVersion: "conductor-dialogue-http-proof/v1", testOnly: true,
      worldId: "test-world", trainRunId: "test-train", dialogueReleaseHash: "b".repeat(64), initialDemandStateHash: "c".repeat(64),
      nativeM10Producer: true, httpCommands: true, reloadAndCommandReplay: true, originalFareFactsUnchanged: true,
      cases: Array.from({ length: 6 }, (_, index) => ({ scenario: `test-scenario-${index}`, restoredStateHash: "d".repeat(64) })) };
    await writeFile(join(root, "dialogue-http-report.json"), JSON.stringify(dialogue));
    const valid = await packageConductorEvidence({ root, revision });
    assert.equal(valid.testOnly, true); assert.equal(valid.proofs.length, 7); assert.equal(valid.files.length, 8);
    assert.deepEqual(await packageConductorEvidence({ root, revision }), valid);
    await writeFile(join(root, "dialogue-http-report.json"), JSON.stringify({ ...dialogue, originalFareFactsUnchanged: false }));
    await assert.rejects(packageConductorEvidence({ root, revision }), /Unsuccessful original dialogue HTTP report/u);
    await writeFile(join(root, "dialogue-http-report.json"), JSON.stringify({ ...dialogue, cases: dialogue.cases.slice(1) }));
    await assert.rejects(packageConductorEvidence({ root, revision }), /Incomplete original dialogue HTTP evidence/u);
    await writeFile(join(root, "dialogue-http-report.json"), JSON.stringify(dialogue));
    await writeFile(join(root, "screenshots/test.png"), Buffer.concat([image, Buffer.from("changed")]));
    await assert.rejects(packageConductorEvidence({ root, revision }), /Image hash mismatch/u);
    await writeFile(join(root, "screenshots/test.png"), image);
    const file = join(root, "control-browser-report.json"), original = await readFile(file, "utf8"), parsed = JSON.parse(original);
    await writeFile(file, JSON.stringify({ ...parsed, pageErrors: ["browser failed"] }));
    await assert.rejects(packageConductorEvidence({ root, revision }), /Unsuccessful browser report/u);
    await writeFile(file, JSON.stringify({ ...parsed, screenshots: [{ ...parsed.screenshots[0], file: "../test.png" }] }));
    await assert.rejects(packageConductorEvidence({ root, revision }), /Invalid image reference/u);
    await rm(file); await assert.rejects(packageConductorEvidence({ root, revision }), /ENOENT/u);
    await assert.rejects(packageConductorEvidence({ root, revision: "main" }), /exact Git revision/u);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("conductor-evidence-"));
    await rm(root, { recursive: true, force: true });
  }
});
