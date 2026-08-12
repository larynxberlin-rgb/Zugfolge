import { PGlite } from "@electric-sql/pglite";
import {
  accounts,
  alphaWorldProfiles,
  MIGRATIONS_FOLDER,
  worldAccesses,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAlphaRoutes } from "./alpha-routes.js";

const WORLD_ID = "00000000-0000-4000-8000-000000000221";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000222";
const SUBJECT = "kc-simulation-time";

describe("serverautoritative Simulationszeit", () => {
  let client: PGlite;
  let app: FastifyInstance;

  beforeEach(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({
      id: WORLD_ID,
      name: "Zeitwelt",
      schedulePeriodWeeks: 3,
      epoch: new Date(0),
      worldKind: "public",
      rankingStatus: "ranked",
      lifecycleStatus: "active",
    });
    await db.insert(alphaWorldProfiles).values({
      worldId: WORLD_ID,
      profileKind: "public",
      regionId: "mitteldeutschland-b",
      regionVariant: "B",
      worldSeed: 221n,
      accelerationFactor: 1,
      infraReleaseHash: "1".repeat(64),
      timetableReleaseHash: "2".repeat(64),
      fleetReleaseHash: "3".repeat(64),
      economyReleaseHash: "4".repeat(64),
      blueprint: {},
      blueprintHash: "5".repeat(64),
      state: "running",
    });
    await db.insert(accounts).values({
      id: ACCOUNT_ID,
      worldId: WORLD_ID,
      keycloakSubject: SUBJECT,
      displayName: "Zeitspieler",
    });
    await db.insert(worldAccesses).values({ worldId: WORLD_ID, keycloakSubject: SUBJECT });

    app = Fastify({ logger: false });
    registerAlphaRoutes(app, {
      db,
      authenticate: (async (request: { identity?: { keycloakSubject: string; displayName: string } }) => {
        request.identity = { keycloakSubject: SUBJECT, displayName: "Zeitspieler" };
      }) as never,
      services: {
        abuse: {} as never,
        pseudonymSecret: "a".repeat(32),
        clock: () => new Date(1_000),
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await client.close();
  });

  it("leitet die Weltzeit aus Epoche und Weltfaktor ab", async () => {
    const response = await app.inject({ method: "GET", url: `/worlds/${WORLD_ID}/simulation-time` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ atS: 1 });
  });
});
