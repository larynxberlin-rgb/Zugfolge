import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildReleaseArtifactInventory, readReleaseArtifactSpec } from "./release-artifacts.mjs";
import { operationalInfrastructureV2StateHash } from "../operational-infrastructure-binding.mjs";
import { materializeOperationalInfrastructureV2 } from "../materialize-operational-infrastructure-v2.mjs";

function operationalInfrastructure() {
  return {
    id: "infra-deutschland-2026.2",
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
          requiredProtectionSystems: ["pzb"],
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
        overlapResources: [],
        flankResources: [],
        switchPositions: {},
        authorityEndRouteMm: 1_000,
        releaseAfterTailRouteMm: 1_000,
      },
    },
    signals: ["signal-1"],
    switches: [],
    blockResources: ["block-1"],
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
  const infrastructure = JSON.parse(await readFile(path, "utf8"));
  assert.equal(infrastructure.id, expectedReleaseId);
  return { stateHash: operationalInfrastructureV2StateHash(infrastructure) };
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

test("inventarisiert statische Operational-v2-Infrastruktur mit getrenntem Byte- und Zustandshash", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-infrastructure-"));
  try {
    await writeFile(join(root, "operational-infrastructure-v2.json"), `${JSON.stringify(operationalInfrastructure(), null, 2)}\n`);
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

test("Jahresspezifikation wird erst nach Materialisierung und nativer Candidate-Validierung grün", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-infrastructure-annual-"));
  try {
    const spec = await readReleaseArtifactSpec(new URL("./release-artifacts.annual-2026.2.json", import.meta.url));
    const derivedRoot = join(root, "var", "derived", "germany-2026.2");
    const mapReleaseRoot = join(derivedRoot, "map-release");
    await mkdir(join(mapReleaseRoot, "public"), { recursive: true });
    await Promise.all([
      writeFile(join(mapReleaseRoot, "infra-deutschland-2026.2.pmtiles"), "pmtiles"),
      writeFile(join(mapReleaseRoot, "public", "read-model.sqlite"), "SQLite read model"),
      writeFile(join(mapReleaseRoot, "public", "quality.json"), "{}\n"),
    ]);
    await assert.rejects(
      buildV2Inventory(spec, root),
      /operational-infrastructure-v2\.json/u,
    );

    const candidatePath = join(root, "candidate.json");
    await writeFile(candidatePath, JSON.stringify(operationalInfrastructure()));
    await materializeOperationalInfrastructureV2({
      candidatePath,
      expectedReleaseId: "infra-deutschland-2026.2",
      outputPath: join(derivedRoot, "operational-infrastructure-v2.json"),
    });
    const inventory = await buildV2Inventory(spec, root);
    const operational = inventory.artifacts.find(({ kind }) => kind === "operational-infrastructure-v2");
    assert.equal(inventory.artifacts.length, 4);
    assert.equal(operational?.file, "operational-infrastructure-v2.json");
    assert.equal(operational?.infraReleaseId, "infra-deutschland-2026.2");
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

    await writeFile(join(root, "operational-infrastructure-v2.json"), JSON.stringify(operationalInfrastructure()));
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
        validateOperationalInfrastructure: async (path) => {
          const infrastructure = JSON.parse(await readFile(path, "utf8"));
          await writeFile(path, `${JSON.stringify(infrastructure, null, 2)}\n`);
          return { stateHash: operationalInfrastructureV2StateHash(infrastructure) };
        },
      }),
      /änderte sich während der nativen Operational-v2-Validierung/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
