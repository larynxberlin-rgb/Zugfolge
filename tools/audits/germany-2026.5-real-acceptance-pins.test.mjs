import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  GERMANY_2026_5_REAL_ACCEPTANCE_PIN_SCHEMA,
  validateGermany20265RealAcceptancePins,
  verifyGermany20265PinRegistration,
  verifyGermany20265RealBuilderOutputs,
} from "./germany-2026.5-real-acceptance-pins.mjs";

const execute = promisify(execFile);
const hash = (label) => createHash("sha256").update(label).digest("hex");
const sourceCommit = createHash("sha1").update("germany-2026.5-source-commit").digest("hex");

function binding(file, label, bytes = 128) {
  return { file, bytes, sha256: hash(label) };
}

function pins() {
  const operationalStateHash = hash("operational-state");
  const transferSetSha256 = hash("transfer-set");
  return {
    schema: GERMANY_2026_5_REAL_ACCEPTANCE_PIN_SCHEMA,
    releaseId: "infra-deutschland-2026.5",
    sourceCommit,
    alphaWorldBuildConfiguration: binding("alpha-world-build-configuration.json", "alpha-config"),
    operationalInfrastructure: {
      ...binding("operational-infrastructure-v2.json", "operational-file", 900 * 1024 * 1024),
      schemaVersion: "zugfolge-operational-infrastructure-binding/v2",
      stateHash: operationalStateHash,
    },
    timetableTransferDemands: {
      ...binding("timetable-routes-v2.transfer-demands-v2.json", "transfer-file"),
      dailyPlanSha256: hash("daily-plan"),
      transferSetSha256,
    },
    movementRouteTemplates: {
      ...binding("operational-infrastructure-v2.movement-route-templates-v2.json", "movement-file"),
      stateHash: hash("movement-state"),
      operationalStateHash,
      timetableTransferSetSha256: transferSetSha256,
    },
    semanticPmtiles: binding("map-release-free-v2/infra-deutschland-2026.5.pmtiles", "pmtiles"),
    mapSourceCapture: binding("map-release-free-v2/public/map-source-capture.json", "capture"),
    staticMapSources: binding("map-release-free-v2/public/static-map-sources-v2.json", "sources"),
    unsignedDeployment: binding("alpha-world-deployment.2026.5.json", "unsigned", 256),
    signedDeployment: {
      ...binding("alpha-world-deployment.2026.5.signed.json", "signed", 384),
      deploymentHash: hash("deployment"),
      signatureKeyId: "zugfolge-alpha-2026.3",
    },
    runtimeBuild: {
      nativeAddonSha256: hash("napi"),
      typescriptBuildSetSha256: hash("typescript-build-set"),
    },
    signedMapPackageManifest: binding("map-package-signed/manifest.json", "package-manifest"),
  };
}

test("2026.5-Realabnahmepins binden Commit, V2-Dateien, Signatur und Runtime ohne Jahresfallback", () => {
  const value = pins();
  assert.deepEqual(validateGermany20265RealAcceptancePins(value, sourceCommit), value);
});

test("2026.5-Realabnahmepins lehnen fremden Commit und Transfer-v1 geschlossen ab", () => {
  assert.throws(
    () => validateGermany20265RealAcceptancePins(pins(), createHash("sha1").update("other-commit").digest("hex")),
    /nicht zum ausgecheckten Source-Commit/u,
  );
  const legacy = pins();
  legacy.timetableTransferDemands.file = "timetable-routes-v2.transfer-demands-v1.json";
  assert.throws(
    () => validateGermany20265RealAcceptancePins(legacy, sourceCommit),
    /transfer-demands-v2\.json/u,
  );
});

test("2026.5-Realabnahmepins lehnen entkoppelte Operational-/Movement-/Transfer-Hashes ab", () => {
  const wrongOperational = pins();
  wrongOperational.movementRouteTemplates.operationalStateHash = hash("foreign-operational-state");
  assert.throws(
    () => validateGermany20265RealAcceptancePins(wrongOperational, sourceCommit),
    /verschiedene State-Hashes/u,
  );

  const wrongTransfer = pins();
  wrongTransfer.movementRouteTemplates.timetableTransferSetSha256 = hash("foreign-transfer-set");
  assert.throws(
    () => validateGermany20265RealAcceptancePins(wrongTransfer, sourceCommit),
    /verschiedene Transfer-Set-Hashes/u,
  );
});

test("2026.5-Realabnahmepins akzeptieren weder unvollstaendige Pins noch zusaetzliche Schlupfloecher", () => {
  const missing = pins();
  delete missing.runtimeBuild.nativeAddonSha256;
  assert.throws(
    () => validateGermany20265RealAcceptancePins(missing, sourceCommit),
    /runtimeBuild besitzt nicht exakt/u,
  );

  const extra = pins();
  extra.previousReleaseFallback = "infra-deutschland-2026.4";
  assert.throws(
    () => validateGermany20265RealAcceptancePins(extra, sourceCommit),
    /besitzt nicht exakt/u,
  );
});

