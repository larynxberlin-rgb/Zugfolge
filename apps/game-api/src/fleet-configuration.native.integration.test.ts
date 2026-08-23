import {
  FLEET_INITIALIZE_SCHEMA,
  loadOperatingRuntime,
} from "@zugfolge/runtime-native";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { loadFleetAuthorityReleaseCatalog } from "./fleet-configuration.js";

const WORLD_ID = "00000000-0000-4000-8000-000000000387";
const COMPILER_AUTHORITY_CATALOG_PATH = fileURLToPath(new URL(
  "../../../crates/zugfolge-fleet/tests/fixtures/fleet-authority-release-catalog-v1.json",
  import.meta.url,
));
const nativeAddonPath = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"]?.trim();
const nativeIt = nativeAddonPath === undefined || nativeAddonPath.length === 0 ? it.skip : it;

nativeIt("laedt den echten CLI-Wrapper und initialisiert damit die native Fleet", async () => {
  const configurations = await loadFleetAuthorityReleaseCatalog(COMPILER_AUTHORITY_CATALOG_PATH);
  const configuration = configurations[WORLD_ID];
  expect(configuration).toBeDefined();

  const initialized = loadOperatingRuntime(nativeAddonPath).initializeFleet({
    schemaVersion: FLEET_INITIALIZE_SCHEMA,
    worldId: WORLD_ID,
    producedAt: configuration!.producedAt,
    authorityRelease: configuration!.authorityRelease,
  });

  expect(initialized.state.worldId).toBe(WORLD_ID);
  expect(initialized.state.revision).toBe(0);
  expect(initialized.state.authorityRelease.releaseId).toBe("fixture-fleet-authority-1");
  expect(initialized.state.assetHoldings?.["fixture-vehicle-1"]).toBeDefined();

  expect(() => loadOperatingRuntime(nativeAddonPath).initializeFleet({
    schemaVersion: FLEET_INITIALIZE_SCHEMA,
    worldId: WORLD_ID,
    producedAt: 0,
    authorityRelease: configuration!.authorityRelease,
  })).toThrow(/nicht aktiv|nicht verfuegbar|deliveredAt|Liefer|Seed|Zeit|Stichtag/i);
});
