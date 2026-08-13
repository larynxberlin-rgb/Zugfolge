import { describe, expect, it } from "vitest";

import { TUTORIAL_TEMPLATE } from "@zugfolge/alpha";
import { closeTender, createTenderCalendar, deriveWorldProfile, submitBid } from "@zugfolge/economy";

import {
  TUTORIAL_ECONOMY_LOTS,
  TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN,
  TUTORIAL_CONTRACT_PERIOD_SECONDS,
  TUTORIAL_CONTRACT_EVIDENCE,
  TUTORIAL_LEASE_TIMES,
  TUTORIAL_SETTLEMENT_PERIOD,
  TUTORIAL_TIMELINE,
  prepareTutorialEconomy,
  tutorialPlayerBid,
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

  it("liefert alle vom Servicevertrag verlangten Abrechnungsklassen", () => {
    expect(TUTORIAL_CONTRACT_EVIDENCE).toEqual(["vehicles", "personnel", "paths"]);
  });

  it("rechnet Periode null erst an ihrem serverseitigen Periodenende ab", () => {
    expect(TUTORIAL_SETTLEMENT_PERIOD).toBe(0);
    expect(TUTORIAL_TIMELINE.settlementAtS).toBe(
      TUTORIAL_TIMELINE.operatingFromS + TUTORIAL_CONTRACT_PERIOD_SECONDS,
    );
    expect(TUTORIAL_TIMELINE.settlementAtS).toBeGreaterThan(TUTORIAL_TIMELINE.operatingFromS + 620);
  });

  it("bindet das Tutorialjournal an seinen explizit versionierten Kontenplan", () => {
    expect(TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN).toMatchObject({
      schema: "economy-ledger-account-plan/v1",
      version: "tutorial-template-2026.1",
      cashAccountName: "Bank",
      revenueAccountName: "Bestellererloese",
      costAccountNames: {
        track: "Kosten:track",
        energy: "Kosten:energy",
        personnel: "Kosten:personnel",
      },
    });
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

    expect(prepared.initial.state.revision).toBe(0);
    expect(prepared.state.revision).toBeGreaterThan(prepared.initial.state.revision);
    expect(lifecycle?.phase).toBe("open");
    if (lifecycle?.phase !== "open") throw new Error("Tutorialausschreibung ist nicht offen.");
    expect(lifecycle.tender.closesAt - lifecycle.tender.opensAt).toBe(86_400);
    expect(lifecycle.tender.contractPeriods).toBe(2);
    expect(lifecycle.tender.operatingFrom).toBe(TUTORIAL_TIMELINE.operatingFromS);
    expect(lifecycle.tender.viabilityThresholdCentsPerTrainKm).toBeGreaterThanOrEqual(1_580n);
    expect(lifecycle.bids.map((bid) => bid.id)).toEqual(["tutorial-comparison-bid"]);

    const bid = tutorialPlayerBid(
      { reference: "tut_contract", tutorialOperatorId: "tutorial-operator" },
      { type: "submit-bid", orderingFeeCentsPerTrainKm: "1450", extraSeats: 12, punctualityBasisPoints: 9_200 },
      "tutorial-vehicle-economy",
    );
    expect(bid.vehicle.evidence.formationId).toBe(bid.vehicle.formationId);
    const withPlayerBid = submitBid(prepared.state, "tut_contract:player-bid", "tutorial-tender", bid, {
      accountId: "tutorial-account",
      period: 0,
      smallLot: true,
      minimumScore: 0,
    });
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