test("frische Builderausgaben muessen bytegleich zum Kandidaten und an beide Commits gebunden sein", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-2026.5-real-builder-"));
  const builderRoot = join(root, "builder");
  const candidateRoot = join(root, "candidate");
  const value = pins();
  const registration = createHash("sha1").update("pin-registration").digest("hex");
  try {
    for (const [name, contents] of [
      ["semanticPmtiles", Buffer.from("pmtiles-v2")],
      ["mapSourceCapture", Buffer.from("capture-v2\n")],
      ["staticMapSources", Buffer.from("sources-v2\n")],
    ]) {
      const current = value[name];
      current.bytes = contents.byteLength;
      current.sha256 = createHash("sha256").update(contents).digest("hex");
      for (const artifactRoot of [builderRoot, candidateRoot]) {
        const path = join(artifactRoot, ...current.file.split("/"));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents, { flag: "wx" });
      }
    }
    const validated = validateGermany20265RealAcceptancePins(value, sourceCommit);
    const receipt = await verifyGermany20265RealBuilderOutputs(
      builderRoot,
      candidateRoot,
      validated,
      registration,
    );
    assert.equal(receipt.sourceCommit, sourceCommit);
    assert.equal(receipt.pinRegistrationCommit, registration);
    assert.equal(receipt.candidateBytesEqual, true);
    assert.deepEqual(receipt.proofs.semanticPmtiles.fresh, receipt.proofs.semanticPmtiles.candidate);
    await assert.rejects(
      verifyGermany20265RealBuilderOutputs(builderRoot, candidateRoot, validated, sourceCommit),
      /duerfen nicht derselbe Commit sein/u,
    );

    await writeFile(
      join(candidateRoot, ...validated.staticMapSources.file.split("/")),
      "tampered\n",
    );
    await assert.rejects(
      verifyGermany20265RealBuilderOutputs(builderRoot, candidateRoot, validated, registration),
      /Kandidat staticMapSources verletzt/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pin-Registrierung lehnt fehlenden und nicht-vorfahren Source-Commit vor detached Checkout ab", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "zugfolge-2026.5-pin-git-"));
  const pinPath = join(repositoryRoot, "tools/audits/germany-2026.5-real-acceptance.pins.json");
  const git = (...args) => execute("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  try {
    await git("init", "--quiet", "--initial-branch=main");
    await git("config", "user.name", "Zugfolge Test");
    await git("config", "user.email", "zugfolge-test@example.invalid");
    await mkdir(dirname(pinPath), { recursive: true });
    await writeFile(join(repositoryRoot, "source.txt"), "source\n", { flag: "wx" });
    await git("add", "source.txt");
    await git("commit", "--quiet", "-m", "source");
    const ancestorSourceCommit = (await git("rev-parse", "HEAD")).stdout.trim();

    const missingSourceCommit = "f".repeat(40);
    const missingPins = pins();
    missingPins.sourceCommit = missingSourceCommit;
    await writeFile(pinPath, `${JSON.stringify(missingPins, null, 2)}\n`, { flag: "wx" });
    await git("add", "tools/audits/germany-2026.5-real-acceptance.pins.json");
    await git("commit", "--quiet", "-m", "register missing source");
    const missingRegistration = (await git("rev-parse", "HEAD")).stdout.trim();
    await assert.rejects(
      verifyGermany20265PinRegistration(
        pinPath,
        validateGermany20265RealAcceptancePins(missingPins, missingSourceCommit),
        missingRegistration,
      ),
    );

    const tree = (await git("rev-parse", "HEAD^{tree}")).stdout.trim();
    const nonAncestorSourceCommit = (await git("commit-tree", tree, "-m", "detached non-ancestor source")).stdout.trim();
    const nonAncestorPins = pins();
    nonAncestorPins.sourceCommit = nonAncestorSourceCommit;
    await writeFile(pinPath, `${JSON.stringify(nonAncestorPins, null, 2)}\n`);
    await git("add", "tools/audits/germany-2026.5-real-acceptance.pins.json");
    await git("commit", "--quiet", "-m", "register non-ancestor source");
    const nonAncestorRegistration = (await git("rev-parse", "HEAD")).stdout.trim();
    await assert.rejects(
      verifyGermany20265PinRegistration(
        pinPath,
        validateGermany20265RealAcceptancePins(nonAncestorPins, nonAncestorSourceCommit),
        nonAncestorRegistration,
      ),
    );

    const validPins = pins();
    validPins.sourceCommit = ancestorSourceCommit;
    await writeFile(pinPath, `${JSON.stringify(validPins, null, 2)}\n`);
    await git("add", "tools/audits/germany-2026.5-real-acceptance.pins.json");
    await git("commit", "--quiet", "-m", "register ancestor source");
    const validRegistration = (await git("rev-parse", "HEAD")).stdout.trim();
    await assert.doesNotReject(
      verifyGermany20265PinRegistration(
        pinPath,
        validateGermany20265RealAcceptancePins(validPins, ancestorSourceCommit),
        validRegistration,
      ),
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
