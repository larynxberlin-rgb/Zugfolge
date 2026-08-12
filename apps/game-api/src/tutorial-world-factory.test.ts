import { describe, expect, it } from "vitest";

import { TUTORIAL_TEMPLATE } from "@zugfolge/alpha";
import { createTenderCalendar, deriveWorldProfile } from "@zugfolge/economy";

import { TUTORIAL_ECONOMY_LOTS, TUTORIAL_LEASE_TIMES, tutorialPlanningCommand } from "./tutorial-world-factory.js";

describe("TutorialWorldFactory PlanningRun-Vertrag", () => {
  it("haelt die Antwortfrist innerhalb des Leasing-Angebotsfensters", () => {
    expect(TUTORIAL_LEASE_TIMES.offeredAtS).toBeLessThanOrEqual(TUTORIAL_LEASE_TIMES.responseDeadlineS);
    expect(TUTORIAL_LEASE_TIMES.responseDeadlineS).toBeLessThanOrEqual(TUTORIAL_LEASE_TIMES.validFromS);
    expect(TUTORIAL_LEASE_TIMES.validFromS).toBeLessThan(TUTORIAL_LEASE_TIMES.validUntilS);
  });

  it("bildet einen gueltigen Sechsmonatskalender mit genau einem sichtbaren Tutoriallos", () => {
    expect(() => createTenderCalendar(deriveWorldProfile(6), TUTORIAL_ECONOMY_LOTS, 7_219_2026n)).not.toThrow();
    expect(TUTORIAL_ECONOMY_LOTS.filter((lot) => lot.id === "tutorial-lot")).toHaveLength(1);
  });

  it.each(TUTORIAL_TEMPLATE.paths.map((alternative, index) => [alternative, index + 1] as const))(
    "materialisiert jede Trassenoption mit Segmenten und einem eindeutigen Vergleichsantrag",
    (alternative, runIndex) => {
      const command = tutorialPlanningCommand({
        reference: "tut_contract",
        tutorialWorldId: "11111111-1111-4111-8111-111111111111",
      }, TUTORIAL_TEMPLATE, alternative as Record<string, unknown>, runIndex);

      expect(command.segments.length).toBeGreaterThan(0);
      expect(command.sourceId).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(command.sourceId).toBe("tutorial-minimal-2026-1-corridor");
      expect(command.requests).toHaveLength(2);
      expect(new Set(command.requests.map((request) => request.requestNumericId)).size).toBe(2);
      expect(new Set(command.requests.map((request) => request.trainId)).size).toBe(2);
      expect(new Set(command.requests.map((request) => request.train.numericId)).size).toBe(2);
      expect(new Set(command.requests.map((request) => `${request.trainCategory}:${request.trainNumber}`)).size).toBe(2);
      expect(command.requests.every((request) => request.trainCategory === "regional"
        && request.trainNumber >= 20_000
        && request.trainNumber <= 39_999
        && request.trainNumber % 2 === 0)).toBe(true);
      expect("worldId" in command.requests[0]!).toBe(false);
      expect(command.worldId).toBe("11111111-1111-4111-8111-111111111111");
    },
  );
});
