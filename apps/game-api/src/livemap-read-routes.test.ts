import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, schema, worlds } from "@zugfolge/db";
import { requestWorldAccess, type IdentityDatabase } from "@zugfolge/identity";
import {
  LIVEMAP_CONFIG_SCHEMA,
  LIVEMAP_OBJECT_DETAIL_SCHEMA,
  OWNER_TRAIN_DETAIL_SCHEMA,
  STATION_BOARD_SCHEMA,
  LivemapRegistry,
  type LivemapReadModel,
  type PublicExternalTrain,
} from "@zugfolge/livemap-stream";
import { foundOperator } from "@zugfolge/operators";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";

const WORLD_ID = "11111111-1111-1111-1111-111111111111";
const RELEASE_ID = "infra-de-2026";

describe("Livemap-Lesevertrag", () => {
  let client: PGlite;
  let db: IdentityDatabase;
  let app: FastifyInstance;
  let livemap: LivemapRegistry;
  let operatorId: string;

  beforeEach(async () => {
    client = new PGlite();
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
    db = database;
    await database.insert(worlds).values({
      id: WORLD_ID,
      name: "Deutschland",
      schedulePeriodWeeks: 4,
      epoch: new Date("2026-01-01T00:00:00Z"),
    });
    await requestWorldAccess(db, {
      worldId: WORLD_ID,
      keycloakSubject: "owner",
      displayName: "Eigentuemer",
    });
    await requestWorldAccess(db, {
      worldId: WORLD_ID,
      keycloakSubject: "foreign",
      displayName: "Fremdes EVU",
    });
    operatorId = (await foundOperator(db, {
      worldId: WORLD_ID,
      foundingKeycloakSubject: "owner",
      name: "Testbahn",
    })).id;

    livemap = new LivemapRegistry({ createStreamId: () => "stream-a" });
    const internalExternalTrain: PublicExternalTrain & {
      readonly fixedCostCents: string;
      readonly boundVehicleIds: readonly string[];
      readonly boundPersonnelDutyIds: readonly string[];
    } = {
      id: "train-external",
      operator: "Testbahn",
      trainNumber: "RE 2",
      category: "regional",
      journeyChainId: "chain-2",
      externalLegId: "leg-2",
      fromPortalId: "portal-west",
      toPortalId: "portal-east",
      scheduledEndS: 100,
      reentryEarliestS: 90,
      reentryLatestS: 110,
      delaySeconds: 0,
      status: "outside",
      progressBasisPoints: 5_000,
      fixedCostCents: "5000",
      boundVehicleIds: ["vehicle-secret"],
      boundPersonnelDutyIds: ["duty-secret"],
    };
    livemap.initializeWorld(WORLD_ID, {
      at: 42,
      trains: [{
        id: "train-1",
        operator: "Testbahn",
        trainNumber: "RE 1",
        category: "regional",
        positionMm: 1_000,
        speedMmPerSecond: 20_000,
        delaySeconds: 60,
        nextOperatingPoint: "Halle (Saale) Hbf",
        status: "running",
        mapPosition: {
          infrastructureReleaseId: RELEASE_ID,
          resourceId: "block-track-1",
          trackId: "track-1",
          offsetMm: 1_000,
          latitudeE7: 515_000_000,
          longitudeE7: 120_000_000,
          bearingMilliDegrees: 90_000,
        },
      }],
      externalTrains: [internalExternalTrain],
      objectStates: [{
        id: "track:track-1",
        objectKind: "track",
        objectId: "track-1",
        state: "construction",
        disruptionId: "work-1",
      }],
    });

    const readModel: LivemapReadModel = {
      async getConfig(worldId) {
        return worldId !== WORLD_ID ? undefined : {
          schemaVersion: LIVEMAP_CONFIG_SCHEMA,
          worldId,
          infrastructureReleaseId: RELEASE_ID,
          basemap: {
            styleUrl: "/tiles/base/style.json",
            attribution: "OpenStreetMap contributors",
            selfHosted: true,
          },
          infrastructure: {
            pmtilesUrl: "/tiles/infra/de-2026.pmtiles",
            attribution: "Zugfolge InfraRelease",
            coverage: "DE",
          },
          initialView: { latitudeE7: 510_000_000, longitudeE7: 105_000_000, zoomMilli: 6_000 },
        };
      },
      async getObjectDetail(worldId, kind, objectId) {
        return worldId === WORLD_ID && kind === "track" && objectId === "track-1" ? {
          schemaVersion: LIVEMAP_OBJECT_DETAIL_SCHEMA,
          worldId,
          infrastructureReleaseId: RELEASE_ID,
          kind,
          id: objectId,
          name: "Streckengleis 1",
          qualityClass: "A",
          facts: [{ label: "Elektrifizierung", value: "15 kV 16,7 Hz" }],
        } : undefined;
      },
      async getStationBoard(worldId, stationId, cursor) {
        return worldId === WORLD_ID && stationId === "station-halle" ? {
          schemaVersion: STATION_BOARD_SCHEMA,
          worldId,
          stationId,
          stationName: "Halle (Saale) Hbf",
          ...cursor,
          departures: [{
            trainId: "train-1",
            trainNumber: "RE 1",
            category: "regional",
            scheduledTimeS: 40,
            expectedTimeS: 100,
            destination: "Erfurt Hbf",
            platform: "8",
            status: "scheduled",
          }],
          arrivals: [],
        } : undefined;
      },
      async getPassengerInformation(worldId, trainId) {
        return worldId === WORLD_ID && trainId === "train-1" ? {
          trainId,
          destination: "Erfurt Hbf",
          followingStops: ["Merseburg Hbf", "Naumburg (Saale) Hbf", "Erfurt Hbf"],
          messages: ["Heute etwa 1 Minute spaeter."],
        } : undefined;
      },
      async getOwnerTrainDetail(worldId, requestedOperatorId, trainId, cursor) {
        return worldId === WORLD_ID && requestedOperatorId === operatorId && trainId === "train-1" ? {
          schemaVersion: OWNER_TRAIN_DETAIL_SCHEMA,
          worldId,
          operatorId: requestedOperatorId,
          trainId,
          ...cursor,
          formationLabel: "Doppeltraktion",
          vehicleIds: ["vehicle-secret"],
          personnelDutyIds: ["duty-secret"],
          pathResourceIds: ["track-1"],
          fixedCostCents: "5000",
        } : undefined;
      },
    };
    app = buildApp({
      db,
      livemap,
      livemapReadModel: readModel,
      verifyToken: async (token) => ({ keycloakSubject: token, displayName: token }),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await client.close();
  });

  it("liefert selbst gehostete Konfiguration, anklickbare Objekte und die weltzeitgebundene Tafel", async () => {
    const headers = { authorization: "Bearer owner" };
    const config = await app.inject({ method: "GET", url: `/worlds/${WORLD_ID}/livemap/config`, headers });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({
      worldId: WORLD_ID,
      basemap: { styleUrl: "/tiles/base/style.json", selfHosted: true },
      infrastructure: { coverage: "DE" },
    });

    const object = await app.inject({ method: "GET", url: `/worlds/${WORLD_ID}/livemap/objects/track/track-1`, headers });
    expect(object.statusCode).toBe(200);
    expect(object.json()).toMatchObject({ id: "track-1", qualityClass: "A" });

    const board = await app.inject({ method: "GET", url: `/worlds/${WORLD_ID}/livemap/stations/station-halle/board`, headers });
    expect(board.statusCode).toBe(200);
    expect(board.json()).toMatchObject({
      worldId: WORLD_ID,
      atS: 42,
      departures: [{ trainId: "train-1", scheduledTimeS: 40, expectedTimeS: 100, status: "scheduled" }],
    });
  });

  it("redigiert den oeffentlichen Stream und erzeugt das FIS nur aus oeffentlichen Livefakten", async () => {
    const headers = { authorization: "Bearer foreign" };
    const snapshot = await app.inject({ method: "GET", url: `/worlds/${WORLD_ID}/livemap/snapshot`, headers });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      objectStates: [{ id: "track:track-1", state: "construction" }],
      trains: [{ id: "train-1", mapPosition: { trackId: "track-1" } }],
    });
    const external = snapshot.json<{ externalTrains: readonly Record<string, unknown>[] }>().externalTrains[0]!;
    expect(external).not.toHaveProperty("fixedCostCents");
    expect(external).not.toHaveProperty("boundVehicleIds");
    expect(external).not.toHaveProperty("boundPersonnelDutyIds");

    const train = await app.inject({ method: "GET", url: `/worlds/${WORLD_ID}/livemap/trains/train-1`, headers });
    expect(train.statusCode).toBe(200);
    expect(train.json()).toMatchObject({
      worldId: WORLD_ID,
      atS: 42,
      movement: "network",
      fis: {
        destination: "Erfurt Hbf",
        nextStop: "Halle (Saale) Hbf",
        delaySeconds: 60,
        messages: ["Heute etwa 1 Minute spaeter.", "Voraussichtlich 1 Minute spaeter."],
      },
    });
    expect(train.json()).not.toHaveProperty("ownerOperatorId");
    expect(JSON.stringify(train.json())).not.toContain("vehicle-secret");
  });

  it("autorisiert die EVU-Zusatzsicht serverseitig", async () => {
    const publicDetail = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_ID}/livemap/trains/train-1`,
      headers: { authorization: "Bearer owner" },
    });
    expect(publicDetail.json()).toMatchObject({ ownerOperatorId: operatorId });
    const url = `/worlds/${WORLD_ID}/operators/${operatorId}/livemap/trains/train-1`;
    const denied = await app.inject({ method: "GET", url, headers: { authorization: "Bearer foreign" } });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({ method: "GET", url, headers: { authorization: "Bearer owner" } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      worldId: WORLD_ID,
      operatorId,
      trainId: "train-1",
      vehicleIds: ["vehicle-secret"],
    });
  });
});
