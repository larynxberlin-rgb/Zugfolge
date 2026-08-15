import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PublicTrain } from "@zugfolge/livemap-stream";
import { afterEach, describe, expect, it } from "vitest";

import { SQLiteTrainMapProjector, assertTrainMapProjectionBinding } from "./livemap-train-map-projection.js";

const WORLD = "00000000-0000-4000-8000-000000000014";
const RELEASE = "infra-deutschland-test";
const DEPLOYMENT_HASH = "d".repeat(64);
const paths: string[] = [];

const train: PublicTrain = {
  id: "train-1",
  operator: "public",
  trainNumber: "RE 1",
  category: "regional",
  positionMm: 250_000,
  speedMmPerSecond: 10_000,
  delaySeconds: 0,
  nextOperatingPoint: "BB",
  status: "running",
};

const disruption = {
  schemaVersion: "zugfolge-livemap-disruption/v1",
  disruptionId: "closure-1",
  causeCode: 26,
  causeLabel: "Infrastruktur",
  fineCauseId: "track.failure",
  fineCauseLabel: "Gleisstoerung",
  effect: "closure",
  affectedResource: "resource-1",
  validUntilS: 500,
  kind: "unplanned",
  positionMm: 0,
  publishedAtS: 1,
  startsAtS: 1,
} as const;

