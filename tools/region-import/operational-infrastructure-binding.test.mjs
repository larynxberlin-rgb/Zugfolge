import assert from "node:assert/strict";
import test from "node:test";

import {
  assertOperationalInfrastructureV2ReleaseBinding,
  operationalInfrastructureV2Binding,
  operationalInfrastructureV2StateHash,
  OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA,
} from "./operational-infrastructure-binding.mjs";

const WORLD_ID = "00000000-0000-4000-8000-000000000014";
const REGION_ID = "mitteldeutschland-b";
const RELEASE_ID = "infra-mitteldeutschland-b-2026.2";

function infrastructure() {
  return {
    id: RELEASE_ID,
    directedEdges: { "edge-2": 2_000, "edge-1": 1_000 },
    edgeGeometries: {
      "edge-2": [{ edgeOffsetMm: 0 }, { edgeOffsetMm: 2_000 }],
      "edge-1": [{ edgeOffsetMm: 0 }, { edgeOffsetMm: 1_000 }],
    },
    routeVersions: { "route-1": { id: "route-1", templateId: "template-1" } },
    interlockingRoutes: {
      "template-1": {
        routeTemplateId: "template-1",
        pathResources: ["block-1"],
        overlapResources: ["overlap-1"],
        flankResources: ["flank-1"],
      },
    },
    signals: ["signal-1"],
    switches: [],
    blockResources: ["block-1", "overlap-1", "flank-1"],
    platformIntervals: {},
    regionBoundaries: [],
    rzueLayoutId: "rzue-1",
  };
}

function fixture() {
  const staticInfrastructure = infrastructure();
  const infraReleaseManifest = {
    releaseId: RELEASE_ID,
    artifacts: [{
      bytes: 1_024,
      file: "operational-infrastructure-v2.json",
      id: "operational-infrastructure-fixture",
      infraReleaseId: RELEASE_ID,
      kind: OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA,
      sha256: "1".repeat(64),
      stateHash: operationalInfrastructureV2StateHash(staticInfrastructure),
    }],
  };
  return {
    initialization: {
      schemaVersion: "zugfolge-operational-simulation-initialize/v2",
      worldId: WORLD_ID,
      regionId: REGION_ID,
      nowMs: 0,
      protectionModeSelectionPolicy: "zugfolge-protection-mode-selection/conservative-v1",
      infraRelease: operationalInfrastructureV2Binding(infraReleaseManifest),
      vehicleTypes: [],
      vehicles: [],
      formations: [],
      trains: [],
    },
    infraReleaseManifest,
    expectedWorldId: WORLD_ID,
    expectedRegionId: REGION_ID,
  };
}

test("bindet ausschliesslich eine kompakte Referenz auf die statische Operational-v2-Infrastruktur", () => {
  const value = fixture();
  assert.doesNotThrow(() => assertOperationalInfrastructureV2ReleaseBinding(value));

  const changedDynamicInitialization = {
    ...value.initialization,
    trains: [{ id: "world-specific-train" }],
  };
  assert.equal(
    assertOperationalInfrastructureV2ReleaseBinding({ ...value, initialization: changedDynamicInitialization }),
    value.infraReleaseManifest.artifacts[0].stateHash,
  );
});

test("weist falsche Release-ID, Hashes und doppelte statische Bindungen fail-closed zurueck", () => {
  const value = fixture();
  assert.throws(
    () => assertOperationalInfrastructureV2ReleaseBinding({
      ...value,
      initialization: {
        ...value.initialization,
        infraRelease: { ...value.initialization.infraRelease, infraReleaseId: "infra-foreign" },
      },
    }),
    /InfraRelease-ID-Bindung/,
  );
  assert.throws(
    () => assertOperationalInfrastructureV2ReleaseBinding({
      ...value,
      infraReleaseManifest: {
        ...value.infraReleaseManifest,
        artifacts: [{ ...value.infraReleaseManifest.artifacts[0], stateHash: "0".repeat(64) }],
      },
    }),
    /bytegenau/,
  );
  for (const [field, replacement] of [
    ["bytes", 1_025],
    ["sha256", "2".repeat(64)],
    ["stateHash", "3".repeat(64)],
    ["file", "../operational-infrastructure-v2.json"],
  ]) {
    assert.throws(
      () => assertOperationalInfrastructureV2ReleaseBinding({
        ...value,
        initialization: {
          ...value.initialization,
          infraRelease: { ...value.initialization.infraRelease, [field]: replacement },
        },
      }),
      /bytegenau|unvollstaendig/,
    );
  }
  assert.throws(
    () => assertOperationalInfrastructureV2ReleaseBinding({
      ...value,
      infraReleaseManifest: {
        ...value.infraReleaseManifest,
        artifacts: [{ ...value.infraReleaseManifest.artifacts[0], infraReleaseId: "infra-foreign" }],
      },
    }),
    /InfraRelease-ID-Bindung/,
  );
  assert.throws(
    () => assertOperationalInfrastructureV2ReleaseBinding({
      ...value,
      infraReleaseManifest: {
        ...value.infraReleaseManifest,
        artifacts: [{ ...value.infraReleaseManifest.artifacts[0], id: "" }],
      },
    }),
    /keine getrennte kanonische Byte- und Zustandsbindung/,
  );
  assert.throws(
    () => assertOperationalInfrastructureV2ReleaseBinding({
      ...value,
      infraReleaseManifest: {
        ...value.infraReleaseManifest,
        artifacts: [{ ...value.infraReleaseManifest.artifacts[0], worldId: WORLD_ID }],
      },
    }),
    /weltbezogene Felder/,
  );
  assert.throws(
    () => assertOperationalInfrastructureV2ReleaseBinding({
      ...value,
      infraReleaseManifest: { ...value.infraReleaseManifest, worldId: WORLD_ID },
    }),
    /keine Weltbindung/,
  );
  assert.throws(
    () => assertOperationalInfrastructureV2ReleaseBinding({
      ...value,
      infraReleaseManifest: {
        ...value.infraReleaseManifest,
        artifacts: [
          value.infraReleaseManifest.artifacts[0],
          value.infraReleaseManifest.artifacts[0],
        ],
      },
    }),
    /genau eine operative v2-Infrastruktur/,
  );
});

test("weist eine fremde Welt- oder Regionsbindung unabhaengig vom statischen Hash zurueck", () => {
  const value = fixture();
  for (const initialization of [
    { ...value.initialization, worldId: "00000000-0000-4000-8000-000000000999" },
    { ...value.initialization, regionId: "foreign-region" },
  ]) {
    assert.throws(
      () => assertOperationalInfrastructureV2ReleaseBinding({ ...value, initialization }),
      /Welt- oder Regionsbindung/,
    );
  }
});
