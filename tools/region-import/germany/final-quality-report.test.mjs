import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildFinalQualityReport, writeFinalQualityReport } from "./final-quality-report.mjs";
import {
  STATIC_MAP_QUALITY_LAYER_ORDER,
  buildStaticMapQuality,
} from "../../tiles/static-map-quality.mjs";

const layerContracts = [
  ["rail_corridors", "rail-corridor"],
  ["operating_points", "operating-point"],
  ["stations", "station"],
  ["tracks", "track"],
  ["platforms", "platform"],
  ["switches", "switch"],
  ["signals", "signal"],
  ["blocks", "block"],
  ["conflict_resources", "conflict_resource"],
  ["rail_context", "rail_context"],
];

function specification() {
  return {
    schema: "zugfolge-final-quality-inputs/v1",
    releaseId: "infra-deutschland-test.1",
    timetableYear: 2026,
    layers: layerContracts.map(([name, featureType]) => ({
      name,
      file: `${name}.geojsonseq`,
      featureType,
      classARequiredDimensions: name === "tracks" ? ["topology", "maximumSpeed", "gradient", "review"] : ["geometry", "review"],
    })),
  };
}

function feature(id, featureType, qualityClass, properties = {}, geometry = { type: "Point", coordinates: [10, 50] }) {
  return {
    type: "Feature",
    geometry,
    properties: {
      feature_id: id,
      feature_type: featureType,
      quality_class: qualityClass,
      model_state: `fixture_${featureType}`,
      orderable: qualityClass !== "C",
      source_id: "fixture",
      ...properties,
    },
  };
}

function track(id, nodes, properties) {
  return feature(id, "track", "B", {
    from_osm_node_id: nodes[0],
    to_osm_node_id: nodes[1],
    osm_way_id: nodes[0],
    osm_tags_json: properties.osm_tags_json ?? "{}",
    ...properties,
  }, { type: "LineString", coordinates: [[10, 50], [10.01, 50.01]] });
}

async function writeSequence(path, features) {
  await writeFile(path, features.map((entry) => `\x1e${JSON.stringify(entry)}\n`).join(""), "utf8");
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-final-quality-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstTrack = "track:1";
  const secondTrack = "track:2";
  await Promise.all([
    writeSequence(join(root, "rail_corridors.geojsonseq"), [feature("corridor:1", "rail-corridor", "B")]),
    writeSequence(join(root, "operating_points.geojsonseq"), [feature("operating:1", "operating-point", "B")]),
    writeSequence(join(root, "stations.geojsonseq"), [feature("station:1", "station", "B")]),
    writeSequence(join(root, "tracks.geojsonseq"), [
      track(firstTrack, [1, 2], {
        length_mm: 100_000,
        osm_tags_json: JSON.stringify({ electrified: "contact_line", tracks: "2" }),
        speed_forward_kmh: 80,
        speed_backward_kmh: 80,
        speed_forward_model: "observed_osm_common",
        speed_backward_model: "observed_osm_common",
        gradient_status: "derived_with_uncertainty",
        gradient_class_a_eligible: false,
        representative_gradient_permille: 5,
        minimum_gradient_permille: -15,
        maximum_gradient_permille: 25,
        uncertainty_permille: 20,
        analysis_baseline_mm: 400_000,
        official_electrification: "overhead-line",
        official_track_count: 2,
      }),
      track(secondTrack, [2, 3], {
        length_mm: 200_000,
        speed_forward_kmh: 20,
        speed_backward_kmh: 20,
        speed_forward_model: "conservative_default",
        speed_backward_model: "conservative_default",
        gradient_status: "unresolved",
        gradient_class_a_eligible: false,
        unresolved_reason: "insufficient_way_baseline",
      }),
    ]),
    writeSequence(join(root, "platforms.geojsonseq"), [feature("platform:1", "platform", "C")]),
    writeSequence(join(root, "switches.geojsonseq"), [feature("switch:1", "switch", "B")]),
    writeSequence(join(root, "signals.geojsonseq"), [feature("signal:1", "signal", "B", { incident_track_ids_json: JSON.stringify([firstTrack]) })]),
    writeSequence(join(root, "blocks.geojsonseq"), [
      feature("block:1", "block", "B", { model_state: "derived_conservative_signal_bounded_block", track_ids_json: JSON.stringify([firstTrack]) }, { type: "LineString", coordinates: [[10, 50], [10.01, 50.01]] }),
      feature("block:2", "block", "B", { model_state: "derived_conservative_connected_component", track_ids_json: JSON.stringify([secondTrack]) }, { type: "LineString", coordinates: [[10.01, 50.01], [10.02, 50.02]] }),
    ]),
    writeSequence(join(root, "conflict_resources.geojsonseq"), [
      feature("resource:block", "conflict_resource", "B", { resource_kind: "block", track_ids_json: JSON.stringify([firstTrack, secondTrack]) }, { type: "LineString", coordinates: [[10, 50], [10.02, 50.02]] }),
      feature("resource:section", "conflict_resource", "B", { resource_kind: "track_section", track_ids_json: JSON.stringify([firstTrack, secondTrack]) }, { type: "LineString", coordinates: [[10, 50], [10.02, 50.02]] }),
    ]),
    writeSequence(join(root, "rail_context.geojsonseq"), [feature("context:1", "rail_context", "B")]),
  ]);
  return root;
}

