import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { loadLivemapReadModel, parseLivemapReadModelCatalog } from "./livemap-read-model.js";

const WORLD_ID = "11111111-1111-1111-1111-111111111111";

function catalog(styleUrl = "/tiles/base/style.json", objectRelease = "infra-de-2026") {
  return {
    schemaVersion: "zugfolge-livemap-read-model-catalog/v1",
    worlds: [{
      config: {
        schemaVersion: "zugfolge-livemap-config/v1",
        worldId: WORLD_ID,
        infrastructureReleaseId: "infra-de-2026",
        basemap: { styleUrl, attribution: "OpenStreetMap contributors", selfHosted: true },
        infrastructure: { pmtilesUrl: "/tiles/infra/de.pmtiles", attribution: "Zugfolge", coverage: "DE" },
        initialView: { latitudeE7: 510_000_000, longitudeE7: 105_000_000, zoomMilli: 6_000 },
      },
      objects: [{
        schemaVersion: "zugfolge-livemap-object-detail/v1",
        worldId: WORLD_ID,
        infrastructureReleaseId: objectRelease,
        kind: "track",
        id: "track-1",
        name: "Gleis 1",
        qualityClass: "A",
        facts: [],
      }],
      stationBoards: [{
        schemaVersion: "zugfolge-station-board/v1",
        worldId: WORLD_ID,
        stationId: "station-1",
        stationName: "Halle (Saale) Hbf",
        streamId: "catalog",
        sequence: 0,
        atS: 0,
        departures: [],
        arrivals: [],
      }],
      passengerInformation: [{ trainId: "train-1", followingStops: [], messages: [] }],
      ownerTrainDetails: [],
    }],
  };
}

describe("geheftetes Livemap-Read-Model", () => {
  it("bindet Tafeln an die angefragte Weltzeit und liefert Releaseobjekte deterministisch", async () => {
    const model = parseLivemapReadModelCatalog(catalog());
    await expect(model.getStationBoard(WORLD_ID, "station-1", { streamId: "stream-a", sequence: 7, atS: 42 })).resolves.toMatchObject({
      worldId: WORLD_ID,
      stationId: "station-1",
      streamId: "stream-a",
      sequence: 7,
      atS: 42,
    });
    await expect(model.getObjectDetail(WORLD_ID, "track", "track-1")).resolves.toMatchObject({
      infrastructureReleaseId: "infra-de-2026",
      id: "track-1",
    });
  });

  it("weist fremd gehostete Kartenartefakte und Release-Mischungen fail-closed zurueck", () => {
    expect(() => parseLivemapReadModelCatalog(catalog("https://tile.openstreetmap.org/style.json"))).toThrow(/Same-Origin/);
    expect(() => parseLivemapReadModelCatalog(catalog("/tiles/base/style.json", "infra-alt"))).toThrow(/Releasebindung/);
  });

  it("liest den grossen Katalog lazy und read-only aus SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zugfolge-sqlite-read-model-"));
    const path = join(directory, "read-model.sqlite");
    const database = new DatabaseSync(path);
    database.exec(`
      PRAGMA application_id = 0x5a554746;
      PRAGMA user_version = 2;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE world_config (world_id TEXT PRIMARY KEY, infrastructure_release_id TEXT NOT NULL, config_json TEXT NOT NULL);
      CREATE TABLE object_details (world_id TEXT NOT NULL, infrastructure_release_id TEXT NOT NULL, kind TEXT NOT NULL, object_id TEXT NOT NULL, name TEXT NOT NULL, quality_class TEXT NOT NULL, facts_json TEXT NOT NULL, PRIMARY KEY(world_id, kind, object_id));
      CREATE TABLE station_identifiers (world_id TEXT NOT NULL, station_id TEXT NOT NULL, scheme TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(world_id, scheme, value, station_id));
      CREATE TABLE station_schedule_calls (world_id TEXT NOT NULL, station_id TEXT NOT NULL, call_type TEXT NOT NULL, train_id TEXT NOT NULL, scheduled_time_s INTEGER NOT NULL, train_number TEXT NOT NULL, category TEXT NOT NULL, platform TEXT, origin TEXT, destination TEXT, PRIMARY KEY(world_id, station_id, call_type, train_id, scheduled_time_s));
      CREATE TABLE passenger_information (world_id TEXT NOT NULL, train_id TEXT NOT NULL, destination TEXT, following_stops_json TEXT NOT NULL, messages_json TEXT NOT NULL, PRIMARY KEY(world_id, train_id));
    `);
    const fixture = catalog().worlds[0]!;
    database.prepare("INSERT INTO world_config VALUES (?, ?, ?)").run(WORLD_ID, "infra-de-2026", JSON.stringify(fixture.config));
    database.prepare("INSERT INTO object_details VALUES (?, ?, ?, ?, ?, ?, ?)").run(WORLD_ID, "infra-de-2026", "station", "station-1", "Halle (Saale) Hbf", "B", "[]");
    database.prepare("INSERT INTO object_details VALUES (?, ?, ?, ?, ?, ?, ?)").run(WORLD_ID, "infra-de-2026", "track", "track-1", "Streckengleis 1", "B", '[{"label":"Laenge","value":"250","unit":"m"}]');
    database.prepare("INSERT INTO station_schedule_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(WORLD_ID, "station-1", "departure", "train-1", 120, "RE 1", "Regional-Express", "8", "Leipzig Hbf", "Erfurt Hbf");
    database.prepare("INSERT INTO passenger_information VALUES (?, ?, ?, ?, ?)").run(WORLD_ID, "train-1", "Erfurt Hbf", '["Merseburg Hbf","Erfurt Hbf"]', "[]");
    database.close();

    const model = await loadLivemapReadModel(path);
    try {
      await expect(model.getObjectDetail(WORLD_ID, "track", "track-1")).resolves.toMatchObject({ id: "track-1", infrastructureReleaseId: "infra-de-2026" });
      await expect(model.getStationBoard(WORLD_ID, "station-1", { streamId: "live", sequence: 5, atS: 100 })).resolves.toMatchObject({
        streamId: "live",
        departures: [{ trainId: "train-1", scheduledTimeS: 120, expectedTimeS: 120 }],
      });
      await expect(model.getPassengerInformation(WORLD_ID, "train-1")).resolves.toMatchObject({ destination: "Erfurt Hbf" });
      await expect(model.getOwnerTrainDetail(WORLD_ID, "operator", "train-1", { streamId: "live", sequence: 5, atS: 100 })).resolves.toBeUndefined();
    } finally {
      model.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
