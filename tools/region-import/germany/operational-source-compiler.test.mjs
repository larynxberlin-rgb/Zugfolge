import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditGermanyOperationalSourceCompiler,
  classifyClosedTrackContext,
  compileOperationalResourceFeature,
  compileOperationalTrackFeature,
  EDGE_GEOMETRY_DERIVATION_RULE,
  GERMANY_OPERATIONAL_SOURCE_REPORT_SCHEMA,
  PLATFORM_ANCHOR_DERIVATION_RULE,
  RESOURCE_BINDING_DERIVATION_RULE,
  TRAIN_PROTECTION_DERIVATION_RULE,
} from "./operational-source-compiler.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "run-operational-source-compiler.mjs");

function sequence(values) {
  return values.map((value) => `\x1e${JSON.stringify(value)}\n`).join("");
}

function track({
  id = "track:a",
  from = 1,
  to = 2,
  coordinates = [[10, 50], [10.0001, 50], [10.0002, 50]],
  lengthMm = 13_998,
  qualityClass = "B",
  orderable = true,
  tags = { railway: "rail", "railway:pzb": "yes", "railway:track_ref": "1" },
}) {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates },
    properties: {
      feature_id: id,
      feature_type: "track",
      from_osm_node_id: from,
      to_osm_node_id: to,
      length_mm: lengthMm,
      quality_class: qualityClass,
      orderable,
      source_id: "osm-pbf-deutschland",
      osm_tags_json: JSON.stringify(tags),
    },
  };
}

function pointFeature(id, type, coordinates, properties = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates },
    properties: {
      feature_id: id,
      feature_type: type,
      quality_class: "B",
      orderable: true,
      source_id: "osm-pbf-deutschland",
      ...properties,
    },
  };
}

test("uebernimmt jede reale Polylinienstuetzstelle mit derselben ganzzahligen Laengenregel", () => {
  const compiled = compileOperationalTrackFeature(track({}));

  assert.equal(compiled.excludedContext, null);
  assert.deepEqual(compiled.blockers, []);
  assert.deepEqual(compiled.edgeGeometryMm, {
    edgeId: "track:a",
    lengthMm: 13_998,
    points: [
      { edgeOffsetMm: 0, latitudeE7: 500_000_000, longitudeE7: 100_000_000, bearingMilliDegrees: 90_000 },
      { edgeOffsetMm: 6_999, latitudeE7: 500_000_000, longitudeE7: 100_001_000, bearingMilliDegrees: 90_000 },
      { edgeOffsetMm: 13_998, latitudeE7: 500_000_000, longitudeE7: 100_002_000, bearingMilliDegrees: null },
    ],
    qualityClass: "B",
    orderable: true,
    sourceId: "osm-pbf-deutschland",
    derivationRule: EDGE_GEOMETRY_DERIVATION_RULE,
  });
  assert.deepEqual(compiled.trainProtectionProfile, {
    trackId: "track:a",
    availableProtectionSystems: ["pzb"],
    simultaneouslyRequiredProtectionSystems: [],
    qualityClass: "B",
    orderable: true,
    sourceId: "osm-pbf-deutschland",
    derivationRule: TRAIN_PROTECTION_DERIVATION_RULE,
  });
});

test("blockiert Laengen-Neugewichtung, Geometriekollaps und mehrdeutige Zugsicherung", () => {
  const mismatch = compileOperationalTrackFeature(track({ lengthMm: 14_000 }));
  assert.equal(mismatch.edgeGeometryMm, null);
  assert.ok(mismatch.blockers.includes("edge-length-metric-mismatch"));

  const collapsed = compileOperationalTrackFeature(track({
    coordinates: [[10, 50], [10, 50], [10.0001, 50]],
    lengthMm: 6_999,
  }));
  assert.equal(collapsed.edgeGeometryMm, null);
  assert.ok(collapsed.blockers.includes("edge-geometry-offset-collapse"));

  const ambiguous = compileOperationalTrackFeature(track({ tags: { railway: "rail", "railway:etcs": "yes" } }));
  assert.equal(ambiguous.trainProtectionProfile, null);
  assert.ok(ambiguous.blockers.includes("ambiguous-train-protection-tag"));
});

test("sondert nur belegte geschlossene Kontext-Ways aus und laesst echte geschlossene Gleise blockiert", () => {
  const context = track({
    id: "track:building",
    from: 1,
    to: 1,
    coordinates: [[10, 50], [10.0001, 50], [10, 50]],
    qualityClass: "C",
    orderable: false,
    tags: { railway: "rail", building: "yes" },
  });
  assert.deepEqual(classifyClosedTrackContext(context), {
    trackId: "track:building",
    classification: "non-linear-rail-context",
    evidenceTags: ["building"],
    derivationRule: "closed-osm-way-with-building-or-man-made-tag/v1",
  });
  assert.equal(compileOperationalTrackFeature(context).blockers.length, 0);

  const realClosedTrack = track({
    id: "track:closed-spur",
    from: 2,
    to: 2,
    coordinates: [[10, 50], [10.0001, 50], [10, 50]],
    qualityClass: "C",
    orderable: false,
    tags: { railway: "rail", service: "spur", "railway:pzb": "yes" },
  });
  assert.equal(classifyClosedTrackContext(realClosedTrack), null);
  assert.ok(compileOperationalTrackFeature(realClosedTrack).blockers.includes("track-not-operationally-qualified"));
});

