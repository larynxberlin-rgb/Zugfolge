export function parsePlanningFlexibility(fields: Readonly<Record<string, string>>, defaults: { readonly departureMinutes: number; readonly runningMinutes: number }): {
  readonly departureFlexibilityS: number;
  readonly extraRunningTimeS: number;
} {
  const minutes = (key: string, fallback: number, maximum: number, label: string): number => {
    const raw = fields[key] ?? String(fallback);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > maximum) throw new Error(`${label} muss zwischen 0 und ${maximum} ganzen Minuten liegen.`);
    return Number(raw) * 60;
  };
  return {
    departureFlexibilityS: minutes("departureDelayMinutes", defaults.departureMinutes, 120, "Die spätere Abfahrt"),
    extraRunningTimeS: minutes("extraRunningMinutes", defaults.runningMinutes, 60, "Die zusätzliche Fahrzeit"),
  };
}
