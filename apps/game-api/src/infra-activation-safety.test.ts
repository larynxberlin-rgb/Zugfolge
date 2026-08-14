import { describe, expect, it } from "vitest";

import { GameInfraActivationSafety, parseInfraActivationSafetyReports } from "./infra-activation-safety.js";

describe("Infra-Aktivierung ohne freigegebenen Sicherheitsbericht", () => {
  it("akzeptiert einen explizit leeren Katalog und lehnt jede Aktivierung fail-closed ab", async () => {
    const reports = parseInfraActivationSafetyReports("[]");
    expect(reports).toEqual([]);
    const safety = new GameInfraActivationSafety({} as never, reports);
    await expect(safety.verify({
      worldId: "00000000-0000-4000-8000-000000000014",
      predecessorHash: "1".repeat(64),
      releaseHash: "2".repeat(64),
      activateAtPeriod: 1,
    })).resolves.toMatchObject({ safe: false, conflictCount: 1 });
  });

  it("weist andere JSON-Typen weiterhin zurueck", () => {
    expect(() => parseInfraActivationSafetyReports("{}"))
      .toThrow("INFRA_ACTIVATION_SAFETY_REPORTS_JSON muss eine Liste sein.");
  });
});
