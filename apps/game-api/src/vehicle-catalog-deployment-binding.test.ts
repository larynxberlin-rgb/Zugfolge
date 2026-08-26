import { alphaHash } from "@zugfolge/alpha";
import {
  FLEET_INITIALIZE_SCHEMA,
  OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
  OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
  type FleetAuthorityReleaseV2,
} from "@zugfolge/runtime-native";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  bindVehicleCatalogDeployment,
  compilerPrettyJsonSha256,
  validateVehicleCatalogDeploymentBinding,
  VEHICLE_CATALOG_COMPILER_INPUT_FILES_SCHEMA,
  type OperationalVehicleInventoryV2,
  type VehicleCatalogCompileReceiptV4,
  type VehicleCatalogDeploymentFacts,
} from "./vehicle-catalog-deployment-binding.js";
import type { SignedAlphaWorldDeployment } from "./alpha-world-start.js";
import { ActiveWorldDeploymentRuntime } from "./world-deployment-runtime.js";

const FIXTURE_DIRECTORY = new URL(
  "../../../crates/zugfolge-fleet/tests/fixtures/",
  import.meta.url,
);
const UNUSED_OPERATIONAL_PROGRAM_PREFLIGHT = () => {
  throw new Error("Dieser Fahrzeugkatalogtest registriert kein Betriebsprogramm.");
};
const RUNTIME_AUTHORITY_RELEASE_HASH = "9".repeat(64);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, FIXTURE_DIRECTORY)), "utf8")) as T;
}

function inputs() {
  const catalog = fixture<{
    schemaVersion: string;
    entries: readonly [{
      worldId: string;
      producedAt: number;
      authorityRelease: FleetAuthorityReleaseV2;
    }];
  }>("fleet-authority-release-catalog-v1.json");
  const receipt = fixture<VehicleCatalogCompileReceiptV4>(
    "vehicle-catalog-compile-receipt-v4.json",
  );
  const operationalInventory = fixture<OperationalVehicleInventoryV2>(
    "operational-vehicle-inventory-v2.json",
  );
  const worldSeed = fixture<{
    readonly economy: {
      readonly release: {
        readonly schema: "economy-release/v1";
        readonly version: string;
        readonly rates: Readonly<Record<string, unknown>>;
        readonly rules: Readonly<Record<string, unknown>>;
        readonly tenderProfiles: readonly unknown[];
      };
    };
  }>("vehicle-world-seed-v3.json");
  const entry = catalog.entries[0];
  const fleet = {
    schemaVersion: FLEET_INITIALIZE_SCHEMA,
    worldId: entry.worldId,
    producedAt: entry.producedAt,
    authorityRelease: entry.authorityRelease,
    formations: [{
      id: "fixture-formation-1",
      vehicleIds: ["fixture-vehicle-1"],
      pathReceiptId: "fixture-path-1",
    }],
  } as const;
  const regionalSimulation = {
    schemaVersion: OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
    worldId: entry.worldId,
    regionId: "fixture-region",
    nowMs: 0,
    protectionModeSelectionPolicy: OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
    infraRelease: {},
    vehicleTypes: operationalInventory.vehicleTypes,
    vehicles: operationalInventory.vehicles,
    formations: operationalInventory.formations.map((formation) => ({
      id: (formation as Record<string, unknown>)["id"] as string,
      predecessorId: (formation as Record<string, unknown>)["predecessorId"] as string | null | undefined ?? null,
      vehicleIds: (formation as Record<string, unknown>)["vehicleIds"] as readonly string[],
    })),
    trains: [],
  } as const;
  const facts: VehicleCatalogDeploymentFacts = {
    worldId: entry.worldId,
    economyReleaseId: receipt.economyReleaseId,
    economyReleaseSha256: receipt.economyReleaseSha256,
    blueprintFleetHash: RUNTIME_AUTHORITY_RELEASE_HASH,
    fleet,
    regionalSimulation,
  };
  const compilerInputFiles = {
    schemaVersion: VEHICLE_CATALOG_COMPILER_INPUT_FILES_SCHEMA,
    sourceCatalogSha256: "1".repeat(64),
    worldSeedSha256: "2".repeat(64),
    compiledCatalogSha256: receipt.compiledCatalogSha256,
    runtimeAuthorityReleaseHash: RUNTIME_AUTHORITY_RELEASE_HASH,
  } as const;
  return { catalog, receipt, operationalInventory, worldSeed, facts, compilerInputFiles };
}