test("bindet Ressourcen nur an identische sortierte Zielmengen", () => {
  const feature = pointFeature("conflict_resource:switch-a", "conflict_resource", [10, 50], {
    resource_kind: "switch",
    switch_id: "switch:a",
    incident_track_ids_json: JSON.stringify(["track:a", "track:b"]),
  });
  const expectedHash = "89e53d5b14796351190c9df2e069a578334016fad9ac7f81db02f6705da07006";
  const compiled = compileOperationalResourceFeature(feature, { "switch:a": expectedHash });
  assert.deepEqual(compiled.binding, {
    resourceId: "conflict_resource:switch-a",
    resourceKind: "switch",
    targetId: "switch:a",
    exactTrackIds: ["track:a", "track:b"],
    qualityClass: "B",
    orderable: true,
    sourceId: "osm-pbf-deutschland",
    derivationRule: RESOURCE_BINDING_DERIVATION_RULE,
  });
  assert.deepEqual(compiled.blockers, []);

  const mismatched = compileOperationalResourceFeature(feature, { "switch:a": "0".repeat(64) });
  assert.deepEqual(mismatched.blockers, ["resource-target-track-set-mismatch"]);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tracks = [
    track({ id: "track:a", from: 1, to: 2, tags: { railway: "rail", "railway:pzb": "yes", "railway:track_ref": "1" } }),
    track({ id: "track:b", from: 1, to: 3, tags: { railway: "rail", "railway:pzb": "yes", "railway:track_ref": "2" } }),
    track({ id: "track:c", from: 1, to: 4, tags: { railway: "rail", "railway:pzb": "yes", "railway:track_ref": "3" } }),
  ];
  const switches = [pointFeature("switch:a", "switch", [10, 50], {
    osm_node_id: 1,
    incident_track_ids_json: JSON.stringify(["track:a", "track:b", "track:c"]),
    osm_tags_json: JSON.stringify({ railway: "switch" }),
  })];
  const signals = [pointFeature("signal:a", "signal", [10, 50], {
    osm_node_id: 1,
    incident_track_ids_json: JSON.stringify(["track:a"]),
    osm_tags_json: JSON.stringify({ railway: "signal", "railway:signal:direction": "forward" }),
  })];
  const blocks = [{
    type: "Feature",
    geometry: { type: "MultiLineString", coordinates: [[[10, 50], [10.0002, 50]]] },
    properties: {
      feature_id: "block:a",
      feature_type: "block",
      track_ids_json: JSON.stringify(["track:a"]),
      quality_class: "B",
      orderable: true,
      source_id: "osm-pbf-deutschland",
    },
  }];
  const conflicts = [
    {
      type: "Feature",
      geometry: { type: "MultiLineString", coordinates: [[[10, 50], [10.0002, 50]]] },
      properties: {
        feature_id: "conflict_resource:block-a",
        feature_type: "conflict_resource",
        resource_kind: "block",
        block_id: "block:a",
        track_ids_json: JSON.stringify(["track:a"]),
        quality_class: "B",
        orderable: true,
        source_id: "osm-pbf-deutschland",
      },
    },
    pointFeature("conflict_resource:switch-a", "conflict_resource", [10, 50], {
      resource_kind: "switch",
      switch_id: "switch:a",
      incident_track_ids_json: JSON.stringify(["track:a", "track:b", "track:c"]),
    }),
    {
      type: "Feature",
      geometry: { type: "MultiLineString", coordinates: [[[10, 50], [10.0002, 50]]] },
      properties: {
        feature_id: "conflict_resource:track-section-a",
        feature_type: "conflict_resource",
        resource_kind: "track_section",
        track_ids_json: JSON.stringify(["track:a"]),
        quality_class: "B",
        orderable: true,
        source_id: "osm-pbf-deutschland",
      },
    },
  ];
  const platforms = [pointFeature("platform:a", "platform", [10, 50])];
  const ebo = [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [10, 50] },
      properties: {
        public_transport: "stop_position",
        railway: "stop",
        train: "yes",
        "railway:track_ref": "1",
        "railway:ref": "AA",
      },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [10.0000001, 50] },
      properties: {
        public_transport: "stop_position",
        railway: "stop",
        train: "yes",
        "railway:track_ref": "1",
        "railway:ref": "AA",
      },
    },
  ];
  const openStation = [{
    schema: "zugfolge-openstation-station-evidence/v1",
    stationId: "station:aa",
    identity: { rl100Codes: ["AA"], evaNumbers: [] },
    quays: [{
      platformId: "platform:openstation:aa:1",
      plateCode: "1",
      names: ["1"],
      dimensionsMm: { length: 200_000 },
    }],
  }];
  const files = {
    tracks: "tracks.geojsonseq",
    switches: "switches.geojsonseq",
    signals: "signals.geojsonseq",
    blocks: "blocks.geojsonseq",
    conflictResources: "conflict-resources.geojsonseq",
    platforms: "platforms.geojsonseq",
  };
  await Promise.all([
    writeFile(join(root, files.tracks), sequence(tracks)),
    writeFile(join(root, files.switches), sequence(switches)),
    writeFile(join(root, files.signals), sequence(signals)),
    writeFile(join(root, files.blocks), sequence(blocks)),
    writeFile(join(root, files.conflictResources), sequence(conflicts)),
    writeFile(join(root, files.platforms), sequence(platforms)),
    writeFile(join(root, "germany-ebo.geojsonseq"), sequence(ebo)),
    writeFile(join(root, "openstation-stations.jsonseq"), sequence(openStation)),
  ]);
  return { root, files };
}

