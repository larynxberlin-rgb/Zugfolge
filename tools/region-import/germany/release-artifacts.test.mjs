import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildReleaseArtifactInventory, readReleaseArtifactSpec } from "./release-artifacts.mjs";
import {
  canonicalOperationalInfrastructureV2Json,
  operationalInfrastructureV2StateHash,
} from "../operational-infrastructure-binding.mjs";
import { materializeOperationalInfrastructureV2 } from "../materialize-operational-infrastructure-v2.mjs";

function operationalInfrastructure(id = "infra-deutschland-2026.2") {
  return {
    id,
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

function v2Spec() {
  return {
    schema: "zugfolge-infra-release-artifact-spec/v2",
    artifacts: [{
      id: "operational-infrastructure-2026.2",
      kind: "operational-infrastructure-v2",
      infraReleaseId: "infra-deutschland-2026.2",
      sourceFile: "operational-infrastructure-v2.json",
      file: "operational-infrastructure-v2.json",
    }],
  };
}

async function validateOperationalInfrastructure(path, expectedReleaseId) {
  const source = await readFile(path);
  const infrastructure = JSON.parse(source);
  const canonical = Buffer.from(`${canonicalOperationalInfrastructureV2Json(infrastructure)}\n`, "utf8");
  return {
    schema: "operational-infrastructure-v2",
    infraReleaseId: expectedReleaseId,
    sourceBytes: source.length,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    bytes: canonical.length,
    sha256: createHash("sha256").update(canonical).digest("hex"),
    stateHash: operationalInfrastructureV2StateHash(infrastructure),
    validationMode: "native-streaming-redb-v1",
  };
}

function canonicalOperationalBytes(infrastructure) {
  return Buffer.from(`${canonicalOperationalInfrastructureV2Json(infrastructure)}\n`, "utf8");
}

async function streamedProof(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

function buildV2Inventory(spec, root) {
  return buildReleaseArtifactInventory(spec, root, { validateOperationalInfrastructure });
}

test("inventarisiert Releaseartefakte bytegenau und stabil sortiert", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-artifacts-"));
  await Promise.all([writeFile(join(root, "a.bin"), "a"), writeFile(join(root, "b.bin"), "bb")]);
  const result = await buildReleaseArtifactInventory({
    schema: "zugfolge-infra-release-artifact-spec/v1",
    artifacts: [
      { id: "zwei", kind: "second", sourceFile: "b.bin", file: "b.bin" },
      { id: "eins", kind: "first", sourceFile: "a.bin", file: "a.bin" },
    ],
  }, root);
  assert.deepEqual(result.artifacts.map(({ id, bytes }) => [id, bytes]), [["eins", 1], ["zwei", 2]]);
  assert.equal(result.artifacts[0].sha256, "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
});

test("der signierte Jahresrelease 2026.2 behält exakt seinen historischen v1-Artefaktvertrag", async () => {
  const spec = await readReleaseArtifactSpec(new URL("./release-artifacts.annual-2026.2.json", import.meta.url));
  assert.deepEqual(spec, {
    schema: "zugfolge-infra-release-artifact-spec/v1",
    artifacts: [
      { id: "infra-deutschland-2026.2", kind: "infrastructure", sourceFile: "var/derived/germany-2026.2/map-release/infra-deutschland-2026.2.pmtiles", file: "infra-deutschland-2026.2.pmtiles" },
      { id: "livemap-read-model-2026.2", kind: "read-model", sourceFile: "var/derived/germany-2026.2/map-release/public/read-model.sqlite", file: "read-model.sqlite" },
      { id: "livemap-train-map-projection-2026.2", kind: "train-map-projection", sourceFile: "var/derived/germany-2026.2/map-release/public/train-map-projection.sqlite", file: "train-map-projection.sqlite" },
      { id: "quality-report-2026.2", kind: "quality-report", sourceFile: "var/derived/germany-2026.2/map-release/public/quality.json", file: "quality.json" },
    ],
  });
});

test("inventarisiert statische Operational-v2-Infrastruktur mit getrenntem Byte- und Zustandshash", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-infrastructure-"));
  try {
    await writeFile(join(root, "operational-infrastructure-v2.json"), canonicalOperationalBytes(operationalInfrastructure()));
    const result = await buildV2Inventory(v2Spec(), root);
    assert.equal(result.schema, "zugfolge-infra-release-artifacts/v2");
    assert.deepEqual(result.artifacts.map(({ id, kind, file }) => ({ id, kind, file })), [{
      id: "operational-infrastructure-2026.2",
      kind: "operational-infrastructure-v2",
      file: "operational-infrastructure-v2.json",
    }]);
    assert.match(result.artifacts[0].sha256, /^[a-f0-9]{64}$/u);
    assert.match(result.artifacts[0].stateHash, /^[a-f0-9]{64}$/u);
    assert.notEqual(result.artifacts[0].sha256, result.artifacts[0].stateHash);
    assert.equal(result.artifacts[0].infraReleaseId, "infra-deutschland-2026.2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inventarisiert mehr als 64 MiB erst mit vollständigem nativen Streaming-Receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-infrastructure-streaming-"));
  try {
    const path = join(root, "operational-infrastructure-v2.json");
    const handle = await open(path, "w");
    try {
      await handle.truncate(64 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    const result = await buildReleaseArtifactInventory(v2Spec(), root, {
      validateOperationalInfrastructure: async (candidatePath, expectedReleaseId) => {
        const source = await streamedProof(candidatePath);
        return {
          schema: "operational-infrastructure-v2",
          infraReleaseId: expectedReleaseId,
          sourceBytes: source.bytes,
          sourceSha256: source.sha256,
          bytes: source.bytes,
          sha256: source.sha256,
          stateHash: "f".repeat(64),
          validationMode: "native-streaming-redb-v1",
        };
      },
    });
    assert.ok(result.artifacts[0].bytes > 64 * 1024 * 1024);
    assert.equal(result.artifacts[0].stateHash, "f".repeat(64));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Jahresspezifikation wird erst nach Materialisierung und nativer Candidate-Validierung grün", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-infrastructure-annual-"));
  try {
    const spec = await readReleaseArtifactSpec(new URL("./release-artifacts.annual-2026.3.json", import.meta.url));
    const derivedRoot = join(root, "var", "derived", "germany-2026.3");
    const mapReleaseRoot = join(derivedRoot, "map-release-free-v2");
    await mkdir(join(mapReleaseRoot, "public"), { recursive: true });
    await Promise.all([
      writeFile(join(mapReleaseRoot, "infra-deutschland-2026.3.pmtiles"), "pmtiles"),
      writeFile(join(mapReleaseRoot, "public", "read-model.sqlite"), "SQLite read model"),
      writeFile(join(derivedRoot, "operational-infrastructure-quality.json"), "{}\n"),
    ]);
    await assert.rejects(
      buildV2Inventory(spec, root),
      /operational-infrastructure-v2\.json/u,
    );

    const candidatePath = join(root, "candidate.json");
    await writeFile(candidatePath, JSON.stringify(operationalInfrastructure("infra-deutschland-2026.3")));
    await materializeOperationalInfrastructureV2({
      candidatePath,
      expectedReleaseId: "infra-deutschland-2026.3",
      outputPath: join(derivedRoot, "operational-infrastructure-v2.json"),
    });
    const inventory = await buildV2Inventory(spec, root);
    const operational = inventory.artifacts.find(({ kind }) => kind === "operational-infrastructure-v2");
    assert.equal(inventory.artifacts.length, 4);
    assert.equal(operational?.file, "operational-infrastructure-v2.json");
    assert.equal(operational?.infraReleaseId, "infra-deutschland-2026.3");
    assert.notEqual(operational?.sha256, operational?.stateHash);
    assert.equal(inventory.artifacts.some(({ kind }) => kind === "train-map-projection"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("weist weltbezogene, doppelte und manuell gehashte Operational-v2-Artefakte fail-closed zurueck", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-infrastructure-negative-"));
  try {
    await writeFile(join(root, "operational-infrastructure-v2.json"), JSON.stringify({
      ...operationalInfrastructure(),
      worldId: "world-must-not-enter-infra-release",
    }));
    await assert.rejects(
      buildV2Inventory(v2Spec(), root),
      /weltbezogene Felder/,
    );

    await writeFile(join(root, "operational-infrastructure-v2.json"), canonicalOperationalBytes(operationalInfrastructure()));
    const dynamicProjection = v2Spec();
    dynamicProjection.artifacts.push({
      id: "world-train-projection",
      kind: "train-map-projection",
      sourceFile: "train-map-projection.sqlite",
      file: "train-map-projection.sqlite",
    });
    await assert.rejects(
      buildV2Inventory(dynamicProjection, root),
      /Zugprojektionen gehören nicht in den statischen InfraRelease/,
    );

    const duplicate = v2Spec();
    duplicate.artifacts.push({
      ...duplicate.artifacts[0],
      id: "operational-infrastructure-copy-2026.2",
    });
    await assert.rejects(
      buildV2Inventory(duplicate, root),
      /genau eine statische Operational-v2-Infrastruktur/,
    );

    const manualHash = v2Spec();
    manualHash.artifacts[0] = { ...manualHash.artifacts[0], stateHash: "0".repeat(64) };
    await assert.rejects(
      buildV2Inventory(manualHash, root),
      /manuell gesetzte Bindungsfelder/,
    );

    const wrongRelease = v2Spec();
    wrongRelease.artifacts[0].infraReleaseId = "infra-deutschland-foreign";
    await assert.rejects(
      buildV2Inventory(wrongRelease, root),
      /InfraRelease-ID-Bindung/,
    );

    await assert.rejects(
      buildReleaseArtifactInventory(v2Spec(), root, {
        validateOperationalInfrastructure: async (path, expectedReleaseId) => {
          const receipt = await validateOperationalInfrastructure(path, expectedReleaseId);
          const infrastructure = JSON.parse(await readFile(path, "utf8"));
          await writeFile(path, `${JSON.stringify(infrastructure, null, 2)}\n`);
          return receipt;
        },
      }),
      /änderte sich während der nativen Operational-v2-Validierung/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verwirft manipulierte Inventar-Receipts für Release-ID, Zustand, Quelle und kanonische Ausgabe", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-infrastructure-receipt-negative-"));
  try {
    const path = join(root, "operational-infrastructure-v2.json");
    await writeFile(path, canonicalOperationalBytes(operationalInfrastructure()));
    const cases = [
      [(receipt) => ({ ...receipt, infraReleaseId: "infra-deutschland-foreign" }), /Schema-, Release- und Modusbindung/u],
      [(receipt) => ({ ...receipt, stateHash: "0".repeat(64) }), /Kanonisierung .* auseinander/u],
      [(receipt) => ({ ...receipt, sourceSha256: "0".repeat(64) }), /inventarisierten Quellbytes/u],
      [(receipt) => ({ ...receipt, sha256: "0".repeat(64) }), /kanonischen Ausgabe-Bytes/u],
    ];
    for (const [mutate, expectedError] of cases) {
      await assert.rejects(
        buildReleaseArtifactInventory(v2Spec(), root, {
          validateOperationalInfrastructure: async (candidatePath, expectedReleaseId) =>
            mutate(await validateOperationalInfrastructure(candidatePath, expectedReleaseId)),
        }),
        expectedError,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
