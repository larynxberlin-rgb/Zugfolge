import { describe, expect, it } from "vitest";

import { BLOCKING_PHASES, parsePlanningProjection } from "@zugfolge/planning-projection";

import { applyDemoAlternative, demoProjection } from "./demo.js";

describe("expliziter Demomodus", () => {
  it("bleibt ein gueltiger v1-Vertrag mit echter Signalsichtphase statt Puffer", () => {
    expect(parsePlanningProjection(demoProjection)).toEqual(demoProjection);
    expect(new Set(demoProjection.occupations.map((occupation) => occupation.phase))).toEqual(
      new Set(BLOCKING_PHASES),
    );
    expect(demoProjection.occupations.some((occupation) => occupation.phase === "signal-sighting")).toBe(true);
  });

  it("wendet eine Demoalternative unveraenderlich an und laesst unbeteiligte Befunde stehen", () => {
    const originalDeparture = demoProjection.trains[1]!.calls[0]!.timeS;
    const shifted = applyDemoAlternative(demoProjection, "demo-offer-opposing-v1");
    expect(shifted.projectionRevision).toBe(2);
    expect(shifted.trains[1]!.calls[0]!.timeS).toBe(originalDeparture + 420);
    expect(shifted.conflicts.map((conflict) => conflict.id)).toEqual(["demo-conflict-route"]);
    expect(demoProjection.projectionRevision).toBe(1);
    expect(demoProjection.trains[1]!.calls[0]!.timeS).toBe(originalDeparture);
  });
});