test("auditiert reale Layer streaming, akzeptiert nur exakte Anker und erzeugt kein Intervall durch Zentrierung", async (t) => {
  const { root, files } = await fixture(t);
  const first = await auditGermanyOperationalSourceCompiler({
    infraReleaseId: "infra-deutschland-2026.3",
    sourceRoot: root,
    layers: files,
    eboStopPositions: "germany-ebo.geojsonseq",
    openStationStations: "openstation-stations.jsonseq",
  });
  const second = await auditGermanyOperationalSourceCompiler({
    infraReleaseId: "infra-deutschland-2026.3",
    sourceRoot: root,
    layers: files,
    eboStopPositions: "germany-ebo.geojsonseq",
    openStationStations: "openstation-stations.jsonseq",
  });

  assert.deepEqual(second, first);
  assert.equal(first.schema, GERMANY_OPERATIONAL_SOURCE_REPORT_SCHEMA);
  assert.equal(first.status, "blocked");
  assert.equal(first.candidateProduced, false);
  assert.equal(first.fullGermanyArtifactPossible, false);
  assert.equal(first.metrics.exactEdgeGeometries, 3);
  assert.equal(first.metrics.canonicalTrainProtectionProfiles, 3);
  assert.equal(first.metrics.exactResourceBindings, 3);
  assert.equal(first.metrics.exactSignalBoundaryPlacements, 1);
  assert.equal(first.metrics.exactStationHeadSwitchRoles, 0);
  assert.equal(first.metrics.exactPlatformAnchors, 1);
  assert.equal(first.metrics.operationalPlatformIntervals, 0);
  assert.equal(first.policies.platformAnchor, PLATFORM_ANCHOR_DERIVATION_RULE);
  assert.equal(first.policies.nearestNeighborMatching, "forbidden");
  assert.equal(first.blockers["platform-length-without-exact-interval-boundaries"].count, 1);
  assert.equal(first.blockers["train-stop-without-exact-track-vertex"].count, 1);
  assert.ok(first.blockers["switch-without-explicit-point-normal-reverse-roles"]);
  assert.ok(first.blockers["interlocking-routes-overlap-and-flank-not-present-in-retained-layers"]);
});

test("weist absolute und ausbrechende Quellenpfade vor dem Lesen ab", async (t) => {
  const { root, files } = await fixture(t);
  await assert.rejects(
    auditGermanyOperationalSourceCompiler({
      infraReleaseId: "infra-deutschland-2026.3",
      sourceRoot: root,
      layers: { ...files, tracks: "../tracks.geojsonseq" },
    }),
    /innerhalb der Quellenwurzel/u,
  );
});

test("der CLI-Vertrag schreibt den echten Blockerbericht atomar und meldet Status 2", async (t) => {
  const { root, files } = await fixture(t);
  const specificationPath = join(root, "source-compiler.json");
  const reportPath = join(root, "source-compiler-report.json");
  await writeFile(specificationPath, `${JSON.stringify({
    schema: "zugfolge-germany-operational-source-compiler/v1",
    infraReleaseId: "infra-deutschland-2026.3",
    layers: files,
    eboStopPositions: "germany-ebo.geojsonseq",
    openStationStations: "openstation-stations.jsonseq",
  })}\n`);

  const result = spawnSync(process.execPath, [RUNNER, specificationPath, root, reportPath], { encoding: "utf8" });
  assert.equal(result.status, 2, `${result.stderr}\n${result.stdout}`);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.schema, GERMANY_OPERATIONAL_SOURCE_REPORT_SCHEMA);
  assert.equal(report.candidateProduced, false);
  assert.equal(report.metrics.exactPlatformAnchors, 1);
  assert.match(result.stdout, /"fullGermanyArtifactPossible":false/u);
});
