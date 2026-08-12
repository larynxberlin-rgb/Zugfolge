import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  TRAIN_MAP_PROJECTION_BUILD_SPEC_SCHEMA,
  TRAIN_MAP_PROJECTION_SCHEMA_SQL_SHA256,
  buildTrainMapProjection,
  inspectTrainMapProjection,
} from "./train-map-projection.mjs";

const WORLD_ID = "00000000-0000-4000-8000-000000000014";
const RELEASE_ID = "infra-deutschland-test";

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function writeSequence(path, features) {
  await writeFile(path, `${features.map((feature) => `\x1e${JSON.stringify(feature)}`).join("\n")}\n`);
}

function corridor() {
  return {
    type: "Feature",
    properties: {
      feature_id: "rail-corridor:official-1",
      official_evidence_id: "official-1",
      route_number: 1000,
      direction: "forward-track",
      from_km_mm: 0,
      to_km_mm: 1_000_000,
    },
    geometry: { type: "MultiLineString", coordinates: [[[10, 50], [10.014, 50]]] },
  };
}

function track(id, start, end) {
  return {
    type: "Feature",
    properties: {
      feature_id: id,
      length_mm: 500_000,
      orderable: true,
      quality_class: "B",
      official_evidence_id: "official-1",
      official_route_number: 1000,
      official_direction: "forward-track",
      official_from_km_mm: 0,
      official_to_km_mm: 1_000_000,
      official_track_count: 1,
    },
    geometry: { type: "LineString", coordinates: [[start, 50], [end, 50]] },
  };
}

function operationalNetwork() {
  return {
    network: {
      schema: "zugfolge-operational-network/v1",
      regionId: "test-region",
      timetableYear: 2026,
      stations: [
        { stationId: "AA", latitudeE7: 500_000_000, longitudeE7: 100_000_000 },
        { stationId: "BB", latitudeE7: 500_000_000, longitudeE7: 100_140_000 },
      ],
      resources: [{
        resourceId: "resource-1",
        routeNumber: 1000,
        originStationId: "AA",
        destinationStationId: "BB",
        fromMm: 0,
        toMm: 1_000_000,
        lengthMm: 1_000_000,
        qualityClass: "B",
        orderable: true,
      }],
      segmentQualifications: [{
        segmentId: "segment-1",
        journeyChainId: "train-1",
        qualityClass: "B",
        orderable: true,
        distanceMm: 1_000_000,
        resourceIds: ["resource-1"],
      }],
      journeyChainQualifications: [{
        journeyChainId: "train-1",
        qualityClass: "B",
        orderable: true,
        playableSegmentIds: ["segment-1"],
      }],
    },
  };
}

function deployment() {
  return {
    deployment: {
      schema: "zugfolge-alpha-world-deployment/v1",
      worldId: WORLD_ID,
      infraReleaseHash: "a".repeat(64),
      fleet: {
        authorityRelease: {
          pathReceipts: [{ id: "path-train-1", numericRouteId: 30_001, decision: "confirmed" }],
        },
        pathReservations: [{ id: "reservation-train-1", pathReceiptId: "path-train-1" }],
      },
      regionalSimulation: {
        worldId: WORLD_ID,
        trains: [{
          trainRunId: "train-1",
          route: [
            { operatingPoint: "AA", positionMm: 0 },
            { operatingPoint: "BB", positionMm: 1_000_000 },
          ],
        }],
      },
    },
  };
}

