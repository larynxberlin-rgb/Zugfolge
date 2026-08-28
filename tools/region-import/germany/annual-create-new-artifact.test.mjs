import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX,
  materializeGermanyAnnualCreateNewArtifact,
  verifyGermanyAnnualCreateNewArtifact,
} from "./annual-create-new-artifact.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-annual-create-new-"));
  const outputRoot = join(root, "var", "derived");
  await mkdir(outputRoot, { recursive: true });
  const helper = {};
  if (process.platform === "win32") {
    const file = "tools/region-import/germany/operational-windows-anchor-helper.dll";
    const target = join(root, ...file.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(dirname(fileURLToPath(import.meta.url)), "operational-windows-anchor-helper.dll"), target);
    const bytes = await readFile(target);
    helper.anchorHelperProof = {
      bytes: bytes.length,
      file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  return { root, output: join(outputRoot, "receipt.json"), helper };
}

test("Annual-create-new publiziert Daten erst vollstaendig und bindet einen letzten Completion-Beleg", async () => {
  const value = await fixture();
  try {
    const bytes = Buffer.from('{"schema":"fixture"}\n', "utf8");
    const proof = await materializeGermanyAnnualCreateNewArtifact({
      workspaceRoot: value.root,
      outputPath: value.output,
      bytes,
      ...value.helper,
    });
    assert.deepEqual(await readFile(value.output), bytes);
    const verified = await verifyGermanyAnnualCreateNewArtifact({
      workspaceRoot: value.root,
      outputPath: value.output,
      expectedProof: proof,
      ...value.helper,
    });
    assert.equal(verified.proof.sha256, proof.sha256);
    await access(`${value.output}${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Exaktes Artifact ohne Completion wird ohne Ersatz des Artifacts vervollstaendigt", async () => {
  const value = await fixture();
  try {
    const bytes = Buffer.from('{"schema":"artifact-only-recovery"}\n', "utf8");
    await writeFile(value.output, bytes, { flag: "wx" });
    const proof = await materializeGermanyAnnualCreateNewArtifact({
      workspaceRoot: value.root,
      outputPath: value.output,
      bytes,
      ...value.helper,
    });
    assert.deepEqual(await readFile(value.output), bytes);
    const verified = await verifyGermanyAnnualCreateNewArtifact({
      workspaceRoot: value.root,
      outputPath: value.output,
      expectedProof: proof,
      ...value.helper,
    });
    assert.equal(verified.proof.sha256, proof.sha256);
    await access(`${value.output}${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Abbruch nach gemeinsamem Commit bleibt als vollstaendig verifizierbares Paar idempotent", async () => {
  const value = await fixture();
  try {
    const bytes = Buffer.from('{"schema":"recovery"}\n', "utf8");
    await assert.rejects(materializeGermanyAnnualCreateNewArtifact({
      workspaceRoot: value.root,
      outputPath: value.output,
      bytes,
      ...value.helper,
      hooks: { afterCompletionPublish: () => { throw new Error("controlled-abort"); } },
    }), /controlled-abort/u);
    assert.deepEqual(await readFile(value.output), bytes);
    await verifyGermanyAnnualCreateNewArtifact({ workspaceRoot: value.root, outputPath: value.output, ...value.helper });
    const recovered = await materializeGermanyAnnualCreateNewArtifact({
      workspaceRoot: value.root,
      outputPath: value.output,
      bytes,
      ...value.helper,
    });
    assert.equal((await verifyGermanyAnnualCreateNewArtifact({
      workspaceRoot: value.root,
      outputPath: value.output,
      expectedProof: recovered,
      ...value.helper,
    })).proof.sha256, recovered.sha256);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Abbruch im Staging erzeugt keinen sichtbaren Finalpfad", async () => {
  const value = await fixture();
  try {
    await assert.rejects(materializeGermanyAnnualCreateNewArtifact({
      workspaceRoot: value.root,
      outputPath: value.output,
      bytes: Buffer.from("staged-only\n", "utf8"),
      ...value.helper,
      hooks: { afterStaging: () => { throw new Error("controlled-stage-abort"); } },
    }), /controlled-stage-abort/u);
    await assert.rejects(access(value.output));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Recovery ersetzt oder loescht weder fremde Finalbytes noch fremde Completion-Belege", async () => {
  const value = await fixture();
  try {
    const foreign = Buffer.from("foreign\n", "utf8");
    await writeFile(value.output, foreign, { flag: "wx" });
    await assert.rejects(materializeGermanyAnnualCreateNewArtifact({
      workspaceRoot: value.root,
      outputPath: value.output,
      bytes: Buffer.from("owned\n", "utf8"),
      ...value.helper,
    }), /fremden Bytes/u);
    assert.deepEqual(await readFile(value.output), foreign);

    await unlink(value.output);
    const foreignCompletion = Buffer.from("foreign-completion\n", "utf8");
    await writeFile(`${value.output}${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`, foreignCompletion, { flag: "wx" });
    await assert.rejects(materializeGermanyAnnualCreateNewArtifact({
      workspaceRoot: value.root,
      outputPath: value.output,
      bytes: Buffer.from("owned\n", "utf8"),
      ...value.helper,
    }), /Completion-Beleg existiert ohne sein Artefakt/u);
    await assert.rejects(access(value.output));
    assert.deepEqual(await readFile(`${value.output}${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`), foreignCompletion);

    await unlink(`${value.output}${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`);
    const exact = Buffer.from("owned\n", "utf8");
    await writeFile(value.output, exact, { flag: "wx" });
    await writeFile(`${value.output}${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`, foreignCompletion, { flag: "wx" });
    await assert.rejects(materializeGermanyAnnualCreateNewArtifact({
      workspaceRoot: value.root,
      outputPath: value.output,
      bytes: exact,
      ...value.helper,
    }), /unvollstaendig oder mit fremden Bytes/u);
    assert.deepEqual(await readFile(value.output), exact);
    assert.deepEqual(await readFile(`${value.output}${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`), foreignCompletion);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Windows-Helper verweigert Staging-A-zu-B-Swap vor PublishOrRecoverPair", { skip: process.platform !== "win32" }, async () => {
  const value = await fixture();
  try {
    const bytes = Buffer.from("artifact-a\n", "utf8");
    await assert.rejects(materializeGermanyAnnualCreateNewArtifact({
      workspaceRoot: value.root,
      outputPath: value.output,
      bytes,
      ...value.helper,
      hooks: {
        afterStaging: async ({ stagedArtifact }) => {
          const replacement = `${stagedArtifact}.replacement`;
          await writeFile(replacement, Buffer.from("artifact-b\n", "utf8"), { flag: "wx" });
          await rename(replacement, stagedArtifact);
        },
      },
    }), /Anchor-Helper scheiterte fail-closed/u);
    await assert.rejects(access(value.output));
    await assert.rejects(access(`${value.output}${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Windows-Helper verweigert Output-A-zu-B-Swap zwischen Completion-Lesen und VerifyPair", { skip: process.platform !== "win32" }, async () => {
  const value = await fixture();
  try {
    const bytes = Buffer.from("artifact-a\n", "utf8");
    const proof = await materializeGermanyAnnualCreateNewArtifact({
      workspaceRoot: value.root,
      outputPath: value.output,
      bytes,
      ...value.helper,
    });
    await assert.rejects(verifyGermanyAnnualCreateNewArtifact({
      workspaceRoot: value.root,
      outputPath: value.output,
      expectedProof: proof,
      ...value.helper,
      hooks: {
        beforeAnchorVerify: async ({ output }) => {
          const replacement = `${output}.replacement`;
          await writeFile(replacement, Buffer.from("artifact-b\n", "utf8"), { flag: "wx" });
          await unlink(output);
          await rename(replacement, output);
        },
      },
    }), /Anchor-Helper scheiterte fail-closed/u);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
