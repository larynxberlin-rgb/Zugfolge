import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { auditExactRailPositions } from "./exact-rail-position-audit.mjs";

function feature(geometry, properties, id) {
  return `\u001e${JSON.stringify({ type: "Feature", ...(id === undefined ? {} : { id }), geometry, properties })}\n`;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-exact-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gpkg = join(root, "input.gpkg");
  const database = new DatabaseSync(gpkg);
  database.exec(`
    CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT, geometry_type_name TEXT, srs_id INTEGER, z INTEGER, m INTEGER);
    CREATE TABLE "M1 Betriebsstellen" (id INTEGER PRIMARY KEY, geom BLOB, "Geographische Länge (EPSG 4326)" REAL, "Geographische Breite (EPSG 4326)" REAL);
    CREATE TABLE "M1 Tunnel" (id INTEGER PRIMARY KEY, geom BLOB);
    INSERT INTO gpkg_geometry_columns VALUES ('M1 Betriebsstellen', 'geom', 'POINT', 25832, 0, 0), ('M1 Tunnel', 'geom', 'MULTICURVE', 25832, 0, 0);
    INSERT INTO "M1 Betriebsstellen" VALUES (1, X'00', 13.0, 52.0), (2, X'00', 99.0, 99.0);
    INSERT INTO "M1 Tunnel" VALUES (1, X'00');
  `);
  database.close();
  const sequence = join(root, "germany-ebo.geojsonseq");
  await writeFile(sequence, [
    feature({ type: "Point", coordinates: [13, 52] }, { public_transport: "stop_position", train: "yes", local_ref: "1" }, "node/1"),
    feature({ type: "Point", coordinates: [14, 53] }, { public_transport: "stop_position", train: "yes" }, "node/2"),
    feature({ type: "Point", coordinates: [15, 54] }, { public_transport: "platform", local_ref: "2" }),
    feature({ type: "Point", coordinates: [13, 52] }, { railway: "signal" }, "node/3"),
    feature({ type: "LineString", coordinates: [[12, 51], [13, 52], [14, 53]] }, { railway: "rail", "railway:track_ref": "1" }, "way/10"),
    feature({ type: "LineString", coordinates: [[14, 53], [16, 55]] }, { railway: "rail", "railway:track_ref": "2" }, "way/11"),
  ].join(""));
  const openStation = join(root, "openstation-platform-points.geojsonseq");
  await writeFile(openStation, [
    feature({ type: "Point", coordinates: [13, 52] }, { feature_id: "platform:1", feature_type: "platform", plate_code: "1" }),
    feature({ type: "Point", coordinates: [99, 99] }, { feature_id: "platform:2", feature_type: "platform", plate_code: "2" }),
  ].join(""));
  return { gpkg, sequence, openStation };
}

test("auditiert ausschließlich exakte Stützpunkt- und Gleisreferenzbindungen", async (t) => {
  const { gpkg, sequence, openStation } = await fixture(t);
  const report = await auditExactRailPositions({ geoPackagePath: gpkg, geoJsonSequencePath: sequence, openStationPlatformSequencePath: openStation });
  assert.equal(report.schema, "zugfolge-exact-rail-position-audit/v1");
  assert.equal(report.geoJsonSequence.counts.declaredTrainStopPositions, 2);
  assert.equal(report.geoJsonSequence.counts.railwayRailFeatures, 2);
  assert.deepEqual(report.exactBindings["osm:declared-train-stop-position"], {
    total: 2,
    unmatched: 0,
    exactSingleTrackFeature: 1,
    ambiguousMultipleTrackFeatures: 1,
    matchesOnlyTracksWithStableTrackRef: 2,
    resolvedByOneStableTrackRef: 1,
    exactCoordinateAndReferenceAgreement: 1,
    strictlyBindableByCoordinateOrTrackRef: 1,
  });
  assert.equal(report.exactBindings["osm:other-platform-point"].unmatched, 1);
  assert.equal(report.exactBindings["gpkg:M1 Betriebsstellen"].exactSingleTrackFeature, 1);
  assert.equal(report.exactBindings["gpkg:M1 Betriebsstellen"].unmatched, 1);
  assert.deepEqual(report.exactBindings["openstation:platform-point"], {
    total: 2,
    unmatched: 1,
    exactSingleTrackFeature: 1,
    ambiguousMultipleTrackFeatures: 0,
    matchesOnlyTracksWithStableTrackRef: 1,
    resolvedByOneStableTrackRef: 1,
    exactCoordinateAndReferenceAgreement: 1,
    strictlyBindableByCoordinateOrTrackRef: 1,
  });
  assert.deepEqual(report.policy.forbidden, ["nearest-neighbor", "point-to-line projection", "distance tolerance", "name-only or unscoped platform-code join"]);
});