function fixture({
  reverse = false,
  applicationId = 0x5a54504a,
  exact = true,
  method = "route-corridor",
  deploymentHash = DEPLOYMENT_HASH,
} = {}): string {
  const path = join(mkdtempSync(join(tmpdir(), "zugfolge-map-projector-")), "projection.sqlite");
  paths.push(path);
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA application_id = ${applicationId};
    PRAGMA user_version = 2;
    CREATE TABLE display_path_geometries (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        display_path_id TEXT NOT NULL,
        length_mm INTEGER NOT NULL CHECK (length_mm >= 0),
        geometry_json TEXT NOT NULL,
        PRIMARY KEY (world_id, infrastructure_release_id, display_path_id)
      ) WITHOUT ROWID;
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE track_geometries (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        length_mm INTEGER NOT NULL CHECK (length_mm > 0),
        geometry_json TEXT NOT NULL,
        PRIMARY KEY (world_id, infrastructure_release_id, track_id)
      ) WITHOUT ROWID;
    CREATE TABLE resource_track_spans (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_start_mm INTEGER NOT NULL CHECK (resource_start_mm >= 0),
        resource_end_mm INTEGER NOT NULL CHECK (resource_end_mm > resource_start_mm),
        track_id TEXT NOT NULL,
        track_start_offset_mm INTEGER NOT NULL CHECK (track_start_offset_mm >= 0),
        track_end_offset_mm INTEGER NOT NULL CHECK (track_end_offset_mm >= 0),
        is_resource_end INTEGER NOT NULL CHECK (is_resource_end IN (0, 1)),
        PRIMARY KEY (world_id, infrastructure_release_id, resource_id, resource_start_mm, resource_end_mm, track_id),
        FOREIGN KEY (world_id, infrastructure_release_id, track_id)
          REFERENCES track_geometries (world_id, infrastructure_release_id, track_id)
      ) WITHOUT ROWID;
    CREATE INDEX resource_track_lookup ON resource_track_spans
        (world_id, infrastructure_release_id, resource_id, resource_start_mm, resource_end_mm);
    CREATE TABLE resource_display_spans (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_start_mm INTEGER NOT NULL CHECK (resource_start_mm >= 0),
        resource_end_mm INTEGER NOT NULL CHECK (resource_end_mm > resource_start_mm),
        method TEXT NOT NULL CHECK (method IN ('topological-track', 'route-corridor', 'anchor-hold')),
        display_path_id TEXT NOT NULL,
        display_start_offset_mm INTEGER NOT NULL CHECK (display_start_offset_mm >= 0),
        display_end_offset_mm INTEGER NOT NULL CHECK (display_end_offset_mm >= 0),
        uncertainty_start_mm INTEGER NOT NULL CHECK (uncertainty_start_mm >= 0),
        uncertainty_end_mm INTEGER NOT NULL CHECK (uncertainty_end_mm >= 0),
        is_resource_end INTEGER NOT NULL CHECK (is_resource_end IN (0, 1)),
        PRIMARY KEY (world_id, infrastructure_release_id, resource_id, resource_start_mm, resource_end_mm, method, display_path_id),
        FOREIGN KEY (world_id, infrastructure_release_id, display_path_id)
          REFERENCES display_path_geometries (world_id, infrastructure_release_id, display_path_id)
      ) WITHOUT ROWID;
    CREATE INDEX resource_display_lookup ON resource_display_spans
        (world_id, infrastructure_release_id, resource_id, resource_start_mm, resource_end_mm);
    CREATE TABLE train_resource_spans (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        train_id TEXT NOT NULL,
        position_start_mm INTEGER NOT NULL CHECK (position_start_mm >= 0),
        position_end_mm INTEGER NOT NULL CHECK (position_end_mm > position_start_mm),
        resource_id TEXT NOT NULL,
        is_train_end INTEGER NOT NULL CHECK (is_train_end IN (0, 1)),
        PRIMARY KEY (world_id, infrastructure_release_id, train_id, position_start_mm, resource_id)
      ) WITHOUT ROWID;
    CREATE INDEX train_position_lookup ON train_resource_spans
        (world_id, infrastructure_release_id, train_id, position_start_mm, position_end_mm);
  `);
  const metadata = database.prepare("INSERT INTO metadata VALUES (?, ?)");
  metadata.run("schema", "zugfolge-train-map-projection/v2");
  metadata.run("world_id", WORLD);
  metadata.run("infrastructure_release_id", RELEASE);
  metadata.run("deployment_sha256", deploymentHash);
  database.prepare("INSERT INTO track_geometries VALUES (?, ?, ?, ?, ?)").run(
    WORLD,
    RELEASE,
    "track-1",
    1_000_000,
    JSON.stringify([
      { offsetMm: 0, latitudeE7: 500_000_000, longitudeE7: 100_000_000, bearingMilliDegrees: 90_000 },
      { offsetMm: 1_000_000, latitudeE7: 500_000_000, longitudeE7: 100_010_000 },
    ]),
  );
  database.prepare("INSERT INTO display_path_geometries VALUES (?, ?, ?, ?, ?)").run(
    WORLD,
    RELEASE,
    "corridor-1",
    method === "anchor-hold" ? 0 : 1_000_000,
    JSON.stringify(method === "anchor-hold"
      ? [{ offsetMm: 0, latitudeE7: 500_000_000, longitudeE7: 100_000_000 }]
      : [
        { offsetMm: 0, latitudeE7: 500_000_000, longitudeE7: 100_000_000, bearingMilliDegrees: 90_000 },
        { offsetMm: 1_000_000, latitudeE7: 500_000_000, longitudeE7: 100_020_000 },
      ]),
  );
  if (exact) {
    database.prepare("INSERT INTO resource_track_spans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      WORLD, RELEASE, "resource-1", 0, 1_000_000, "track-1", reverse ? 1_000_000 : 0, reverse ? 0 : 1_000_000, 1,
    );
  }
  database.prepare("INSERT INTO resource_display_spans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    WORLD, RELEASE, "resource-1", 0, 1_000_000, method, "corridor-1", 0, method === "anchor-hold" ? 0 : 1_000_000, 40_000, method === "anchor-hold" ? 1_040_000 : 40_000, 1,
  );
  database.prepare("INSERT INTO train_resource_spans VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    WORLD, RELEASE, "train-1", 0, 1_000_000, "resource-1", 1,
  );
  database.close();
  return path;
}

afterEach(() => {
  paths.splice(0);
});

describe("releasegebundene Zugkartenprojektion", () => {
  it("interpoliert ausschliesslich ganzzahlig auf der nachgewiesenen Gleisgeometrie", () => {
    const projector = new SQLiteTrainMapProjector(fixture());
    expect(projector.binding).toEqual({
      worldId: WORLD,
      infrastructureReleaseId: RELEASE,
      deploymentHash: DEPLOYMENT_HASH,
    });
    expect(projector.project(WORLD, train)).toMatchObject({
      id: "train-1",
      positionMm: 250_000,
      mapPosition: {
        infrastructureReleaseId: RELEASE,
        resourceId: "resource-1",
        trackId: "track-1",
        offsetMm: 250_000,
        latitudeE7: 500_000_000,
        longitudeE7: 100_002_500,
        bearingMilliDegrees: 90_000,
      },
    });
    projector.close();
  });

  it("projiziert eine Tagesinstanz nur über ihre autoritativ gelieferte Basisfahrt", () => {
    const projector = new SQLiteTrainMapProjector(fixture());
    const repeated = projector.project(WORLD, {
      ...train,
      id: "train-1:day-2",
      baseTrainRunId: "train-1",
    });
    expect(repeated).toMatchObject({
      id: "train-1:day-2",
      baseTrainRunId: "train-1",
      mapPosition: { trackId: "track-1", offsetMm: 250_000 },
    });
    expect(projector.project(WORLD, { ...train, id: "train-1:day-2" }).mapPosition).toBeUndefined();
    expect(projector.project(WORLD, { ...train, id: "forged", baseTrainRunId: "unknown" }).mapPosition).toBeUndefined();
    expect(projector.project(WORLD, { ...train, id: "forged", baseTrainRunId: "train-1" }).mapPosition).toBeUndefined();
    expect(projector.project(WORLD, { ...train, id: "train-1:day-0", baseTrainRunId: "train-1" }).mapPosition).toBeUndefined();
    expect(projector.project(WORLD, { ...train, id: "train-1:day-2", baseTrainRunId: "train-1:day-1" }).mapPosition).toBeUndefined();
    projector.close();
  });

  it("ersetzt ueberlange Legacy-Nummern weltgebunden durch die reservierte fuenfstellige Nummer", () => {
    const projector = new SQLiteTrainMapProjector(fixture());
    const projected = projector.project(WORLD, {
      ...train,
      operator: "public",
      trainNumber: "S4-1667972",
    });
    expect(projected.trainNumber).toBe("S4-39000");
    expect(projector.project("other-world", {
      ...train,
      operator: "public",
      trainNumber: "S4-1667972",
    }).trainNumber).toBe("S4-1667972");
    projector.close();
  });

  it("kehrt Offset und Richtung bei einer Fahrt gegen die Gleisgeometrie um", () => {
    const projector = new SQLiteTrainMapProjector(fixture({ reverse: true }));
    expect(projector.project(WORLD, train).mapPosition).toMatchObject({
      offsetMm: 750_000,
      longitudeE7: 100_007_500,
      bearingMilliDegrees: 270_000,
    });
    projector.close();
  });

  it("liefert bei fehlender exakter Gleisspanne eine explizite Korridorschaetzung", () => {
    const projector = new SQLiteTrainMapProjector(fixture({ exact: false }));
    const projected = projector.project(WORLD, train);
    expect(projected.mapPosition).toBeUndefined();
    expect(projected.mapEstimate).toEqual({
      infrastructureReleaseId: RELEASE,
      resourceId: "resource-1",
      method: "route-corridor",
      displayPathId: "corridor-1",
      displayOffsetMm: 250_000,
      latitudeE7: 500_000_000,
      longitudeE7: 100_005_000,
      bearingMilliDegrees: 90_000,
      uncertaintyMm: 40_000,
    });
    projector.close();
  });

  it("haelt ohne eindeutige Achse einen releasegebundenen Anker mit wachsender Unsicherheit", () => {
    const projector = new SQLiteTrainMapProjector(fixture({ exact: false, method: "anchor-hold" }));
    expect(projector.project(WORLD, train).mapEstimate).toEqual({
      infrastructureReleaseId: RELEASE,
      resourceId: "resource-1",
      method: "anchor-hold",
      displayPathId: "corridor-1",
      displayOffsetMm: 0,
      latitudeE7: 500_000_000,
      longitudeE7: 100_000_000,
      uncertaintyMm: 290_000,
    });
    projector.close();
  });

  it("entfernt unbewiesene Eingabepositionen bei Welt- oder Positionsluecken", () => {
    const projector = new SQLiteTrainMapProjector(fixture());
    const forged = {
      ...train,
      mapPosition: {
        infrastructureReleaseId: "forged",
        resourceId: "forged",
        trackId: "forged",
        offsetMm: 0,
        latitudeE7: 0,
        longitudeE7: 0,
      },
      mapEstimate: {
        infrastructureReleaseId: "forged",
        resourceId: "forged",
        method: "anchor-hold",
        displayPathId: "forged",
        displayOffsetMm: 0,
        latitudeE7: 0,
        longitudeE7: 0,
        uncertaintyMm: 1,
      },
    } satisfies PublicTrain;
    expect(projector.project("other-world", forged).mapPosition).toBeUndefined();
    expect(projector.project(WORLD, { ...forged, id: "unknown" }).mapPosition).toBeUndefined();
    expect(projector.project(WORLD, { ...forged, id: "unknown" }).mapEstimate).toBeUndefined();
    projector.close();
  });

  it("weist eine Datei ohne den gepinnten SQLite-Headervertrag ab", () => {
    expect(() => new SQLiteTrainMapProjector(fixture({ applicationId: 1 }))).toThrow(/Headervertrag/);
  });

  it("weist einen fehlenden oder ungueltigen Deploymenthash geschlossen ab", () => {
    expect(() => new SQLiteTrainMapProjector(fixture({ deploymentHash: "ungueltig" })))
      .toThrow(/Deploymenthash/);
    const missingPath = fixture();
    const missing = new DatabaseSync(missingPath);
    missing.prepare("DELETE FROM metadata WHERE key = 'deployment_sha256'").run();
    missing.close();
    expect(() => new SQLiteTrainMapProjector(missingPath)).toThrow(/deployment_sha256/);
  });

  it("weist zusaetzliche Schemaobjekte und abweichendes Index-SQL ab", () => {
    const extraTablePath = fixture();
    const extraTable = new DatabaseSync(extraTablePath);
    extraTable.exec("CREATE TABLE unexpected_public_data (value TEXT)");
    extraTable.close();
    expect(() => new SQLiteTrainMapProjector(extraTablePath)).toThrow(/Schemaobjekt-Allowlist/);

    const changedIndexPath = fixture();
    const changedIndex = new DatabaseSync(changedIndexPath);
    changedIndex.exec(`
      DROP INDEX resource_track_lookup;
      CREATE INDEX resource_track_lookup ON resource_track_spans
        (world_id, infrastructure_release_id, resource_id, resource_end_mm, resource_start_mm);
    `);
    changedIndex.close();
    expect(() => new SQLiteTrainMapProjector(changedIndexPath)).toThrow(/Schema-SQL-Hash/);
  });

  it("weist verletzte Fremdschluessel geschlossen ab", () => {
    const path = fixture();
    const database = new DatabaseSync(path, { enableForeignKeyConstraints: false });
    database.exec("DELETE FROM track_geometries WHERE track_id = 'track-1'");
    database.close();
    expect(() => new SQLiteTrainMapProjector(path)).toThrow(/Fremdschluessel/);
  });

  it("bindet dieselbe Welt und InfraRelease zusaetzlich an das aktive signierte Deployment", () => {
    const projector = new SQLiteTrainMapProjector(fixture());
    expect(() => assertTrainMapProjectionBinding(projector, undefined, DEPLOYMENT_HASH)).toThrow(/Welt-, Release- oder Deploymentbindung/);
    expect(() => assertTrainMapProjectionBinding(projector, {
      schemaVersion: "zugfolge-livemap-config/v2",
      worldId: WORLD,
      worldName: "Mitteldeutschland",
      infrastructureReleaseId: "other-release",
      basemap: { styleUrl: "/style.json", attribution: "test", selfHosted: true },
      infrastructure: { pmtilesUrl: "/infra.pmtiles", attribution: "test", coverage: "DE" },
      initialView: { latitudeE7: 0, longitudeE7: 0, zoomMilli: 1_000 },
    }, DEPLOYMENT_HASH)).toThrow(/Welt-, Release- oder Deploymentbindung/);
    const matchingConfig = {
      schemaVersion: "zugfolge-livemap-config/v2" as const,
      worldId: WORLD,
      worldName: "Mitteldeutschland",
      infrastructureReleaseId: RELEASE,
      basemap: { styleUrl: "/style.json", attribution: "test", selfHosted: true },
      infrastructure: { pmtilesUrl: "/infra.pmtiles", attribution: "test", coverage: "DE" },
      initialView: { latitudeE7: 0, longitudeE7: 0, zoomMilli: 1_000 },
    };
    expect(() => assertTrainMapProjectionBinding(projector, matchingConfig, DEPLOYMENT_HASH)).not.toThrow();
    expect(() => assertTrainMapProjectionBinding(projector, matchingConfig, "e".repeat(64)))
      .toThrow(/Deploymentbindung/);
    projector.close();
  });

  it("leitet nur nachgewiesene Gleisfarben aus Ressourcenzustaenden ab", () => {
    const projector = new SQLiteTrainMapProjector(fixture());
    expect(projector.projectDisruption(WORLD, disruption)).toEqual([{
      id: "disruption:closure-1:track:track-1",
      objectKind: "track",
      objectId: "track-1",
      state: "closure",
      disruptionId: "closure-1",
      validUntilS: 500,
    }]);
    expect(projector.projectDisruption(WORLD, { ...disruption, disruptionId: "slow-1", effect: "speed-restriction" })).toEqual([
      expect.objectContaining({ objectId: "track-1", state: "restriction" }),
    ]);
    expect(projector.projectDisruption(WORLD, { ...disruption, effect: "traffic-hold" })).toEqual([]);
    expect(projector.projectDisruption(WORLD, { ...disruption, affectedResource: "unknown" })).toEqual([]);
    projector.close();
  });

  it("verwendet Darstellungspfade niemals fuer Stoerungsfarben", () => {
    const projector = new SQLiteTrainMapProjector(fixture({ exact: false }));
    expect(projector.projectDisruption(WORLD, disruption)).toEqual([]);
    projector.close();
  });

  it("zeigt Baustellenschraffur nur mit expliziter autoritativer Planung", () => {
    const projector = new SQLiteTrainMapProjector(fixture());
    expect(projector.projectDisruption(WORLD, {
      ...disruption,
      kind: "planned",
      authoritativeObjectState: "construction",
    })).toEqual([expect.objectContaining({ state: "construction" })]);
    expect(() => projector.projectDisruption(WORLD, {
      ...disruption,
      authoritativeObjectState: "construction",
    })).toThrow(/autoritativ geplante/);
    projector.close();
  });
});
