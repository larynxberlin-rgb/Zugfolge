import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FLEET_AUTHORITY_RELEASE_CATALOG_SCHEMA,
  loadFleetAuthorityReleaseCatalog,
} from "./fleet-configuration.js";

const WORLD_ID = "11111111-1111-4111-8111-111111111111";

function authorityRelease() {
  return {
    schemaVersion: "zugfolge-fleet-authority-release/v1",
    releaseId: "authority-test-v1",
    referenceYear: 2026,
    assets: [{
      id: "vehicle-1",
      numericId: 1,
      operatorId: "operator-1",
      vehicleTypeId: 101,
      classDesignation: "ET1",
      tradeName: "Testzug",
      buildYear: 2024,
      acquisitionYear: 2025,
      procurementChannel: "leasing",
      approvedLineIds: ["S1"],
      maintenanceDeadlines: [{ kind: "inspection", dueAt: 1_000 }],
      installedProtection: ["pzb"],
      technical: {
        lengthMm: 70_000,
        massKg: 120_000,
        maximumSpeedKph: 160,
        accelerationMmPerS2: 800,
        decelerationMmPerS2: 900,
        traction: "electric",
        electricSystems: ["ac15kv"],
      },
      passenger: {
        seats: 120,
        firstClassSeats: 12,
        accessible: true,
        bicyclePlaces: 8,
        wheelchairPlaces: 2,
        equipment: ["pis"],
        operatingCostCentsPerTrainKm: 700,
        replacementPlan: true,
      },
      deliveredAt: 0,
      retiredAt: 1_000,
    }],
    personnelPools: [{
      id: "pool-1",
      numericId: 1,
      operatorId: "operator-1",
      capacitySeconds: 500,
      minimumRestSeconds: 10,
      classDesignations: ["ET1"],
      pathReceiptIds: ["path-confirmed"],
      qualificationHash: "a".repeat(64),
    }],
    pathReceipts: [{
      id: "path-confirmed",
      numericRouteId: 1,
      operatorId: "operator-1",
      serviceLineIds: ["S1"],
      decision: "confirmed",
      validFrom: 0,
      validUntil: 1_000,
      platformLengthsMm: [150_000],
      electrifications: ["overhead-ac15kv"],
      requiredProtection: ["pzb"],
      approvedClasses: ["ET1"],
      plannerStateHash: "b".repeat(64),
      conflictCheckHash: "c".repeat(64),
    }],
  };
}

function catalog(
  entries: readonly unknown[] = [{ worldId: WORLD_ID, authorityRelease: authorityRelease() }],
) {
  return {
    schemaVersion: FLEET_AUTHORITY_RELEASE_CATALOG_SCHEMA,
    entries,
  };
}

const temporaryDirectories: string[] = [];

