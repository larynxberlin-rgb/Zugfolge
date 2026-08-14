import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildLivemapReadModel,
  inspectPublicReadModel,
  matchStopToStations,
  objectDetailFromFeature,
} from "./livemap-read-model.mjs";

const temporaryDirectories = [];
const WORLD_ID = "00000000-0000-4000-8000-000000000014";
const RELEASE_ID = "infra-deutschland-test";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "zugfolge-read-model-test-"));
  temporaryDirectories.push(path);
  return path;
}

function feature(featureId, featureType, properties = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [12.1, 51.2] },
    properties: {
      feature_id: featureId,
      feature_type: featureType,
      quality_class: "B",
      model_state: "observed_unique_evidence",
      orderable: true,
      ...properties,
    },
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeFixture(root) {
  const layers = join(root, "layers");
  const gtfs = join(root, "gtfs");
  await mkdir(layers);
  await mkdir(gtfs);
  const fixtures = {
    "rail-corridors.geojsonseq": feature("rail-corridor:1", "rail-corridor", { route_number: 100, route_name: "Teststrecke" }),
    "operating-points.geojsonseq": feature("operating-point:rl100:TT", "operating-point", { name: "Test Hbf", rl100: "TT", types_json: '[{"name":"Bahnhof"}]' }),
    "stations.geojsonseq": feature("station:test", "station", { name: "Test Hbf", rl100: "TT", uic: "8000001", eva_refs: "8000001" }),
    "tracks.geojsonseq": feature("track:1", "track", { length_mm: 12_000, official_route_number: 100, osm_tags_json: '{"name":"Testgleis","railway:pzb":"yes","source":"intern"}' }),
    "platforms.geojsonseq": feature("platform:1", "platform", { osm_tags_json: '{"local_ref":"1"}' }),
    "switches.geojsonseq": feature("switch:1", "switch", { incident_track_ids_json: '["track:1"]', osm_tags_json: '{"ref":"7"}' }),
    "signals.geojsonseq": feature("signal:1", "signal", { incident_track_ids_json: '["track:1"]', block_boundary: true, osm_tags_json: '{"ref":"A","railway:signal:direction":"forward"}' }),
    "blocks.geojsonseq": feature("block:1", "block", { length_mm: 10_000, track_count: 1, boundary_signal_count: 2 }),
    "conflict-resources.geojsonseq": feature("conflict_resource:1", "conflict_resource", { resource_kind: "block", track_ids_json: '["track:1"]' }),
    "rail-context.geojsonseq": feature("rail_context:1", "rail_context", { context_kind: "crossing", osm_tags_json: '{"railway":"crossing","ref":"12"}' }),
  };
  for (const [name, value] of Object.entries(fixtures)) await writeFile(join(layers, name), `${JSON.stringify(value)}\n`);

  await writeFile(join(gtfs, "agency.txt"), "agency_id,agency_name,agency_url,agency_timezone\n1,Testbahn,https://example.invalid,Europe/Berlin\n");
  await writeFile(join(gtfs, "calendar.txt"), "monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date,service_id\n0,0,1,0,0,0,0,20260812,20260812,weekday\n");
  await writeFile(join(gtfs, "calendar_dates.txt"), "service_id,exception_type,date\n");
  await writeFile(join(gtfs, "routes.txt"), "route_long_name,route_short_name,agency_id,route_type,route_id\nTest,RE 1,1,2,route-1\n");
  await writeFile(join(gtfs, "trips.txt"), "route_id,service_id,trip_id\nroute-1,weekday,trip-1\n");
  await writeFile(join(gtfs, "stops.txt"), [
    "stop_name,parent_station,stop_id,stop_lat,stop_lon,location_type,platform_code",
    "Test Hbf,,parent,51.2,12.1,1,",
    "Test Hbf,parent,stop-1,51.2,12.1,,1",
    "Ziel Hbf,,stop-2,51.3,12.2,,2",
    "",
  ].join("\n"));
  await writeFile(join(gtfs, "stop_times.txt"), [
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
    "trip-1,02:05:00,02:06:00,stop-1,0",
    "trip-1,02:35:00,02:36:00,stop-2,1",
    "",
  ].join("\n"));
  return { layers, gtfs };
}

function spec(inputs) {
  return {
    schema: "zugfolge-livemap-read-model-build-spec/v1",
    worldId: WORLD_ID,
    infrastructureReleaseId: RELEASE_ID,
    worldEpoch: "2026-08-12T00:00:00.000Z",
    serviceStartOffsetS: 0,
    repeatEveryS: 86_400,
    inputDirectory: inputs.layers,
    gtfs: {
      archive: inputs.gtfs,
      serviceDate: "20260812",
      timeZone: "Europe/Berlin",
      trainIdentity: { regionId: "mitteldeutschland-b", releaseId: "gtfs-test-{archiveSha16}" },
    },
    config: {
      schemaVersion: "zugfolge-livemap-config/v2",
      worldId: WORLD_ID,
      worldName: "Mitteldeutschland",
      infrastructureReleaseId: RELEASE_ID,
      basemap: { styleUrl: "/maps/style.json", attribution: "Test", selfHosted: true },
      infrastructure: { pmtilesUrl: "/maps/infra.pmtiles", attribution: "Test", coverage: "DE" },
      initialView: { latitudeE7: 512000000, longitudeE7: 121000000, zoomMilli: 6000 },
    },
  };
}