async function fixture({ ambiguous = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-train-map-projection-"));
  const paths = {
    tracks: join(root, "tracks.geojsonseq"),
    corridors: join(root, "corridors.geojsonseq"),
    operationalNetwork: join(root, "operational-network.json"),
    deployment: join(root, "deployment.json"),
  };
  await writeSequence(paths.corridors, [corridor()]);
  await writeSequence(paths.tracks, [
    track("track-a", 10, 10.007),
    ...(ambiguous ? [track("track-parallel", 10, 10.007)] : []),
    track("track-b", 10.007, 10.014),
  ]);
  await writeFile(paths.operationalNetwork, JSON.stringify(operationalNetwork()));
  await writeFile(paths.deployment, JSON.stringify(deployment()));
  return { root, paths };
}

function spec(input, suffix) {
  return {
    schema: TRAIN_MAP_PROJECTION_BUILD_SPEC_SCHEMA,
    worldId: WORLD_ID,
    infrastructureReleaseId: RELEASE_ID,
    timetableYear: 2026,
    ...input.paths,
    output: join(input.root, `projection-${suffix}.sqlite`),
    report: join(input.root, `report-${suffix}.json`),
  };
}

test("kompiliert eine releasegebundene Position ohne Fliesskomma-Laufzeitvertrag reproduzierbar", async () => {
  const input = await fixture();
  const first = spec(input, "first");
  const second = spec(input, "second");
  const firstReport = await buildTrainMapProjection(first);
  const secondReport = await buildTrainMapProjection(second);

  assert.equal(await sha256(first.output), await sha256(second.output));
  assert.deepEqual(firstReport.resources, {
    resourceCount: 1,
    fullyResolvedResourceCount: 1,
    partiallyResolvedResourceCount: 0,
    unresolvedResourceCount: 0,
    totalMm: 1_000_000,
    resolvedMm: 1_000_000,
    ambiguousMm: 0,
    missingMm: 0,
    resolvedBasisPoints: 10_000,
  });
  assert.equal(firstReport.trains.provenTrainCount, 1);
  const inspection = await inspectTrainMapProjection(first.output);
  assert.equal(inspection.schemaSqlSha256, TRAIN_MAP_PROJECTION_SCHEMA_SQL_SHA256);
  assert.deepEqual(inspection, {
    schema: "zugfolge-train-map-projection/v1",
    worldId: WORLD_ID,
    infrastructureReleaseId: RELEASE_ID,
    timetableYear: 2026,
    sqliteApplicationId: 0x5a54504a,
    sqliteUserVersion: 1,
    tables: {
      metadata: ["key", "value"],
      resource_track_spans: ["world_id", "infrastructure_release_id", "resource_id", "resource_start_mm", "resource_end_mm", "track_id", "track_start_offset_mm", "track_end_offset_mm", "is_resource_end"],
      track_geometries: ["world_id", "infrastructure_release_id", "track_id", "length_mm", "geometry_json"],
      train_resource_spans: ["world_id", "infrastructure_release_id", "train_id", "position_start_mm", "position_end_mm", "resource_id", "is_train_end"],
    },
    schemaSqlSha256: TRAIN_MAP_PROJECTION_SCHEMA_SQL_SHA256,
    foreignKeyCheck: "ok",
    trackCount: 2,
    resourceSpanCount: 2,
    trainSpanCount: 1,
    quickCheck: "ok",
    integrityCheck: "ok",
  });
});

test("laesst einen parallel mehrdeutigen Bereich ungeloest, statt ein Gleis zu raten", async () => {
  const input = await fixture({ ambiguous: true });
  const buildSpec = spec(input, "ambiguous");
  const report = await buildTrainMapProjection(buildSpec);

  assert.equal(report.policy.guessedTrackSelection, false);
  assert.equal(report.resources.ambiguousMm, 500_000);
  assert.equal(report.resources.resolvedMm, 500_000);
  assert.equal(report.resources.partiallyResolvedResourceCount, 1);
  assert.equal((await inspectTrainMapProjection(buildSpec.output)).trackCount, 1);
});

test("weist unerlaubte Schemaobjekte und abweichendes Schema-SQL geschlossen ab", async () => {
  const unexpectedTableInput = await fixture();
  const unexpectedTableSpec = spec(unexpectedTableInput, "unexpected-table");
  await buildTrainMapProjection(unexpectedTableSpec);
  const unexpectedTable = new DatabaseSync(unexpectedTableSpec.output);
  unexpectedTable.exec("CREATE TABLE unexpected_public_data (value TEXT)");
  unexpectedTable.close();
  await assert.rejects(
    inspectTrainMapProjection(unexpectedTableSpec.output),
    /Schemaobjekt-Allowlist/,
  );

  const changedIndexInput = await fixture();
  const changedIndexSpec = spec(changedIndexInput, "changed-index");
  await buildTrainMapProjection(changedIndexSpec);
  const changedIndex = new DatabaseSync(changedIndexSpec.output);
  changedIndex.exec(`
    DROP INDEX resource_track_lookup;
    CREATE INDEX resource_track_lookup ON resource_track_spans
      (world_id, infrastructure_release_id, resource_id, resource_end_mm, resource_start_mm);
  `);
  changedIndex.close();
  await assert.rejects(
    inspectTrainMapProjection(changedIndexSpec.output),
    /Schema-SQL-Hash/,
  );
});

test("weist verletzte Fremdschluessel auch bei formal intaktem SQLite geschlossen ab", async () => {
  const input = await fixture();
  const buildSpec = spec(input, "foreign-key");
  await buildTrainMapProjection(buildSpec);
  const database = new DatabaseSync(buildSpec.output, { enableForeignKeyConstraints: false });
  database.exec("DELETE FROM track_geometries WHERE track_id = 'track-a'");
  database.close();
  await assert.rejects(
    inspectTrainMapProjection(buildSpec.output),
    /Fremdschluessel/,
  );
});