async function temporaryFile(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-fleet-authority-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "authority.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("M5-Authority-Release-Konfiguration", () => {
  it("laedt eine Weltbindung als tief geklonten und tief eingefrorenen Katalog", async () => {
    const source = authorityRelease();
    const path = await temporaryFile(catalog([{ worldId: WORLD_ID, authorityRelease: source }]));

    const loaded = await loadFleetAuthorityReleaseCatalog(path);

    expect(loaded[WORLD_ID]).toEqual(source);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded[WORLD_ID])).toBe(true);
    expect(Object.isFrozen(loaded[WORLD_ID]?.assets)).toBe(true);
    expect(Object.isFrozen(loaded[WORLD_ID]?.assets[0]?.technical)).toBe(true);
    source.assets[0]!.tradeName = "Manipuliert";
    expect(loaded[WORLD_ID]?.assets[0]?.tradeName).toBe("Testzug");
    expect(() => {
      (loaded[WORLD_ID]!.assets as unknown[]).push({});
    }).toThrow(TypeError);
  });

  it("verweigert fehlende und relative Konfigurationspfade", async () => {
    await expect(loadFleetAuthorityReleaseCatalog(undefined)).rejects.toThrow(/fehlt/);
    await expect(loadFleetAuthorityReleaseCatalog("authority.json")).rejects.toThrow(/absolut/);
  });

  it("verweigert Verzeichnisse und - soweit das Betriebssystem es erlaubt - Symlinks", async () => {
    const target = await temporaryFile(catalog());
    const directory = join(target, "..");
    await expect(loadFleetAuthorityReleaseCatalog(directory)).rejects.toThrow(/regulaere Datei/);

    const link = join(directory, "authority-link.json");
    try {
      await symlink(target, link, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return;
      throw error;
    }
    await expect(loadFleetAuthorityReleaseCatalog(link)).rejects.toThrow(/Symlink/);
  });

  it("verweigert ungueltiges UTF-8 und ungueltiges JSON", async () => {
    const utf8Path = await temporaryFile(catalog());
    await writeFile(utf8Path, Uint8Array.from([0xc3, 0x28]));
    await expect(loadFleetAuthorityReleaseCatalog(utf8Path)).rejects.toThrow(/UTF-8/);

    const jsonPath = await temporaryFile(catalog());
    await writeFile(jsonPath, "{", "utf8");
    await expect(loadFleetAuthorityReleaseCatalog(jsonPath)).rejects.toThrow(/gueltiges JSON/);
  });

  it("verweigert unbekannte oder fehlende Felder auf jeder Vertragsebene", async () => {
    const unknownTop = { ...catalog(), forged: true };
    await expect(
      loadFleetAuthorityReleaseCatalog(await temporaryFile(unknownTop)),
    ).rejects.toThrow(/unbekannt: forged/);

    const missingRelease = authorityRelease();
    const { referenceYear: _removed, ...withoutReferenceYear } = missingRelease;
    await expect(
      loadFleetAuthorityReleaseCatalog(
        await temporaryFile(catalog([{ worldId: WORLD_ID, authorityRelease: withoutReferenceYear }])),
      ),
    ).rejects.toThrow(/fehlend: referenceYear/);

    const nested = authorityRelease();
    const passenger = nested.assets[0]!.passenger as Record<string, unknown>;
    passenger["availability"] = "available";
    await expect(
      loadFleetAuthorityReleaseCatalog(
        await temporaryFile(catalog([{ worldId: WORLD_ID, authorityRelease: nested }])),
      ),
    ).rejects.toThrow(/unbekannt: availability/);
  });

  it("verweigert doppelte Welten sowie nicht kanonische Welt-UUIDs", async () => {
    await expect(
      loadFleetAuthorityReleaseCatalog(
        await temporaryFile(catalog([
          { worldId: WORLD_ID, authorityRelease: authorityRelease() },
          { worldId: WORLD_ID, authorityRelease: authorityRelease() },
        ])),
      ),
    ).rejects.toThrow(/mehrfach/);

    await expect(
      loadFleetAuthorityReleaseCatalog(
        await temporaryFile(catalog([{
          worldId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
          authorityRelease: authorityRelease(),
        }])),
      ),
    ).rejects.toThrow(/kanonische UUID/);
  });

  it("verweigert ungueltige Hashes, Enums und unsichere Ganzzahlen", async () => {
    const badHash = authorityRelease();
    badHash.personnelPools[0]!.qualificationHash = "A".repeat(64);
    await expect(
      loadFleetAuthorityReleaseCatalog(
        await temporaryFile(catalog([{ worldId: WORLD_ID, authorityRelease: badHash }])),
      ),
    ).rejects.toThrow(/SHA-256/);

    const badEnum = authorityRelease();
    badEnum.assets[0]!.procurementChannel = "gift";
    await expect(
      loadFleetAuthorityReleaseCatalog(
        await temporaryFile(catalog([{ worldId: WORLD_ID, authorityRelease: badEnum }])),
      ),
    ).rejects.toThrow(/Enum-Wert/);

    const badInteger = authorityRelease();
    badInteger.assets[0]!.numericId = Number.MAX_SAFE_INTEGER + 1;
    await expect(
      loadFleetAuthorityReleaseCatalog(
        await temporaryFile(catalog([{ worldId: WORLD_ID, authorityRelease: badInteger }])),
      ),
    ).rejects.toThrow(/sichere Ganzzahl/);
  });

  it("verweigert doppelte Quell-IDs und unbekannte Personal-Referenzen", async () => {
    const duplicate = authorityRelease();
    duplicate.assets.push({ ...structuredClone(duplicate.assets[0]!), numericId: 2 });
    await expect(
      loadFleetAuthorityReleaseCatalog(
        await temporaryFile(catalog([{ worldId: WORLD_ID, authorityRelease: duplicate }])),
      ),
    ).rejects.toThrow(/doppelten Wert 'vehicle-1'/);

    const dangling = authorityRelease();
    dangling.personnelPools[0]!.pathReceiptIds = ["unknown-path"];
    await expect(
      loadFleetAuthorityReleaseCatalog(
        await temporaryFile(catalog([{ worldId: WORLD_ID, authorityRelease: dangling }])),
      ),
    ).rejects.toThrow(/unbekannten Trassenbeleg/);
  });
});
