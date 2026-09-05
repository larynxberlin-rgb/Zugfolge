function object(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

/** Ausschliesslich persistierte Werte; eine Wandzeit ist kein Simulationsfortschritt. */
export function regionalMonitoringSummary(states: readonly unknown[]) {
  let runningTrains = 0;
  let disruptions = 0;
  let liveCountsAvailable = states.length > 0;
  const times: number[] = [];
  let unavailableRegions = 0;
  for (const input of states) {
    const state = object(input);
    if (state["schemaVersion"] === "zugfolge-operational-simulation-state/v2") {
      const world = object(state["world"]);
      const nowMs = world["nowMs"];
      if (!Number.isSafeInteger(nowMs) || (nowMs as number) < 0) { unavailableRegions++; continue; }
      times.push(Math.floor((nowMs as number) / 1_000));
      runningTrains += Object.keys(object(world["trains"])).length;
      disruptions += Object.keys(object(world["activeDisruptions"])).length;
    } else if (state["schemaVersion"] === "zugfolge-regional-simulation-state/v1") {
      const nowS = state["nowS"];
      if (!Number.isSafeInteger(nowS) || (nowS as number) < 0) { unavailableRegions++; continue; }
      times.push(nowS as number);
      // Der alte Replayzustand speichert initialTrains + commands, keinen Live-Snapshot.
      liveCountsAvailable = false;
    } else { unavailableRegions++; }
  }
  const authoritativeTimeAvailable = states.length > 0 && unavailableRegions === 0;
  return {
    simulationTimeS: authoritativeTimeAvailable ? Math.min(...times) : 0,
    authoritativeTimeAvailable,
    unavailableRegions,
    runningTrains: liveCountsAvailable && unavailableRegions === 0 ? runningTrains : null,
    disruptions: liveCountsAvailable && unavailableRegions === 0 ? disruptions : null,
    // Die nativen Zustaende liefern noch keine autoritativen Betriebsabschluesse (#518).
    delayedTrains: null,
    cancelledTrains: null,
  };
}
