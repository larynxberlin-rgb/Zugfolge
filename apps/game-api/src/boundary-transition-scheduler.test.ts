import { describe, expect, it } from "vitest";

import { BoundaryTransitionCatalog, RegionalServiceCatalog, type RegionalBoundaryTransition } from "./boundary-transition-scheduler.js";

function transition(id: string, atS: number): RegionalBoundaryTransition {
  return {
    transitionId: id,
    worldId: "world",
    regionId: "region",
    atS,
    command: { type: "reenter-from-external", trainRunId: id },
  };
}

describe("BoundaryTransitionCatalog", () => {
  it("liefert Grenzkommandos stabil und nur einmal je Zeitfenster", () => {
    const catalog = new BoundaryTransitionCatalog([transition("b", 20), transition("a", 20), transition("zero", 0)]);
    expect(catalog.at("world", "region", 0).map((item) => item.transitionId)).toEqual(["zero"]);
    expect(catalog.due("world", "region", 0, 20).map((item) => item.transitionId)).toEqual(["a", "b"]);
    expect(catalog.due("world", "region", 20, 20)).toEqual([]);
  });

  it("verweigert doppelte Kennungen", () => {
    expect(() => new BoundaryTransitionCatalog([transition("same", 1), transition("same", 2)])).toThrow(/eindeutige/);
  });

  it("materialisiert das Betriebsprogramm und seine Aussengrenzen jeden Tag deterministisch neu", () => {
    const enter: RegionalBoundaryTransition = {
      transitionId: "enter",
      worldId: "world",
      regionId: "region",
      atS: 100,
      command: {
        type: "enter-external-zone",
        trainRunId: "train",
        externalLeg: {
          journeyChainId: "chain",
          externalLegId: "external",
          fromPortalId: "portal-a",
          toPortalId: "portal-b",
          scheduledStartS: 100,
          scheduledEndS: 200,
          reentryEarliestS: 190,
          reentryLatestS: 210,
          fixedCostCents: "100",
          boundVehicleIds: ["vehicle"],
          boundPersonnelDutyIds: ["duty"],
          reentryRoute: [{ operatingPoint: "b", positionMm: 10, arrivalS: 200, minimumDwellSeconds: 0, departureS: 200 }],
          firstResources: ["resource"],
        },
      },
    };
    const catalog = new RegionalServiceCatalog("world", "region", 86_400, [{
      trainRunId: "train", operator: "public", trainNumber: "1", category: "regional",
      route: [{ operatingPoint: "a", positionMm: 0, arrivalS: 10, minimumDwellSeconds: 0, departureS: 10 }],
    }], [enter]);
    const due = catalog.due("world", "region", 86_399, 86_500);
    expect(due.find((item) => item.command.type === "materialize")?.command).toMatchObject({
      type: "materialize",
      train: { trainRunId: "train:day-1", baseTrainRunId: "train" },
    });
    const repeated = due.find((item) => item.command.type === "enter-external-zone");
    expect(repeated?.transitionId).toBe("enter:day-1");
    if (repeated?.command.type !== "enter-external-zone") throw new Error("Testaufbau");
    expect(repeated.command.externalLeg.scheduledEndS).toBe(86_600);

    expect(catalog.at("world", "region", 86_400).map((item) => item.transitionId)).toEqual([
      "dematerialize-before:day-1",
      "materialize:train:day-1",
    ]);
    expect(catalog.at("world", "region", 86_500).map((item) => item.transitionId)).toEqual([
      "enter:day-1",
    ]);
  });

  it("materialisiert Tageszuege vor Grenzbefehlen derselben Sekunde", () => {
    const atBoundary: RegionalBoundaryTransition = {
      transitionId: "enter-at-service-start",
      worldId: "world",
      regionId: "region",
      atS: 0,
      command: {
        type: "enter-external-zone",
        trainRunId: "train",
        externalLeg: {
          journeyChainId: "chain",
          externalLegId: "external",
          fromPortalId: "portal-a",
          toPortalId: "portal-b",
          scheduledStartS: 0,
          scheduledEndS: 100,
          reentryEarliestS: 100,
          reentryLatestS: 200,
          fixedCostCents: "0",
          boundVehicleIds: ["vehicle"],
          boundPersonnelDutyIds: ["duty"],
          reentryRoute: [],
          firstResources: [],
        },
      },
    };
    const catalog = new RegionalServiceCatalog("world", "region", 86_400, [{
      trainRunId: "train",
      operator: "public",
      trainNumber: "1",
      category: "regional",
      route: [{ operatingPoint: "a", positionMm: 0, arrivalS: 0, minimumDwellSeconds: 0, departureS: 0 }],
    }], [atBoundary]);

    expect(catalog.at("world", "region", 86_400).map((item) => item.transitionId)).toEqual([
      "dematerialize-before:day-1",
      "materialize:train:day-1",
      "enter-at-service-start:day-1",
    ]);
  });

  it("weist vorgefuellte oder bereits abgeleitete Basisfahrten im signierten Katalog ab", () => {
    const base = {
      trainRunId: "train",
      operator: "public",
      trainNumber: "1",
      category: "regional" as const,
      route: [{ operatingPoint: "a", positionMm: 0, arrivalS: 10, minimumDwellSeconds: 0, departureS: 10 }],
    };
    expect(() => new RegionalServiceCatalog("world", "region", 86_400, [{
      ...base,
      baseTrainRunId: "forged",
    }], [])).toThrow(/Basisbetriebsprogramm/);
    expect(() => new RegionalServiceCatalog("world", "region", 86_400, [{
      ...base,
      trainRunId: "train:day-1",
    }], [])).toThrow(/Basisbetriebsprogramm/);
  });
});