test("Kartenbericht trennt Annahmen und erhebt ausdruecklich kein Operational-Gate", async (t) => {
  const root = await fixture(t);
  const report = await buildFinalQualityReport({ specification: specification(), artifactRoot: root });
  const tracks = report.layers.find(({ name }) => name === "tracks");
  assert.deepEqual(report.layers.map(({ name }) => name), layerContracts.map(([name]) => name));
  assert.deepEqual(report.layers.find(({ name }) => name === "stations").qualityClassFeatureCount, { A: 0, B: 1, C: 0 });
  assert.deepEqual(tracks.qualityClassFeatureCount, { A: 0, B: 2, C: 0 });
  assert.deepEqual(tracks.declaredQualityClassFeatureCount, { A: 0, B: 2, C: 0 });
  assert.deepEqual(tracks.qualityClassLengthMm, { A: 0, B: 300_000, C: 0 });
  assert.deepEqual(report.trackDimensions.maximumSpeed.evidenceByState, {
    missing: { features: 1, lengthMm: 200_000 },
    osm_observed: { features: 1, lengthMm: 100_000 },
  });
  assert.deepEqual(report.trackDimensions.maximumSpeed.operationalHandlingByState, {
    conservative_assumption: { features: 1, lengthMm: 200_000 },
    direct_observed: { features: 1, lengthMm: 100_000 },
  });
  assert.equal(report.trackDimensions.gradient.evidenceByState.derived_model.features, 1);
  assert.equal(report.trackDimensions.signals.evidenceGapsByReason.no_assigned_signal.features, 1);
  assert.equal(report.trackDimensions.blocks.evidenceByState.derived_from_connected_topology.features, 1);
  assert.equal(report.trackDimensions.conflictResources.operationalHandlingByState.conservative_rule.features, 2);
  assert.equal(JSON.stringify(report).toLowerCase().includes("trassenfinder.de/apn"), false);
  assert.equal(JSON.stringify(report).toLowerCase().includes("stationplan"), false);
  assert.equal(report.policy.nonPublicSourceRawDataShipped, false);
  assert.equal(report.policy.ordinaryAssumptionsOperationalClassBEligible, false);
  assert.equal(report.purpose, "visible-map-quality-evidence");
  assert.equal(report.operationalReleaseGate, false);
  assert.equal(Object.hasOwn(report, "corpusSha256"), false);
  assert.ok(report.layers.every((layer) => !Object.hasOwn(layer, "file") && !Object.hasOwn(layer, "sha256") && !Object.hasOwn(layer, "sourceIdFeatureCount") && !Object.hasOwn(layer, "modelStateFeatureCount")));
});

test("der echte Kartenbericht laesst sich nur mit getrenntem Operational-Gate nach Static-Map-v2 projizieren", async (t) => {
  const root = await fixture(t);
  const report = await buildFinalQualityReport({ specification: specification(), artifactRoot: root });
  const staticMap = buildStaticMapQuality({
    spec: {
      schema: "zugfolge-static-map-quality-materialization/v2",
      releaseId: "karte-deutschland-test.1-v2",
      infrastructureCorpusId: report.releaseId,
      timetableYear: report.timetableYear,
      scopeId: report.scopeId,
      visibleLayerOrder: [...STATIC_MAP_QUALITY_LAYER_ORDER],
    },
    detailedReport: report,
    sourceProof: { bytes: 1234, sha256: "a".repeat(64) },
  });
  assert.equal(staticMap.schema, "zugfolge-static-map-quality/v2");
  assert.equal(staticMap.claims.operationalInfraRelease, false);
  assert.deepEqual(staticMap.summary.qualityClassFeatureCount, report.summary.qualityClassFeatureCount);

  await assert.rejects(
    async () => buildStaticMapQuality({
      spec: {
        schema: "zugfolge-static-map-quality-materialization/v2",
        releaseId: "karte-deutschland-test.1-v2",
        infrastructureCorpusId: report.releaseId,
        timetableYear: report.timetableYear,
        scopeId: report.scopeId,
        visibleLayerOrder: [...STATIC_MAP_QUALITY_LAYER_ORDER],
      },
      detailedReport: { ...report, operationalReleaseGate: true },
      sourceProof: { bytes: 1234, sha256: "a".repeat(64) },
    }),
    /darf kein Operational-Release-Gate beanspruchen/,
  );
});

