import { expect, it } from "vitest";
import { contractReportPeriod } from "./contract-report-period.js";

it("ordnet angrenzenden Perioden auch ueber den Jahreswechsel disjunkte Betriebstage zu", () => {
  const epoch = new Date("2026-12-31T00:00:00Z");
  expect(contractReportPeriod(epoch, 0, 86_400)).toEqual({ firstServiceDay: "2026-12-31", lastServiceDay: "2026-12-31", expectedServiceDays: 1 });
  expect(contractReportPeriod(epoch, 86_400, 3 * 86_400)).toEqual({ firstServiceDay: "2027-01-01", lastServiceDay: "2027-01-02", expectedServiceDays: 2 });
});

it("verweigert doppelt nutzbare Randtage und eine gegenueber UTC verschobene Weltepoche", () => {
  for (const [epoch, start, end] of [
    ["2026-01-01T00:00:00Z", 1, 86_401],
    ["2026-01-01T00:00:00Z", 0, 86_401],
    ["2026-01-01T00:00:00Z", 86_401, 2 * 86_400],
    ["2026-01-01T01:00:00Z", 0, 86_400],
  ] as const) expect(() => contractReportPeriod(new Date(epoch), start, end)).toThrow(/einzelne Fahrtbelege/u);
});
