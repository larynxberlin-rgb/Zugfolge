import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { materializeOperationalInfrastructureV2 } from "./materialize-operational-infrastructure-v2.mjs";
import { operationalInfrastructureV2StateHash } from "./operational-infrastructure-binding.mjs";

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
      validateNative: async (path, releaseId) => {
        validated = path === candidatePath && releaseId === RELEASE_ID;
        return { stateHash: operationalInfrastructureV2StateHash(value) };
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

test("schreibt bei abweichendem nativen Zustandshash kein Artefakt", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-materialize-operational-v2-negative-"));
  try {
    const candidatePath = join(root, "candidate.json");
    const outputPath = join(root, "operational-infrastructure-v2.json");
    await writeFile(candidatePath, JSON.stringify(candidate()));
    await assert.rejects(
      materializeOperationalInfrastructureV2({
        candidatePath,
        expectedReleaseId: RELEASE_ID,
        outputPath,
        validateNative: async () => ({ stateHash: "0".repeat(64) }),
      }),
      /Kanonisierung laufen auseinander/,
    );
    await assert.rejects(access(outputPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