test("Vmax-Minimum trennt Quellenkonflikt und uebereinstimmende Beobachtung", async (t) => {
  const root = await fixture(t);
  const path = join(root, "tracks.geojsonseq");
  const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line.replace(/^\x1e/u, "")));
  rows[0].properties.osm_tags_json = JSON.stringify({ maxspeed: "100", electrified: "contact_line", tracks: "2" });
  rows[0].properties.official_speed_kmh = 80;
  rows[0].properties.speed_forward_kmh = 80;
  rows[0].properties.speed_backward_kmh = 80;
  rows[0].properties.speed_forward_model = "conservative_min_osm_and_official";
  rows[0].properties.speed_backward_model = "conservative_min_osm_and_official";
  await writeSequence(path, rows);
  const conflict = await buildFinalQualityReport({ specification: specification(), artifactRoot: root });
  assert.deepEqual(conflict.trackDimensions.maximumSpeed.evidenceByState.conflicting_observations, { features: 1, lengthMm: 100_000 });
  assert.deepEqual(conflict.trackDimensions.maximumSpeed.operationalHandlingByState.conservative_rule, { features: 1, lengthMm: 100_000 });

  rows[0].properties.osm_tags_json = JSON.stringify({ maxspeed: "80", electrified: "contact_line", tracks: "2" });
  await writeSequence(path, rows);
  const corroborated = await buildFinalQualityReport({ specification: specification(), artifactRoot: root });
  assert.deepEqual(corroborated.trackDimensions.maximumSpeed.evidenceByState.corroborated_observations, { features: 1, lengthMm: 100_000 });
  assert.deepEqual(corroborated.trackDimensions.maximumSpeed.operationalHandlingByState.direct_observed, { features: 1, lengthMm: 100_000 });
});

test("eine als B deklarierte ungel\u00f6ste Trackdimension wird im Bericht wirksam C", async (t) => {
  const root = await fixture(t);
  const path = join(root, "tracks.geojsonseq");
  const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line.replace(/^\x1e/u, "")));
  rows[0].properties.to_osm_node_id = rows[0].properties.from_osm_node_id;
  rows[0].geometry.coordinates.push(rows[0].geometry.coordinates[0]);
  await writeSequence(path, rows);
  const report = await buildFinalQualityReport({ specification: specification(), artifactRoot: root });
  const tracks = report.layers.find(({ name }) => name === "tracks");
  assert.deepEqual(tracks.declaredQualityClassFeatureCount, { A: 0, B: 2, C: 0 });
  assert.deepEqual(tracks.qualityClassFeatureCount, { A: 0, B: 1, C: 1 });
  assert.equal(tracks.qualityClassificationCorrections["B-to-C:topology"].lengthMm, 100_000);
});

test("gleiche Inputs erzeugen byteidentische atomare Berichte", async (t) => {
  const root = await fixture(t);
  const specPath = join(root, "inputs.json");
  await writeFile(specPath, `${JSON.stringify(specification(), null, 2)}\n`, "utf8");
  const first = await writeFinalQualityReport({ specificationPath: specPath, artifactRoot: root, outputPath: join(root, "first.json") });
  const second = await writeFinalQualityReport({ specificationPath: specPath, artifactRoot: root, outputPath: join(root, "second.json") });
  assert.equal(await readFile(first.output, "utf8"), await readFile(second.output, "utf8"));
  assert.equal(first.sha256, second.sha256);
  assert.equal(Object.hasOwn(first.report, "inputSpecificationSha256"), false);
});

test("Klasse A ohne vollst\u00e4ndigen akzeptierten Pr\u00fcfbeleg stoppt fail-closed", async (t) => {
  const root = await fixture(t);
  await writeSequence(join(root, "rail_corridors.geojsonseq"), [feature("corridor:1", "rail-corridor", "A")]);
  await assert.rejects(() => buildFinalQualityReport({ specification: specification(), artifactRoot: root }), /keinen vollst\u00e4ndig akzeptierten Nachweis/);
});

test("Klasse C darf niemals bestellbar sein", async (t) => {
  const root = await fixture(t);
  await writeSequence(join(root, "platforms.geojsonseq"), [feature("platform:1", "platform", "C", { orderable: true })]);
  await assert.rejects(() => buildFinalQualityReport({ specification: specification(), artifactRoot: root }), /darf nicht bestellbar sein/);
});
