import { describe, expect, it } from "vitest";
import { externalStatusLabel, operatingStatusLabel, railwayPlaceLabel, visibleExternalTrains } from "./presentation.js";
import type { PublicExternalTrain } from "./protocol.js";

function external(overrides: Partial<PublicExternalTrain> = {}): PublicExternalTrain {
  return { id: "run-1", operator: "EVU", trainNumber: "RE 1", category: "RE", journeyChainId: "chain", externalLegId: "leg", fromPortalId: "lutherstadt-wittenberg-hbf", toPortalId: null, scheduledEndS: 100, reentryEarliestS: null, reentryLatestS: null, delaySeconds: 0, status: "outside", progressBasisPoints: 5000, ...overrides };
}

describe("Livemap-Praesentation", () => {
  it("zeigt technische Kennungen und Status als verständliches Deutsch", () => {
    expect(railwayPlaceLabel("lutherstadt-wittenberg-hbf")).toBe("Lutherstadt Wittenberg Hbf");
    expect(railwayPlaceLabel("External Origin:el C2909f16ec8123d82ddc188f")).toBe("Außenherkunft");
    expect(railwayPlaceLabel(" External-Origin:el C2909f16ec8123d82ddc188f ")).toBe("Außenherkunft");
    expect(railwayPlaceLabel("external destination:el 0123456789abcdef")).toBe("Außenziel");
    expect(operatingStatusLabel("at_platform")).toBe("am Bahnsteig");
    expect(externalStatusLabel("waiting-for-capacity")).toBe("wartet auf freie Kapazität");
  });

  it("entfernt beendete und doppelte Außenläufe, ohne verschiedene Beine zusammenzufassen", () => {
    const visible = visibleExternalTrains([
      external(),
      external({ id: "run-2", scheduledEndS: 120 }),
      external({ id: "done", externalLegId: "done", status: "completed-outside" }),
      external({ id: "other", externalLegId: "leg-2" }),
    ]);
    expect(visible.map((train) => train.id)).toEqual(["other", "run-2"]);
  });
});
