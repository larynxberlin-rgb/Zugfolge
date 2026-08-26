import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
