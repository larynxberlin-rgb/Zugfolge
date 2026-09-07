import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateFleetAuthorityRelease } from "./index.js";
import { validateM5VehicleConfiguration, type M5VehicleConfigurationV1 } from "./vehicle-configuration.js";

/** Ausschließlich Transportregression; keine Fahrzeug- oder Geometriefreigabe. */
function configuration(): M5VehicleConfigurationV1 {
  return {
    schemaVersion: "m5-vehicle-configuration/v1",
    structural: { doorCountPerSide: 2, doorWidthMm: 1_200, bodyLengthMm: 26_000 },
    interior: { firstClassSeats: 8, secondClassSeats: 60, density: "standard", seatType: "row",
      multipurpose: { bicycles: 4, pushchairs: 2, wheelchairs: 2, standing: 20 },
      toilets: 1, accessibleToilets: 1, amenities: ["air_conditioning", "wifi", "power_sockets", "passenger_information"] },
  };
}

describe("Vollständiger M5-Konfigurationstransport", () => {
  it("erhält tatsächliche Felder und gültige Nullzahlen ohne Ersatzwerte", () => {
    const value = configuration(), before = structuredClone(value);
    validateM5VehicleConfiguration(value);
    expect(value).toEqual(before);
    validateM5VehicleConfiguration({ ...value, interior: { ...value.interior, firstClassSeats: 0, toilets: 0, accessibleToilets: 0, amenities: [] } });
  });

  it("weist Teilkonfigurationen, neue Felder, null, Bruchteile und überlaufende Werte ab", () => {
    const value = configuration();
    const invalid = [
      null, {}, { ...value, schemaVersion: "m5-vehicle-configuration/v2" },
      { ...value, structural: { ...value.structural, doorCountPerSide: 0 } },
      { ...value, structural: { ...value.structural, doorWidthMm: 0.5 } },
      { ...value, structural: { ...value.structural, bodyLengthMm: 4_294_967_296 } },
      { ...value, structural: { ...value.structural, deckCount: 2 } },
      { ...value, interior: { ...value.interior, firstClassSeats: 65_536 } },
      { ...value, interior: { ...value.interior, toilets: 256 } },
      { ...value, interior: { ...value.interior, density: "invented" } },
      { ...value, interior: { ...value.interior, multipurpose: { standing: 20 } } },
      { ...value, interior: { ...value.interior, amenities: ["wifi", "wifi"] } },
      { ...value, interior: { ...value.interior, amenities: ["unknown"] } },
    ];
    for (const input of invalid) expect(() => validateM5VehicleConfiguration(input)).toThrow(/Transportvertrag/);
  });

  it("lässt Legacy-Authority unverändert und transportiert einen vollständigen Eintrag verlustfrei", () => {
    const catalog = JSON.parse(readFileSync(new URL("../../../crates/zugfolge-fleet/tests/fixtures/fleet-authority-release-catalog-v1.json", import.meta.url), "utf8"));
    const release = catalog.entries[0].authorityRelease;
    const original = JSON.stringify(release);
    validateFleetAuthorityRelease(release);
    expect(JSON.stringify(release)).toBe(original);
    expect(release.assets.every((asset: Record<string, unknown>) => !Object.hasOwn(asset, "vehicleConfiguration"))).toBe(true);
    const supplied = configuration();
    release.assets[0].vehicleConfiguration = supplied;
    validateFleetAuthorityRelease(release);
    expect(release.assets[0].vehicleConfiguration).toEqual(supplied);
    release.assets[0].vehicleConfiguration = { structural: supplied.structural };
    expect(() => validateFleetAuthorityRelease(release)).toThrow(/Transportvertrag/);
  });
});