describe("oeffentlicher SQLite-Livemap-Katalog", () => {
  it("uebersetzt Fachattribute, ohne Roh-Tags oder Evidenzfelder auszugeben", () => {
    const detail = objectDetailFromFeature("tracks", feature("track:1", "track", {
      official_route_number: 100,
      official_evidence_id: "intern",
      source_id: "intern",
      minimum_gradient_permille: -8,
      maximum_gradient_permille: 11,
      representative_gradient_permille: 4,
      uncertainty_permille: 3,
      osm_tags_json: '{"name":"Teststrecke","railway:pzb":"yes","source":"privat"}',
    }), WORLD_ID, RELEASE_ID);
    expect(detail).toMatchObject({ kind: "track", id: "track:1", name: "Teststrecke", qualityClass: "B" });
    const serialized = JSON.stringify(detail);
    expect(serialized).toContain("Zugsicherung");
    expect(detail.facts).toEqual(expect.arrayContaining([
      { label: "Gradientenbereich", value: "-8 bis 11", unit: "‰" },
      { label: "Repraesentative Neigung", value: "4", unit: "‰" },
      { label: "Neigungsunsicherheit", value: "3", unit: "‰" },
    ]));
    expect(serialized).not.toContain("osm_tags_json");
    expect(serialized).not.toContain("official_evidence_id");
    expect(serialized).not.toContain("source_id");
    expect(serialized).not.toContain("privat");
  });

  it("ordnet nur einen eindeutigen Namen mit belastbarer Koordinate zu", () => {
    const station = { stationId: "station:test", normalizedName: "testhbf", latitudeE7: 512000000, longitudeE7: 121000000, eva: ["8000001"] };
    const indexes = { byEva: new Map([["8000001", [station]]]), grid: new Map([["5120:1210", [station]]]) };
    expect(matchStopToStations({ stopId: "8000001", name: "anders" }, [station], indexes)?.method).toBe("exact-identifier");
    expect(matchStopToStations({ stopId: "x", name: "Test Hbf", latitudeE7: 512000010, longitudeE7: 121000010 }, [station], indexes)?.station.stationId).toBe("station:test");
    expect(matchStopToStations({ stopId: "x", name: "Fremder Ort", latitudeE7: 512000010, longitudeE7: 121000010 }, [station], indexes)).toBeUndefined();
  });

  it("baut aus allen interaktiven Ebenen und dem realen GTFS-Vertrag ein reproduzierbares ReadModel", async () => {
    const root = await temporaryDirectory();
    const inputs = await writeFixture(root);
    const first = join(root, "first.sqlite");
    const second = join(root, "second.sqlite");
    const firstReport = await buildLivemapReadModel(spec(inputs), first);
    const secondReport = await buildLivemapReadModel(spec(inputs), second);
    expect(firstReport.objectKinds).toEqual({
      track: 2,
      "operating-point": 1,
      station: 1,
      platform: 1,
      switch: 1,
      signal: 1,
      block: 1,
      facility: 1,
      "rail-context": 1,
    });
    expect(firstReport.timetable).toMatchObject({ activeRailTripCount: 1, matchedStopCount: 2, passengerPlanCount: 1 });
    expect(firstReport.inspection).toMatchObject({ objectCount: 10, passengerPlanCount: 1 });
    expect(await inspectPublicReadModel(first)).toMatchObject({ worldId: WORLD_ID, infrastructureReleaseId: RELEASE_ID });
    const database = new DatabaseSync(first, { readOnly: true });
    try {
      expect(Object.fromEntries(database.prepare("SELECT key, value FROM metadata ORDER BY key").all().map((row) => [row.key, row.value]))).toMatchObject({
        world_epoch: "2026-08-12T00:00:00.000Z",
        time_zone: "Europe/Berlin",
        service_start_offset_s: "0",
        repeat_every_s: "86400",
      });
      expect(database.prepare("SELECT train_id, scheduled_time_s FROM station_schedule_calls WHERE call_type = 'departure'").get()).toEqual({
        train_id: expect.any(String),
        scheduled_time_s: 7_560,
      });
    } finally {
      database.close();
    }
    expect(sha256(await readFile(first))).toBe(sha256(await readFile(second)));
  });

  it("verweigert Zeitvertraege mit erneutem UTC-Offset oder abweichender Wiederholung", async () => {
    const root = await temporaryDirectory();
    const inputs = await writeFixture(root);
    for (const [index, patch] of [
      { serviceStartOffsetS: -7_200 },
      { repeatEveryS: 172_800 },
      { gtfs: { ...spec(inputs).gtfs, timeZone: "UTC" } },
    ].entries()) {
      await expect(buildLivemapReadModel({ ...spec(inputs), ...patch }, join(root, `invalid-${index}.sqlite`)))
        .rejects.toThrow(/Schedule-/);
    }
  });
});
