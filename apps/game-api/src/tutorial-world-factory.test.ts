import { describe, expect, it } from "vitest";

import { TUTORIAL_TEMPLATE, TUTORIAL_TEMPLATE_HASH } from "@zugfolge/alpha";
import { closeTender, createTenderCalendar, deriveWorldProfile, submitBid } from "@zugfolge/economy";

import {
  TUTORIAL_ECONOMY_LOTS,
  TUTORIAL_LEASE_TIMES,
  TUTORIAL_TIMELINE,
  prepareTutorialEconomy,
  tutorialPlanningCommand,
} from "./tutorial-world-factory.js";

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

  it("oeffnet die echte Ausschreibung mit gueltigen Fristen und Vergleichsangebot", () => {
    const prepared = prepareTutorialEconomy({
      worldId: "11111111-1111-4111-8111-111111111111",
      tutorialAccountId: "tutorial-account",
      comparisonAccountId: "comparison-account",
      comparisonOperatorId: "comparison-operator",
      reference: "tut_contract",
    });
    const lifecycle = prepared.state.tenders.get("tutorial-tender");

    expect(lifecycle?.phase).toBe("open");
    if (lifecycle?.phase !== "open") throw new Error("Tutorialausschreibung ist nicht offen.");
    expect(lifecycle.tender.closesAt - lifecycle.tender.opensAt).toBe(86_400);
    expect(lifecycle.tender.contractPeriods).toBe(2);
    expect(lifecycle.tender.operatingFrom).toBe(TUTORIAL_TIMELINE.operatingFromS);
    expect(lifecycle.tender.viabilityThresholdCentsPerTrainKm).toBeGreaterThanOrEqual(1_580n);
    expect(lifecycle.bids.map((bid) => bid.id)).toEqual(["tutorial-comparison-bid"]);

    const withPlayerBid = submitBid(prepared.state, "tut_contract:player-bid", "tutorial-tender", {
      id: "tut_contract:player-bid",
      operatorId: "tutorial-operator",
      orderingFeeCentsPerTrainKm: 1_450n,
      vehicle: {
        formationId: "tut_contract:planned-formation",
        minimumSeats: 152,
        maximumSpeedKph: 140,
        operatingCostCentsPerTrainKm: 720,
        firstClassBasisPoints: 0,
        accessible: true,
        bicyclePlaces: 12,
        wheelchairPlaces: 2,
        requiredEquipment: ["passenger-information"],
        vehicleAgeYears: 4,
        traction: "electric",
        replacementPlan: true,
        evidence: {
          source: "zugfolge-fleet-mobilization/v1",
          fleetRevision: 0,
          snapshotHash: TUTORIAL_TEMPLATE_HASH,
          formationId: "tut_contract:planned-formation",
        },
      },
      promises: { extraSeats: 12, punctualityBasisPoints: 9_200, additionalStops: 0 },
      submittedAt: TUTORIAL_TIMELINE.playerBidAtS,
    }, { accountId: "tutorial-account", period: 0, smallLot: true, minimumScore: 0 });
    const awarded = closeTender(withPlayerBid, {
      commandId: "tut_contract:close",
      tenderId: "tutorial-tender",
      at: TUTORIAL_TIMELINE.tenderClosesAtS,
      authorityId: "tutorial-authority",
      budgetPeriod: 0,
      vehiclePool: ["tutorial-public-reserve"],
      recipientByOperator: { "tutorial-operator": "tutorial-account" },
    }).state.tenders.get("tutorial-tender");
    expect(awarded?.phase).toBe("awarded");
    if (awarded?.phase !== "awarded") throw new Error("Tutorialausschreibung wurde nicht vergeben.");
    expect(awarded.winningBid.operatorId).toBe("tutorial-operator");
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
