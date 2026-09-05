import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { analyzeGermanyTimetableRoutes, TIMETABLE_ROUTE_SELECTION_RULE, validatePinnedGtfsSnapshot } from "./germany/timetable-route-compiler.mjs";

const execute = promisify(execFile);

test("GTFS-Region uebernimmt Welt und Region ausschliesslich aus expliziter Buildkonfiguration", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-gtfs-region-"));
  try {
    const configurationPath = fileURLToPath(new URL("./specifications/alpha-world-germany-2026.3.identity.json", import.meta.url));
    const configuration = JSON.parse(await readFile(configurationPath, "utf8"));
    const source = join(root, "source");
    await mkdir(source);
    const files = {
      "stops.txt": [
        "stop_id,stop_name,stop_lat,stop_lon,parent_station",
        "stop-erfurt,Erfurt Hbf,50.9727,11.0385,",
        "stop-weimar,Weimar,50.9795,11.3235,",
      ].join("\n"),
      "routes.txt": [
        "route_id,agency_id,route_short_name,route_long_name,route_type",
        "route-fixture,12,RB1,Fixture Regionalbahn,2",
      ].join("\n"),
      "trips.txt": [
        "route_id,service_id,trip_id,trip_headsign,direction_id",
        "route-fixture,service-fixture,trip-fixture,Weimar,0",
      ].join("\n"),
      "stop_times.txt": [
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
        "trip-fixture,08:00:00,08:00:00,stop-erfurt,1",
        "trip-fixture,08:15:00,08:16:00,stop-weimar,2",
      ].join("\n"),
      "calendar.txt": [
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
        "service-fixture,1,1,1,1,1,1,1,20260101,20261231",
      ].join("\n"),
      "calendar_dates.txt": "service_id,date,exception_type\n",
    };
    await Promise.all(Object.entries(files).map(([name, value]) => writeFile(join(source, name), `${value}\n`, "utf8")));
    const outputPath = join(root, "gtfs-region.json");
    await execute(process.execPath, [
      fileURLToPath(new URL("./build-gtfs-region.mjs", import.meta.url)),
      configurationPath,
      source,
      "20260810",
      "d".repeat(64),
      outputPath,
    ]);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.snapshot.regionId, configuration.regionId);
    assert.equal(output.snapshot.regionVariant, configuration.regionVariant);
    assert.equal(output.snapshot.journeyChains.length, 1);
    assert.equal(output.snapshot.journeyChains[0].worldId, configuration.worldId);
    assert.equal(output.snapshot.journeyChains[0].schemaVersion, "zugfolge-gtfs-journey-chain/v2");
    assert.equal(output.snapshot.journeyChains[0].legs[0].kind, "playable");
    validateGeneratedSnapshot(output);

    const fullConfiguration = {
      ...configuration,
      schemaVersion: "zugfolge-alpha-world-build-configuration/v3",
      operationalInfrastructure: {
        file: "operational-infrastructure-v2.json",
        bytes: 1,
        sha256: "a".repeat(64),
        stateHash: "b".repeat(64),
      },
      timetableRoutes: { file: "timetable-routes-v2.jsonseq", bytes: 1, sha256: "c".repeat(64) },
      timetableTransferDemands: {
        file: "timetable-routes-v2.transfer-demands-v2.json",
        bytes: 1,
        sha256: "d".repeat(64),
        dailyPlanSha256: "e".repeat(64),
        transferSetSha256: "f".repeat(64),
      },
      movementRouteTemplates: {
        file: "operational-infrastructure-v2.movement-route-templates-v2.json",
        bytes: 1,
        sha256: "1".repeat(64),
        stateHash: "2".repeat(64),
        operationalStateHash: "b".repeat(64),
        timetableTransferSetSha256: "f".repeat(64),
      },
    };
    const fullConfigurationPath = join(root, "full-v3.json");
    const fullOutputPath = join(root, "full-v3-gtfs.json");
    await writeFile(fullConfigurationPath, `${JSON.stringify(fullConfiguration)}\n`, "utf8");
    await execute(process.execPath, [
      fileURLToPath(new URL("./build-gtfs-region.mjs", import.meta.url)),
      fullConfigurationPath,
      source,
      "20260810",
      "d".repeat(64),
      fullOutputPath,
    ]);
    assert.deepEqual(JSON.parse(await readFile(fullOutputPath, "utf8")), output);

    const legacyFullConfigurationPath = join(root, "legacy-full-v2.json");
    await writeFile(legacyFullConfigurationPath, `${JSON.stringify({ ...fullConfiguration, schemaVersion: "zugfolge-alpha-world-build-configuration/v2" })}\n`, "utf8");
    await assert.rejects(execute(process.execPath, [
      fileURLToPath(new URL("./build-gtfs-region.mjs", import.meta.url)),
      legacyFullConfigurationPath,
      source,
      "20260810",
      "d".repeat(64),
      join(root, "legacy-full-v2-gtfs.json"),
    ]), /V3-Artefaktsatz/u);

    const secondConfigurationPath = join(root, "second-world.json");
    const secondWorldId = "22222222-2222-4222-8222-222222222222";
    await writeFile(secondConfigurationPath, `${JSON.stringify({ ...configuration, worldId: secondWorldId })}\n`, "utf8");
    const secondOutputPath = join(root, "second-world-gtfs.json");
    await execute(process.execPath, [
      fileURLToPath(new URL("./build-gtfs-region.mjs", import.meta.url)),
      secondConfigurationPath,
      source,
      "20260810",
      "d".repeat(64),
      secondOutputPath,
    ]);
    const secondOutput = JSON.parse(await readFile(secondOutputPath, "utf8"));
    assert.equal(secondOutput.snapshot.journeyChains[0].worldId, secondWorldId);
    assert.equal(secondOutput.snapshot.journeyChains[0].journeyChainId, output.snapshot.journeyChains[0].journeyChainId);
    assert.deepEqual(
      secondOutput.snapshot.journeyChains[0].legs.map((leg) => leg.legId),
      output.snapshot.journeyChains[0].legs.map((leg) => leg.legId),
    );
    assert.notEqual(secondOutput.snapshotHash, output.snapshotHash, "Weltpayload bleibt Teil des signierten Snapshot-Hashes");

    const retiredConfigurationPath = join(root, "retired-world.json");
    await writeFile(retiredConfigurationPath, `${JSON.stringify({
      ...configuration,
      worldId: "00000000-0000-4000-8000-000000000014",
    })}\n`, "utf8");
    await assert.rejects(execute(process.execPath, [
      fileURLToPath(new URL("./build-gtfs-region.mjs", import.meta.url)),
      retiredConfigurationPath,
      source,
      "20260810",
      "d".repeat(64),
      join(root, "retired.json"),
    ]), /UUID-Welt- und Regionsbindung/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function validateGeneratedSnapshot(envelope) {
  const snapshot = envelope.snapshot;
  return validatePinnedGtfsSnapshot(envelope, {
    expectedSchema: snapshot.schema,
    expectedRegionId: snapshot.regionId,
    expectedRegionVariant: snapshot.regionVariant,
    expectedServiceDate: snapshot.serviceDate,
    expectedSourceId: snapshot.source.sourceId,
    expectedArchiveSha256: snapshot.source.archiveSha256,
    expectedSourceLicense: snapshot.source.sourceLicense,
    expectedSnapshotHash: envelope.snapshotHash,
  }, { minimumStopCount: 2, qualityClass: "B", expectedSnapshotSegmentCount: snapshot.segments.length, expectedEligibleSegmentCount: snapshot.segments.length });
}

test("Regionsbau kuerzt Referenzen, trennt Wiedereintritt und generiert frequencies ohne Aussenfahrten", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-game-timetable-"));
  try {
    const files = {
      "stops.txt": [
        "stop_id,stop_name,stop_lat,stop_lon,parent_station",
        "X,Frankfurt,50.11,8.68,", "A,Erfurt,50.9727,11.0385,", "B,Weimar,50.9795,11.3235,", "C,Jena,50.927,11.589,", "D,Gera,50.877,12.083,",
      ].join("\n"),
      "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nroute,12,RB1,Regionalbahn,2\n",
      "trips.txt": "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\nroute,daily,reference,Frankfurt,0,\nroute,daily,outside,Frankfurt,0,\n",
      "stop_times.txt": ["trip_id,arrival_time,departure_time,stop_id,stop_sequence", "reference,06:00:00,06:00:00,X,1", "reference,06:10:00,06:10:00,A,2", "reference,06:20:00,06:20:00,B,3", "reference,06:30:00,06:30:00,X,4", "reference,06:40:00,06:40:00,C,5", "reference,06:50:00,06:50:00,D,6", "reference,07:00:00,07:00:00,X,7", "outside,08:00:00,08:00:00,X,1", "outside,08:10:00,08:10:00,X,2"].join("\n"),
      "calendar_dates.txt": "service_id,date,exception_type\ndaily,20260810,1\n",
      "frequencies.txt": "trip_id,start_time,end_time,headway_secs,exact_times\nreference,06:00:00,08:00:00,1800,0\n",
    };
    for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content, "utf8");
    const output = join(root, "output.json");
    const args = [fileURLToPath(new URL("./build-gtfs-region.mjs", import.meta.url)), fileURLToPath(new URL("./specifications/alpha-world-germany-2026.3.identity.json", import.meta.url)), root, "20260810", "d".repeat(64), output];
    await execute(process.execPath, args);
    const generated = JSON.parse(await readFile(output, "utf8"));
    assert.equal(generated.snapshot.lines.length, 2);
    assert.equal(generated.snapshot.journeyChains.length, 8);
    assert.deepEqual(generated.snapshot.lines.map((line) => line.stopIds).sort(), [["A", "B"], ["C", "D"]]);
    assert.ok(generated.snapshot.segments.every((segment) => segment.entry === null && segment.exit === null && segment.planningWindows.length === 0));
    assert.deepEqual(new Set(generated.snapshot.segments.map((segment) => segment.headsign)), new Set(["Weimar", "Gera"]));
    assert.equal(generated.snapshot.metrics.externalLegCount, 0);
    assert.equal(generated.snapshot.metrics.parentStationCount, 4);
    assert.ok(generated.snapshot.stations.every((station) => station.stopId !== "X"));
    validateGeneratedSnapshot(generated);
    await execute(process.execPath, args);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), generated);

    // Alle Halte liegen innen, der belegte Laufweg verlässt zwischen B und C
    // das Gebiet. Auch dieser Referenzweg muss in zwei Binnenlinien zerfallen.
    await writeFile(join(root, "trips.txt"), "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\nroute,daily,reference,Gera,0,shape\n", "utf8");
    await writeFile(join(root, "stop_times.txt"), ["trip_id,arrival_time,departure_time,stop_id,stop_sequence,shape_dist_traveled", "reference,06:00:00,06:00:00,A,1,0", "reference,06:10:00,06:10:00,B,2,10", "reference,06:20:00,06:20:00,C,3,30", "reference,06:30:00,06:30:00,D,4,40"].join("\n"), "utf8");
    await writeFile(join(root, "shapes.txt"), ["shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled", "shape,50.9727,11.0385,1,0", "shape,50.9795,11.3235,2,10", "shape,50.11,8.68,3,20", "shape,50.927,11.589,4,30", "shape,50.877,12.083,5,40"].join("\n"), "utf8");
    await execute(process.execPath, args);
    const shaped = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(shaped.snapshot.lines.map((line) => line.stopIds).sort(), [["A", "B"], ["C", "D"]]);
    validateGeneratedSnapshot(shaped);

    // Ohne optionale Shapes übernimmt der reale Binnen-Trackgraph die Kürzung.
    await rm(join(root, "shapes.txt"));
    const track = (id, from, to, coordinates, tags = {}) => ({ type: "Feature", properties: { feature_id: id, feature_type: "track", source_id: "osm-pbf-deutschland", model_state: "observed_osm_fixture", from_osm_node_id: from, to_osm_node_id: to, length_mm: 20_000_000, orderable: true, quality_class: "B", osm_tags_json: JSON.stringify(tags) }, geometry: { type: "LineString", coordinates } });
    const tracks = [
      track("inside-ab", 1, 2, [[11.0385, 50.9727], [11.3235, 50.9795]]),
      track("outside-bc", 2, 3, [[11.3235, 50.9795], [8.68, 50.11], [11.589, 50.927]]),
      track("inside-cd", 3, 4, [[11.589, 50.927], [12.083, 50.877]]),
    ];
    await writeFile(join(root, "tracks.jsonseq"), `${tracks.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
    await writeFile(join(root, "corridors.jsonseq"), `${JSON.stringify({ type: "Feature", properties: { official_evidence_id: "fixture-corridor", route_number: 1 }, geometry: { type: "LineString", coordinates: [[11.0385, 50.9727], [12.083, 50.877]] } })}\n`, "utf8");
    await writeFile(join(root, "terminals.json"), JSON.stringify({ schemaVersion: "zugfolge-game-timetable-terminals/v1", sourceId: "fixture-operating-point-release", terminals: ["A", "B", "C", "D"].map((stopId) => ({ stopId, kind: "station", canTurn: true, evidenceId: `fixture-turnaround:${stopId}` })) }), "utf8");
    const networkBindingPath = join(root, "network-binding.json");
    await writeFile(networkBindingPath, JSON.stringify({ schemaVersion: "zugfolge-game-timetable-network-binding/v1", tracksPath: "tracks.jsonseq", corridorsPath: "corridors.jsonseq", terminalCatalogPath: "terminals.json", permittedProtectionModes: ["pzb"] }), "utf8");
    await execute(process.execPath, [...args, networkBindingPath]);
    const refined = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(refined.snapshot.lines.map((line) => line.stopIds).sort(), [["A", "B"], ["C", "D"]]);
    assert.equal(refined.snapshot.metrics.infrastructureDisconnectedPairCount, 1);
    assert.equal(refined.snapshot.timetableGeneration.requireEligibleTerminals, true);
    assert.match(refined.snapshot.timetableGeneration.networkReference.tracks.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(refined.snapshot.timetableGeneration.networkReference.terminalCatalog.sourceId, "fixture-operating-point-release");
    assert.ok(refined.snapshot.lines.every((line) => line.adjustment.terminalEvidenceIds.length === 2));
    assert.notEqual(refined.snapshotHash, shaped.snapshotHash);
    validateGeneratedSnapshot(refined);
    await execute(process.execPath, [...args, networkBindingPath]);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), refined);
    const finalBytes = await readFile(output);
    const finalSpec = {
      schema: "zugfolge-germany-timetable-route-compiler/v3",
      infraReleaseId: "fixture-infra",
      tracks: "tracks.jsonseq", corridors: "corridors.jsonseq", output: "routes.jsonseq", report: "report.json",
      gtfsSnapshot: { path: "output.json", expectedBytes: finalBytes.length, expectedFileSha256: createHash("sha256").update(finalBytes).digest("hex"), expectedSnapshotHash: refined.snapshotHash, expectedSchema: refined.snapshot.schema, expectedRegionId: refined.snapshot.regionId, expectedRegionVariant: refined.snapshot.regionVariant, expectedServiceDate: refined.snapshot.serviceDate, expectedSourceId: refined.snapshot.source.sourceId, expectedArchiveSha256: refined.snapshot.source.archiveSha256, expectedSourceLicense: refined.snapshot.source.sourceLicense },
      selection: { rule: TIMETABLE_ROUTE_SELECTION_RULE, qualityClass: "B", requireOrderable: true, minimumStopCount: 2, expectedSnapshotSegmentCount: refined.snapshot.segments.length, expectedEligibleSegmentCount: refined.snapshot.segments.length, permittedProtectionModes: ["pzb"] },
    };
    const finalRoutes = await analyzeGermanyTimetableRoutes(finalSpec, root);
    assert.equal(finalRoutes.report.status, "qualified");
    assert.equal(finalRoutes.routes.length, refined.snapshot.segments.length);
    assert.ok(finalRoutes.routes.every((route) => route.legs.every((leg) => leg.edgeId !== "outside-bc")));
    await writeFile(join(root, "tracks.jsonseq"), `${tracks.slice(0, 2).map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
    await assert.rejects(analyzeGermanyTimetableRoutes(finalSpec, root), /exakt den.*Binnen-Trackgraphen/u);
    await writeFile(join(root, "terminals.json"), JSON.stringify({ schemaVersion: "zugfolge-game-timetable-terminals/v1", sourceId: "fixture-operating-points", terminals: [{ stopId: "A", kind: "station", canTurn: true, evidenceId: "" }] }), "utf8");
    await assert.rejects(execute(process.execPath, [...args, networkBindingPath]), /unvollstaendigen.*Endpunktbeleg/u);
    await rm(join(root, "terminals.json"));
    await assert.rejects(execute(process.execPath, [...args, networkBindingPath]), /terminals\.json/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