function changed<T>(value: T, edit: (copy: any) => void): T {
  const copy = structuredClone(value);
  edit(copy);
  return copy;
}

function signedV2(): SignedAlphaWorldDeployment {
  const { compilerInputFiles, receipt, operationalInventory, worldSeed, facts } = inputs();
  return {
    deploymentHash: "9".repeat(64),
    signature: { algorithm: "Ed25519", keyId: "test", valueBase64: "signature" },
    deployment: {
      worldId: facts.worldId,
      economy: { release: worldSeed.economy.release },
      blueprint: { releases: { fleet: facts.blueprintFleetHash } },
      fleet: facts.fleet,
      regionalSimulation: facts.regionalSimulation,
      vehicleCatalogBinding: bindVehicleCatalogDeployment(compilerInputFiles, receipt, operationalInventory, facts),
    },
  } as unknown as SignedAlphaWorldDeployment;
}

describe("signierte Fahrzeugkatalog-Deployment-Bindung", () => {
  it("verifiziert echte Rust-Compilerbytes einschliesslich Wrapper und OutputSet", () => {
    const { catalog, compilerInputFiles, receipt, operationalInventory, facts } = inputs();

    expect(compilerPrettyJsonSha256(catalog)).toBe(receipt.fleetAuthorityCatalogSha256);
    expect(compilerPrettyJsonSha256(operationalInventory)).toBe(receipt.operationalInventorySha256);
    expect(compilerPrettyJsonSha256(facts.fleet.authorityRelease)).toBe(receipt.fleetAuthoritySha256);
    expect(facts.fleet.formations[0]).not.toHaveProperty("dynamics");
    expect(() => bindVehicleCatalogDeployment(compilerInputFiles, receipt, operationalInventory, facts)).not.toThrow();
  });

  it("verweigert Authority-v2 ohne Binding und jede Seed-/Economy-/Fleet-/OutputSet-Manipulation", () => {
    const { compilerInputFiles, receipt, operationalInventory, facts } = inputs();
    expect(() => validateVehicleCatalogDeploymentBinding(undefined, facts)).toThrow(/Compilerbeweis/);

    const binding = bindVehicleCatalogDeployment(compilerInputFiles, receipt, operationalInventory, facts);
    expect(() => validateVehicleCatalogDeploymentBinding(binding, {
      ...facts,
      fleet: { ...facts.fleet, producedAt: 0 },
    })).toThrow(/Seed-Zeit/);
    expect(() => validateVehicleCatalogDeploymentBinding(binding, {
      ...facts,
      economyReleaseSha256: "0".repeat(64),
    })).toThrow(/Economy/);
    expect(() => validateVehicleCatalogDeploymentBinding(binding, {
      ...facts,
      fleet: {
        ...facts.fleet,
        authorityRelease: changed(facts.fleet.authorityRelease, (release) => {
          release.assets[0].tradeName = "Manipuliert";
        }),
      },
    })).toThrow(/Hash/);
    expect(() => validateVehicleCatalogDeploymentBinding(changed(binding, (copy) => {
      copy.receipt.outputSetSha256 = "0".repeat(64);
    }), facts)).toThrow(/Hash/);
    expect(() => validateVehicleCatalogDeploymentBinding(changed(binding, (copy) => {
      copy.compilerInputFiles.sourceCatalogSha256 = "G".repeat(64);
    }), facts)).toThrow(/SHA-256/);
    expect(() => validateVehicleCatalogDeploymentBinding(changed(binding, (copy) => {
      delete copy.compilerInputFiles.worldSeedSha256;
    }), facts)).toThrow(/exakt/);
    expect(() => validateVehicleCatalogDeploymentBinding(changed(binding, (copy) => {
      copy.compilerInputFiles.runtimeAuthorityReleaseHash = "0".repeat(64);
    }), facts)).toThrow(/Blueprint-Hash/);
  });

  it("verweigert Operational-Typ, Asset, Formation und Fleet-Client-Dynamics getrennt", () => {
    const { compilerInputFiles, receipt, operationalInventory, facts } = inputs();
    const binding = bindVehicleCatalogDeployment(compilerInputFiles, receipt, operationalInventory, facts);
    for (const regionalSimulation of [
      { ...facts.regionalSimulation, vehicleTypes: changed(facts.regionalSimulation.vehicleTypes, (types) => {
        types[0].powered = false;
      }) },
      { ...facts.regionalSimulation, vehicles: changed(facts.regionalSimulation.vehicles, (vehicles) => {
        vehicles[0].orientation = "against";
      }) },
      { ...facts.regionalSimulation, formations: changed(facts.regionalSimulation.formations, (formations) => {
        formations[0].vehicleIds = [];
      }) },
    ]) {
      expect(() => validateVehicleCatalogDeploymentBinding(binding, {
        ...facts,
        regionalSimulation,
      })).toThrow(/Operational|Formation/);
    }
    expect(() => validateVehicleCatalogDeploymentBinding(binding, {
      ...facts,
      fleet: changed(facts.fleet, (fleet) => {
        fleet.formations[0].dynamics = {
          accelerationMmPerS2: 1_000,
          decelerationMmPerS2: 900,
        };
      }),
    })).toThrow(/Formation/);
  });

  it("behandelt Compilerhashes bewusst bytegenau und lehnt Key-Reordering ab", () => {
    const { compilerInputFiles, receipt, operationalInventory, facts } = inputs();
    const reordered = Object.fromEntries(
      Object.entries(facts.fleet.authorityRelease).reverse(),
    ) as unknown as FleetAuthorityReleaseV2;

    expect(alphaHash("zugfolge-fleet-authority-runtime/v1", reordered))
      .toBe(alphaHash("zugfolge-fleet-authority-runtime/v1", facts.fleet.authorityRelease));
    expect(compilerPrettyJsonSha256(reordered)).not.toBe(receipt.fleetAuthoritySha256);
    expect(() => bindVehicleCatalogDeployment(compilerInputFiles, receipt, operationalInventory, {
      ...facts,
      fleet: { ...facts.fleet, authorityRelease: reordered },
    })).toThrow(/Hash/);
  });

  it("akzeptiert v2-Bindungen aus persistiertem oder Releasepfad und sperrt fehlende Beweise", () => {
    const signed = signedV2();
    const configuration = {
      producedAt: signed.deployment.fleet.producedAt,
      authorityRelease: signed.deployment.fleet.authorityRelease,
    };
    const persistedOnly = new Map([[signed.deployment.worldId, signed]]);
    const releasePathOnly = new Map([[signed.deployment.worldId, structuredClone(signed)]]);
    for (const verifiedSource of [persistedOnly, releasePathOnly]) {
      const runtime = new ActiveWorldDeploymentRuntime({
        activeWorlds: [],
        operationalProgramPreflight: UNUSED_OPERATIONAL_PROGRAM_PREFLIGHT,
        fleetAuthorityConfigurations: { [signed.deployment.worldId]: configuration },
      });
      expect(() => runtime.assertVehicleCatalogDeploymentBindings(verifiedSource)).not.toThrow();
    }

    const missing = new ActiveWorldDeploymentRuntime({
      activeWorlds: [],
      operationalProgramPreflight: UNUSED_OPERATIONAL_PROGRAM_PREFLIGHT,
      fleetAuthorityConfigurations: { [signed.deployment.worldId]: configuration },
    });
    expect(() => missing.assertVehicleCatalogDeploymentBindings(new Map())).toThrow(
      /kein verifiziertes signiertes Fahrzeugkatalog-Deployment/u,
    );
  });

  it("sperrt einen Loader-Authority-Hash im Konflikt zum signierten v2-Deployment", () => {
    const signed = signedV2();
    const conflictingAuthority = changed(signed.deployment.fleet.authorityRelease, (authority) => {
      authority.assets[0].tradeName = "Loader-Konflikt";
    });
    const runtime = new ActiveWorldDeploymentRuntime({
      activeWorlds: [],
      operationalProgramPreflight: UNUSED_OPERATIONAL_PROGRAM_PREFLIGHT,
      fleetAuthorityConfigurations: {
        [signed.deployment.worldId]: {
          producedAt: signed.deployment.fleet.producedAt,
          authorityRelease: conflictingAuthority,
        },
      },
    });

    expect(() => runtime.assertVehicleCatalogDeploymentBindings(
      new Map([[signed.deployment.worldId, signed]]),
    )).toThrow(/Konflikt/u);
  });
});
