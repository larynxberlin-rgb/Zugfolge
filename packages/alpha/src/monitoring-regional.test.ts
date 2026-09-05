import { describe, expect, it } from "vitest";
import { regionalMonitoringSummary } from "./monitoring-regional.js";

describe("Operational-v2-Monitoringanbindung", () => {
  it("liest Zuege, aktive La und den aeltesten echten Regionscommit", () => {
    const summary = regionalMonitoringSummary([
      { schemaVersion: "zugfolge-operational-simulation-state/v2", world: { nowMs: 180_999, trains: { a: {}, b: {} }, activeDisruptions: { la: { "speed-restriction": { maximumSpeedMmps: 10_000 } } } } },
      { schemaVersion: "zugfolge-operational-simulation-state/v2", world: { nowMs: 120_000, trains: { c: {} }, activeDisruptions: {} } },
    ]);
    expect(summary).toEqual({ simulationTimeS: 120, authoritativeTimeAvailable: true, unavailableRegions: 0, runningTrains: 3, disruptions: 1, delayedTrains: null, cancelledTrains: null });
  });
  it("ersetzt fehlende oder ungueltige Regionen nicht durch Sollzeit", () => {
    expect(regionalMonitoringSummary([])).toMatchObject({ simulationTimeS: 0, authoritativeTimeAvailable: false });
    expect(regionalMonitoringSummary([{ schemaVersion: "zugfolge-operational-simulation-state/v2", world: { nowMs: -1 } }])).toMatchObject({ authoritativeTimeAvailable: false, unavailableRegions: 1 });
    expect(regionalMonitoringSummary([{ schemaVersion: "unbekannt" }])).toMatchObject({ authoritativeTimeAvailable: false, unavailableRegions: 1 });
  });
  it("erfindet aus dem alten Replayzustand keine leere laufende Welt", () => {
    expect(regionalMonitoringSummary([{ schemaVersion: "zugfolge-regional-simulation-state/v1", nowS: 120, initialTrains: [{ id: "a" }], commands: [] }]))
      .toEqual({ simulationTimeS: 120, authoritativeTimeAvailable: true, unavailableRegions: 0, runningTrains: null, disruptions: null, delayedTrains: null, cancelledTrains: null });
  });
});
