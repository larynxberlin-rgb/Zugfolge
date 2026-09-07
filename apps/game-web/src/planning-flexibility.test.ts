import { describe, expect, it } from "vitest";
import { parsePlanningFlexibility } from "./planning-flexibility.js";

describe("Spielraum bei Konflikten", () => {
  it("wandelt Minuten exakt in Sekunden um und verwendet Standardwerte", () => {
    expect(parsePlanningFlexibility({}, { departureMinutes: 30, runningMinutes: 15 })).toEqual({ departureFlexibilityS: 1800, extraRunningTimeS: 900 });
    expect(parsePlanningFlexibility({ departureDelayMinutes: "0", extraRunningMinutes: "0" }, { departureMinutes: 30, runningMinutes: 15 })).toEqual({ departureFlexibilityS: 0, extraRunningTimeS: 0 });
    expect(parsePlanningFlexibility({ departureDelayMinutes: "120", extraRunningMinutes: "60" }, { departureMinutes: 0, runningMinutes: 0 })).toEqual({ departureFlexibilityS: 7200, extraRunningTimeS: 3600 });
  });
  it("verwirft negative, gebrochene, leere und übergroße Eingaben", () => {
    for (const [key, value] of [["departureDelayMinutes", "-1"], ["departureDelayMinutes", "121"], ["departureDelayMinutes", "1.5"], ["extraRunningMinutes", "61"], ["extraRunningMinutes", ""], ["extraRunningMinutes", "1e3"]]) {
      expect(() => parsePlanningFlexibility({ [key!]: value! }, { departureMinutes: 30, runningMinutes: 15 })).toThrow("ganzen Minuten");
    }
  });
});
