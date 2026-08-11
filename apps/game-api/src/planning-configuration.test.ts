import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { requestWorldAccess } from "@zugfolge/identity";
import { planningInfrastructureReleaseCatalog } from "@zugfolge/planning-worker";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import {
  parsePlanningAuthorityAccountIdsJson,
  parsePlanningInfrastructureReleasesJson,
  verifyPlanningAuthorityAccounts,
} from "./planning-configuration.js";

const worldId = "11111111-1111-4111-8111-111111111111";

const release = {
  schemaVersion: "planning.infrastructure-release/v1",
  worldId,
  releaseId: "lhe-2026",
  sourceId: "source-1",
  corridorId: "lhe",
  corridorName: "Leipzig–Halle–Erfurt",
  stations: [
    {
      numericId: 1,
      id: "leipzig",
      code: "LL",
      name: "Leipzig Hbf",
      distanceMm: 0,
      latitudeE7: 513_454_000,
      longitudeE7: 123_827_000,
      stationTrackNumericId: 1,
      stationTrackLengthMm: 400_000,
      stationMaximumSpeedKph: 80,
    },
    {
      numericId: 2,
      id: "halle",
      code: "LH",
      name: "Halle (Saale) Hbf",
      distanceMm: 35_000_000,
      latitudeE7: 514_780_000,
      longitudeE7: 119_860_000,
      stationTrackNumericId: 2,
      stationTrackLengthMm: 400_000,
      stationMaximumSpeedKph: 80,
    },
  ],
  segments: [
    {
      edgeNumericId: 1,
      trackNumericId: 1,
      id: "leipzig-halle",
      label: "Leipzig–Halle",
      fromStationId: "leipzig",
      toStationId: "halle",
      lengthMm: 35_000_000,
      maximumSpeedKph: 160,
      mainSignalPositionsMm: [10_000_000, 20_000_000],
      maximumVirtualBlockLengthMm: 10_000_000,
    },
  ],
} as const;

describe("Planning-Produktionskonfiguration", () => {
  it("friert Releases ein und baut daraus den weltisolierten Katalog", () => {
    const values = parsePlanningInfrastructureReleasesJson(JSON.stringify([release]));
    const catalog = planningInfrastructureReleaseCatalog(values);

    expect(Object.isFrozen(values)).toBe(true);
    expect(Object.isFrozen(values[0])).toBe(true);
    expect(catalog.get(worldId, "lhe-2026")).toMatchObject({ worldId, releaseId: "lhe-2026" });
    expect(catalog.get("22222222-2222-4222-8222-222222222222", "lhe-2026")).toBeUndefined();
    expect(() => parsePlanningInfrastructureReleasesJson("[]")).toThrow(TypeError);
  });

  it("verifiziert eine exakte Welt-zu-aktivem-Konto-Bindung", async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      await db.insert(worlds).values({
        id: worldId,
        name: "LHE",
        schedulePeriodWeeks: 4,
        epoch: new Date(0),
      });
      const authority = await requestWorldAccess(db, {
        worldId,
        keycloakSubject: "planning-authority",
        displayName: "Aufgabentraeger",
      });
      const mapping = parsePlanningAuthorityAccountIdsJson(
        JSON.stringify({ [worldId]: authority.id }),
      );

      await expect(
        verifyPlanningAuthorityAccounts(db, [worldId], mapping),
      ).resolves.toBeUndefined();
      await expect(
        verifyPlanningAuthorityAccounts(db, [worldId, "22222222-2222-4222-8222-222222222222"], mapping),
      ).rejects.toThrow(/genau alle/);
    } finally {
      await client.close();
    }
  });
});
