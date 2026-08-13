import { PGlite } from "@electric-sql/pglite";
import { OnboardingService, type OnboardingPort, type StartPackageSpec } from "@zugfolge/alpha";
import {
  accounts,
  alphaWorldProfiles,
  domainEvents,
  MIGRATIONS_FOLDER,
  onboardingGrants,
  operators,
  worldAccesses,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerAlphaRoutes } from "./alpha-routes.js";

const PUBLIC_WORLD_ID = "00000000-0000-4000-8000-000000000211";
const PUBLIC_ACCOUNT_ID = "00000000-0000-4000-8000-000000000212";
const SUBJECT = "kc-public-route";

const SPEC: StartPackageSpec = {
  schemaVersion: "zugfolge-start-package/v1",
  version: "tutorial-2026-08",
  emergencyLotId: "tutorial-lot-1",
  maximumTrainKmPerPeriod: 1_000,
  vehicleClass: "Mireo",
  maximumVehicleValueCents: 900_000_000n,
  durationS: 86_400,
  pathWindowId: "tutorial-path-1",
  personnelPoolId: "tutorial-pool-1",
  operatingProgramTemplateId: "balanced",
};

describe("Startpaket-Routen in oeffentlichen Welten", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: FastifyInstance;
  let grantThroughAuthoritativePaths: OnboardingPort["grantThroughAuthoritativePaths"];

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({
      id: PUBLIC_WORLD_ID,
      name: "Oeffentliche Alpha",
      schedulePeriodWeeks: 3,
      epoch: new Date(0),
      worldKind: "public",
      rankingStatus: "ranked",
      lifecycleStatus: "active",
    });
    await db.insert(alphaWorldProfiles).values({
      worldId: PUBLIC_WORLD_ID,
      profileKind: "public",
      regionId: "mitteldeutschland-b",
      regionVariant: "B",
      worldSeed: 211n,
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
      id: PUBLIC_ACCOUNT_ID,
      worldId: PUBLIC_WORLD_ID,
      keycloakSubject: SUBJECT,
      displayName: "Oeffentlicher Spieler",
    });
    await db.insert(worldAccesses).values({
      worldId: PUBLIC_WORLD_ID,
      keycloakSubject: SUBJECT,
    });

    grantThroughAuthoritativePaths = vi.fn<OnboardingPort["grantThroughAuthoritativePaths"]>(async () => {
      throw new Error("Oeffentliche Welt darf den autoritativen Startpaket-Port nicht erreichen.");
    });
    const onboarding = new OnboardingService(db, {
      grantThroughAuthoritativePaths,
      capacityCells: async () => [],
    });
    const consume = vi.fn(async () => ({ response: "observe", scoreBasisPoints: 0 }));
    app = Fastify({ logger: false });
    registerAlphaRoutes(app, {
      db,
      authenticate: (async (request: { identity?: { keycloakSubject: string; displayName: string } }) => {
        request.identity = { keycloakSubject: SUBJECT, displayName: "Oeffentlicher Spieler" };
      }) as never,
      services: {
        onboarding,
        startPackageSpec: SPEC,
        abuse: { consume } as never,
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

  it("liefert die aktuelle Weltzeit serverautoritativ aus Epoch und Weltfaktor", async () => {
    const response = await app.inject({ method: "GET", url: `/worlds/${PUBLIC_WORLD_ID}/simulation-time` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ atS: 1 });
  });

  it("liefert fuer Status und Claim denselben stabilen Konflikt ohne Fachwirkung", async () => {
    const status = await app.inject({
      method: "GET",
      url: `/worlds/${PUBLIC_WORLD_ID}/onboarding/start-package`,
    });
    const claim = await app.inject({
      method: "POST",
      url: `/worlds/${PUBLIC_WORLD_ID}/onboarding/start-package`,
    });

    expect(status.statusCode).toBe(409);
    expect(status.json()).toMatchObject({ code: "start_package_tutorial_only" });
    expect(claim.statusCode).toBe(409);
    expect(claim.json()).toMatchObject({ code: "start_package_tutorial_only" });
    expect(grantThroughAuthoritativePaths).not.toHaveBeenCalled();
    expect(await db.select().from(onboardingGrants)).toHaveLength(0);
    expect(await db.select().from(operators)).toHaveLength(0);
    expect(await db.select().from(domainEvents)).toHaveLength(0);
  });
});
