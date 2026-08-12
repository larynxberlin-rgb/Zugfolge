import { describe, expect, it } from "vitest";

import { compileJourneyChains, type JourneyChainStopInput } from "./journey-chain.js";

const stop = (
  stopId: string,
  stopSequence: number,
  arrivalS: number,
  departureS: number,
  inRegion: boolean,
): JourneyChainStopInput => ({ stopId, stopName: stopId, stopSequence, arrivalS, departureS, inRegion });

function compile(stops: readonly JourneyChainStopInput[], portals = [
  { portalId: "west", stopId: "W", label: "Westportal" },
  { portalId: "east", stopId: "E", label: "Ostportal" },
]) {
  return compileJourneyChains({
    worldId: "world-mitteldeutschland",
    regionId: "mitteldeutschland-b",
    releaseId: "gtfs-2026",
    specificationVersion: "external-leg-cost/v1",
    boundaryWindowToleranceS: 300,
    fixedExternalCostCentsPerMinute: 25,
    portals,
    trips: [{
      sourceTripId: "trip-1",
      serviceId: "daily",
      routeId: "RE1",
      routeShortName: "RE 1",
      headsign: "Fernziel",
      directionId: "0",
      stops,
    }],
  });
}

describe("GTFS JourneyChain", () => {
  it("bewahrt einen Zuglauf ausserhalb-innerhalb-ausserhalb ohne falschen Linienabschluss", () => {
    const result = compile([
      stop("A", 1, 28_000, 28_060, false),
      stop("W", 2, 28_600, 28_660, true),
      stop("M", 3, 29_200, 29_260, true),
      stop("E", 4, 29_800, 29_860, true),
      stop("Z", 5, 30_400, 30_460, false),
    ]);
    const chain = result.chains[0]!;
    expect(chain.orderable).toBe(true);
    expect(chain.legs.map((leg) => leg.kind)).toEqual(["external", "playable", "external"]);
    expect(chain.legs[1]).toMatchObject({
      entryPortalId: "west",
      exitPortalId: "east",
      qualityClass: "B",
      orderable: true,
      planningWindows: [
        { direction: "entry", targetS: 28_660, earliestS: 28_360, latestS: 28_960 },
        { direction: "exit", targetS: 29_800, earliestS: 29_500, latestS: 30_100 },
      ],
    });
    expect(chain.legs[2]).toMatchObject({
      dispatchable: false,
      vehicleBindingRequired: true,
      personnelBindingRequired: true,
      fixedCostCents: "225",
    });
  });

  it("unterstuetzt Ausfahrt und spaetere Wiedereinfahrt als dieselbe Fahrt", () => {
    const result = compile([
      stop("W", 1, 10_000, 10_060, true),
      stop("I1", 2, 10_600, 10_660, true),
      stop("X1", 3, 11_000, 11_060, false),
      stop("X2", 4, 11_600, 11_660, false),
      stop("E", 5, 12_000, 12_060, true),
      stop("I2", 6, 12_600, 12_660, true),
    ], [
      { portalId: "out", stopId: "I1", label: "Ausfahrt" },
      { portalId: "in", stopId: "E", label: "Einfahrt" },
    ]);
    expect(result.chains[0]!.legs.map((leg) => leg.kind)).toEqual(["playable", "external", "playable"]);
    expect(result.chains[0]!.legs[1]).toMatchObject({ fromPortalId: "out", toPortalId: "in" });
    expect(result.chains[0]!.orderable).toBe(true);
  });

  it("qualifiziert ein Portal auch dann, wenn der Grenzbahnhof geometrisch knapp ausserhalb liegt", () => {
    const result = compile([
      stop("W", 1, 9_900, 10_000, false),
      stop("I1", 2, 10_600, 10_660, true),
      stop("I2", 3, 11_200, 11_260, true),
      stop("E", 4, 11_800, 11_900, false),
    ]);
    expect(result.chains[0]).toMatchObject({ orderable: true });
    expect(result.chains[0]!.legs[1]).toMatchObject({
      kind: "playable",
      qualityClass: "B",
      entryPortalId: "west",
      exitPortalId: "east",
    });
    expect(result.chains[0]!.legs[0]).toMatchObject({ toPortalId: "west" });
    expect(result.chains[0]!.legs[2]).toMatchObject({ fromPortalId: "east" });
  });

  it("macht einen unbenannten Grenzschnitt sichtbar, aber nicht bestellbar", () => {
    const result = compile([
      stop("A", 1, 10_000, 10_060, false),
      stop("U", 2, 10_600, 10_660, true),
      stop("M", 3, 11_200, 11_260, true),
    ], []);
    expect(result.chains[0]).toMatchObject({ orderable: false });
    expect(result.chains[0]!.legs[1]).toMatchObject({ kind: "playable", qualityClass: "C", orderable: false });
    expect(result.metrics).toMatchObject({ unresolvedBoundaryCount: 1, orderableJourneyChainCount: 0 });
  });

  it("ist unabhaengig von der Eingabereihenfolge deterministisch", () => {
    const base = compile([
      stop("W", 1, 10_000, 10_060, true),
      stop("E", 2, 10_600, 10_660, true),
    ]);
    const again = compile([
      stop("W", 1, 10_000, 10_060, true),
      stop("E", 2, 10_600, 10_660, true),
    ], [
      { portalId: "east", stopId: "E", label: "Ostportal" },
      { portalId: "west", stopId: "W", label: "Westportal" },
    ]);
    expect(again).toEqual(base);
  });
});
