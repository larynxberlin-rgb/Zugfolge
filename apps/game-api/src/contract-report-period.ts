const DAY_MS = 86_400_000;

/** Ein Tagesbeleg darf nur genau einer abgeschlossenen Vertragsperiode dienen. */
export function contractReportPeriod(epoch: Date, startsAtS: number, endsAtS: number): {
  readonly firstServiceDay: string; readonly lastServiceDay: string; readonly expectedServiceDays: number;
} {
  const start = epoch.getTime() + startsAtS * 1_000;
  const end = epoch.getTime() + endsAtS * 1_000;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start
    || start % DAY_MS !== 0 || end % DAY_MS !== 0) {
    throw new Error("Angebrochene Betriebstage brauchen einzelne Fahrtbelege; ganze Tagesberichte duerfen nicht mehrfach abgerechnet werden.");
  }
  return {
    firstServiceDay: new Date(start).toISOString().slice(0, 10),
    lastServiceDay: new Date(end - DAY_MS).toISOString().slice(0, 10),
    expectedServiceDays: (end - start) / DAY_MS,
  };
}
