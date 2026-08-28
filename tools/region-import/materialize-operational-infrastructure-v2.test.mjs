import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, lstat, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { materializeOperationalInfrastructureV2 } from "./materialize-operational-infrastructure-v2.mjs";
import {
  canonicalOperationalInfrastructureV2Json,
  operationalInfrastructureV2StateHash,
} from "./operational-infrastructure-binding.mjs";

const RELEASE_ID = "infra-deutschland-2026.2";

function candidate() {
  return {
    id: RELEASE_ID,
    directedEdges: { "edge-1": 1_000 },
    edgeGeometries: {
      "edge-1": [
        { edgeOffsetMm: 0, latitudeE7: 510_000_000, longitudeE7: 120_000_000, bearingMilliDegrees: 90_000 },
        { edgeOffsetMm: 1_000, latitudeE7: 510_000_000, longitudeE7: 120_001_000, bearingMilliDegrees: null },
      ],
    },
    routeVersions: {
      "route-1": {
        id: "route-1",
        templateId: "template-1",
        predecessorId: null,
        transitionRouteMm: null,
        legs: [{
          edgeId: "edge-1",
          direction: "along",
          edgeEntryMm: 0,
          edgeExitMm: 1_000,
          routeStartMm: 0,
          blockIds: ["block-1"],
          speedLimitMmps: 20_000,
          gradientPerMille: 0,
          availableProtectionSystems: ["pzb"],
          simultaneouslyRequiredProtectionSystems: [],
        }],
      },
    },
    interlockingRoutes: {
      "interlocking-1": {
        id: "interlocking-1",
        routeTemplateId: "template-1",
        signalId: "signal-1",
        movementKind: "train",
        pathResources: ["block-1"],
        overlapResources: ["overlap-1"],
        flankResources: ["flank-1"],
        switchPositions: {},
        authorityStartRouteMm: 0,
        authorityEndRouteMm: 1_000,
        releaseAfterTailRouteMm: 1_000,
      },
    },
    signals: ["signal-1"],
    switches: [],
    blockResources: ["block-1", "flank-1", "overlap-1"],
    platformIntervals: {},
    regionBoundaries: [],
    rzueLayoutId: "rzue-layout-1",
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function nativeReceipt(candidatePath, expectedReleaseId, outputPath, mutateReceipt = (receipt) => receipt) {
  const source = await readFile(candidatePath);
  const infrastructure = JSON.parse(source);
  assert.equal(infrastructure.id, expectedReleaseId);
  const output = Buffer.from(`${canonicalOperationalInfrastructureV2Json(infrastructure)}\n`, "utf8");
  await writeFile(outputPath, output, { flag: "wx" });
  return mutateReceipt({
    schema: "operational-infrastructure-v2",
    infraReleaseId: expectedReleaseId,
    sourceBytes: source.length,
    sourceSha256: sha256(source),
    bytes: output.length,
    sha256: sha256(output),
    stateHash: operationalInfrastructureV2StateHash(infrastructure),
    validationMode: "native-streaming-redb-v1",
  });
}

async function writeLargeCandidate(path) {
  const infrastructure = candidate();
  delete infrastructure.regionBoundaries;
  const handle = await open(path, "wx");
  try {
    const prefix = `${JSON.stringify(infrastructure).slice(0, -1)},\"regionBoundaries\":[`;
    await handle.write(prefix);
    for (let start = 0; start < 4_096; start += 128) {
      const values = [];
      for (let index = start; index < start + 128; index += 1) {
        values.push(`region-${String(index).padStart(4, "0")}-${"x".repeat(16_384)}`);
      }
      await handle.write(`${start === 0 ? "" : ","}${values.map((value) => JSON.stringify(value)).join(",")}`);
    }
    await handle.write("]}\n");
  } finally {
    await handle.close();
  }
  assert.ok((await lstat(path)).size > 64 * 1024 * 1024);
}

test("weist einen leeren Durchrutschweg bereits im JavaScript-Binding zurueck", () => {
  const infrastructure = candidate();
  infrastructure.interlockingRoutes["interlocking-1"].overlapResources = [];
  assert.throws(
    () => operationalInfrastructureV2StateHash(infrastructure),
    /keinen nichtleeren Durchrutschweg/u,
  );
});

test("weist leeren Flankenschutz bereits im JavaScript-Binding zurueck", () => {
  const infrastructure = candidate();
  infrastructure.interlockingRoutes["interlocking-1"].flankResources = [];
  assert.throws(
    () => operationalInfrastructureV2StateHash(infrastructure),
    /keinen nichtleeren Flankenschutz/u,
  );
});

test("bindet alle drei Fahrstrassenmengen an vorhandene blockResources", () => {
  for (const field of ["pathResources", "overlapResources", "flankResources"]) {
    const infrastructure = candidate();
    infrastructure.interlockingRoutes["interlocking-1"][field] = [`unknown-${field}`];
    assert.throws(
      () => operationalInfrastructureV2StateHash(infrastructure),
      /keine vorhandene blockResources-Ressource/u,
    );
  }
});

test("materialisiert einen nativen Rust-validierten Candidate Ende-zu-Ende", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-materialize-operational-v2-native-"));
  try {
    const candidatePath = join(root, "candidate.json");
    const outputPath = join(root, "release", "operational-infrastructure-v2.json");
    await writeFile(candidatePath, JSON.stringify(candidate()));
    const receipt = await materializeOperationalInfrastructureV2({
      candidatePath,
      expectedReleaseId: RELEASE_ID,
      outputPath,
    });
    assert.equal(receipt.stateHash, operationalInfrastructureV2StateHash(candidate()));
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), candidate());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materialisiert erst nach übereinstimmender nativer Validierung kanonische statische Bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-materialize-operational-v2-"));
  try {
    const candidatePath = join(root, "candidate.json");
    const outputPath = join(root, "release", "operational-infrastructure-v2.json");
    const value = candidate();
    await writeFile(candidatePath, JSON.stringify(value));
    let validated = false;
    const receipt = await materializeOperationalInfrastructureV2({
      candidatePath,
      expectedReleaseId: RELEASE_ID,
      outputPath,
      validateNative: async (path, releaseId, nativeOutputPath) => {
        validated = path === candidatePath && releaseId === RELEASE_ID && nativeOutputPath !== outputPath;
        return nativeReceipt(path, releaseId, nativeOutputPath);
      },
    });
    assert.equal(validated, true);
    assert.equal(receipt.stateHash, operationalInfrastructureV2StateHash(value));
    assert.notEqual(receipt.sha256, receipt.stateHash);
    const materialized = await readFile(outputPath, "utf8");
    assert.equal(materialized.endsWith("\n"), true);
    assert.deepEqual(JSON.parse(materialized), value);
    assert.equal(materialized.startsWith('{"blockResources":'), true);
    assert.doesNotMatch(materialized, /"worldId"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materialisiert einen Candidate oberhalb 64 MiB ausschließlich über den nativen Streamingpfad", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-materialize-operational-v2-streaming-"));
  try {
    const candidatePath = join(root, "candidate.json");
    const outputPath = join(root, "operational-infrastructure-v2.json");
    await writeLargeCandidate(candidatePath);
    const receipt = await materializeOperationalInfrastructureV2({
      candidatePath,
      expectedReleaseId: RELEASE_ID,
      outputPath,
    });
    assert.equal(receipt.validationMode, "native-streaming-redb-v1");
    assert.ok(receipt.sourceBytes > 64 * 1024 * 1024);
    assert.ok(receipt.bytes > 64 * 1024 * 1024);
    assert.equal((await lstat(outputPath)).size, receipt.bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verwirft manipulierte native Receipts für Release-ID, Zustand, Quelle und Ausgabe", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-materialize-operational-v2-negative-"));
  try {
    const candidatePath = join(root, "candidate.json");
    await writeFile(candidatePath, JSON.stringify(candidate()));
    const cases = [
      ["release", (receipt) => ({ ...receipt, infraReleaseId: "infra-deutschland-foreign" }), /Schema-, Release- und Modusbindung/u],
      ["state", (receipt) => ({ ...receipt, stateHash: "0".repeat(64) }), /Kanonisierung laufen auseinander/u],
      ["source", (receipt) => ({ ...receipt, sourceSha256: "0".repeat(64) }), /Candidate-Bytes gebunden/u],
      ["output", (receipt) => ({ ...receipt, sha256: "0".repeat(64) }), /Ausgabe-Bytes gebunden/u],
    ];
    for (const [label, mutate, expectedError] of cases) {
      const outputPath = join(root, label, "operational-infrastructure-v2.json");
      await assert.rejects(
        materializeOperationalInfrastructureV2({
          candidatePath,
          expectedReleaseId: RELEASE_ID,
          outputPath,
          validateNative: (path, releaseId, nativeOutputPath) => nativeReceipt(path, releaseId, nativeOutputPath, mutate),
        }),
        expectedError,
      );
      await assert.rejects(access(outputPath));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verwirft eine nach Receipt-Erzeugung manipulierte native Ausgabe", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-materialize-operational-v2-output-negative-"));
  try {
    const candidatePath = join(root, "candidate.json");
    const outputPath = join(root, "operational-infrastructure-v2.json");
    await writeFile(candidatePath, JSON.stringify(candidate()));
    await assert.rejects(
      materializeOperationalInfrastructureV2({
        candidatePath,
        expectedReleaseId: RELEASE_ID,
        outputPath,
        validateNative: async (path, releaseId, nativeOutputPath) => {
          const receipt = await nativeReceipt(path, releaseId, nativeOutputPath);
          await writeFile(nativeOutputPath, "manipuliert", { flag: "a" });
          return receipt;
        },
      }),
      /Ausgabe-Bytes gebunden/u,
    );
    await assert.rejects(access(outputPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loescht nach dem create-new-Link keine fremd ersetzte Temporausgabe", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-materialize-operational-v2-owned-only-"));
  try {
    const candidatePath = join(root, "candidate.json");
    const outputPath = join(root, "operational-infrastructure-v2.json");
    let foreignTemporaryPath;
    let preservedOwnedTemporaryPath;
    await writeFile(candidatePath, JSON.stringify(candidate()));
    await assert.rejects(
      materializeOperationalInfrastructureV2({
        candidatePath,
        expectedReleaseId: RELEASE_ID,
        outputPath,
        validateNative: (path, releaseId, nativeOutputPath) => nativeReceipt(path, releaseId, nativeOutputPath),
        hooks: {
          beforeTemporaryCleanup: async ({ temporaryOutput }) => {
            foreignTemporaryPath = temporaryOutput;
            preservedOwnedTemporaryPath = `${temporaryOutput}.preserved-owned`;
            await rename(temporaryOutput, preservedOwnedTemporaryPath);
            await writeFile(temporaryOutput, "fremde-datei\n", { flag: "wx" });
          },
        },
      }),
      /fremd ersetzt|identitaetsgebunden|Bereinigung/u,
    );
    assert.equal(await readFile(foreignTemporaryPath, "utf8"), "fremde-datei\n");
    assert.ok((await lstat(preservedOwnedTemporaryPath)).isFile());
    await assert.rejects(access(outputPath), (error) => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stellt eine fremde Ersetzung zwischen Identitaetspruefung und Quarantaene am Originalpfad wieder her", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-materialize-operational-v2-quarantine-race-"));
  try {
    const candidatePath = join(root, "candidate.json");
    const outputPath = join(root, "operational-infrastructure-v2.json");
    let foreignTemporaryPath;
    let preservedOwnedTemporaryPath;
    let raced = false;
    await writeFile(candidatePath, JSON.stringify(candidate()));
    await assert.rejects(
      materializeOperationalInfrastructureV2({
        candidatePath,
        expectedReleaseId: RELEASE_ID,
        outputPath,
        validateNative: (path, releaseId, nativeOutputPath) => nativeReceipt(path, releaseId, nativeOutputPath),
        hooks: {
          beforeOwnedFileQuarantineRename: async ({ label, originalPath }) => {
            if (raced || !label.includes("Temporausgabe")) return;
            raced = true;
            foreignTemporaryPath = originalPath;
            preservedOwnedTemporaryPath = `${originalPath}.preserved-owned`;
            await rename(originalPath, preservedOwnedTemporaryPath);
            await writeFile(originalPath, "fremde-quarantaene-race-datei\n", { flag: "wx" });
          },
        },
      }),
      /fremde Ersatzdatei|wiederhergestellt|identitaetsgebunden/u,
    );
    assert.equal(raced, true);
    assert.equal(await readFile(foreignTemporaryPath, "utf8"), "fremde-quarantaene-race-datei\n");
    assert.ok((await lstat(preservedOwnedTemporaryPath)).isFile());
    await assert.rejects(access(outputPath), (error) => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stellt eine fremde Ersetzung nach dem letzten Quarantaenecheck am Originalpfad wieder her", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-materialize-operational-v2-final-unlink-race-"));
  try {
    const candidatePath = join(root, "candidate.json");
    const outputPath = join(root, "operational-infrastructure-v2.json");
    let foreignTemporaryPath;
    let preservedOwnedTemporaryPath;
    let raced = false;
    await writeFile(candidatePath, JSON.stringify(candidate()));
    await assert.rejects(
      materializeOperationalInfrastructureV2({
        candidatePath,
        expectedReleaseId: RELEASE_ID,
        outputPath,
        validateNative: (path, releaseId, nativeOutputPath) => nativeReceipt(path, releaseId, nativeOutputPath),
        hooks: {
          afterOwnedFileFinalIdentityCheck: async ({ label, originalPath, quarantinedPath }) => {
            if (raced || !label.includes("Temporausgabe")) return;
            raced = true;
            foreignTemporaryPath = originalPath;
            preservedOwnedTemporaryPath = `${quarantinedPath}.preserved-owned`;
            await rename(quarantinedPath, preservedOwnedTemporaryPath);
            await writeFile(quarantinedPath, "fremde-final-unlink-race-datei\n", { flag: "wx" });
          },
        },
      }),
      /unmittelbar vor dem Unlink|wiederhergestellt|identitaetsgebunden/u,
    );
    assert.equal(raced, true);
    assert.equal(await readFile(foreignTemporaryPath, "utf8"), "fremde-final-unlink-race-datei\n");
    assert.ok((await lstat(preservedOwnedTemporaryPath)).isFile());
    await assert.rejects(access(outputPath), (error) => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
