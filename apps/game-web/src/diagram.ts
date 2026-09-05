import type {
  BlockingPhase,
  ConflictKind,
  PlanningConflictProjection,
  PlanningProjectionV1,
  PlanningTimeBasisProjection,
  PlanningTrainProjection,
} from "@zugfolge/planning-projection";

export const phaseLabels: Readonly<Record<BlockingPhase, string>> = {
  "route-setting": "Fahrstraßenbildezeit",
  "signal-sighting": "Signalsichtzeit",
  approach: "Annäherungsfahrzeit",
  running: "Fahrzeit",
  clearing: "Räumfahrzeit",
  "route-release": "Fahrstraßenauflösezeit",
};

export const conflictLabels: Readonly<Record<ConflictKind, string>> = {
  headway: "Zugfolge",
  "opposing-move": "Gegenfahrt",
  "route-exclusion": "Fahrstraßenausschluss",
  "facility-contention": "Anlagenbelegung",
};

function floorMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/** Darstellung einer ganzzahligen Weltsekunde; der Fachwert bleibt unverändert. */
export function formatTimeS(timeS: number, timeBasis?: PlanningTimeBasisProjection): string {
  const operatingDay = Math.floor(timeS / 86_400);
  const secondOfDay = floorMod(timeS, 86_400);
  const hours = Math.floor(secondOfDay / 3_600);
  const minutes = Math.floor((secondOfDay % 3_600) / 60);
  const seconds = secondOfDay % 60;
  const clock = [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  if (timeBasis !== undefined) {
    const instant = new Date(Date.parse(timeBasis.epoch) + timeS * 1_000);
    const parts = Object.fromEntries(new Intl.DateTimeFormat("de-DE", {
      timeZone: timeBasis.timeZone,
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(instant).map((part) => [part.type, part.value]));
    return `D${operatingDay >= 0 ? "+" : ""}${operatingDay} · ${parts["day"]}.${parts["month"]}.${parts["year"]} ${parts["hour"]}:${parts["minute"]}:${parts["second"]}`;
  }
  if (operatingDay === 0) return clock;
  return `D${operatingDay > 0 ? "+" : ""}${operatingDay} ${clock}`;
}

export function formatDurationS(durationS: number): string {
  const absolute = Math.abs(durationS);
  const minutes = Math.floor(absolute / 60);
  const seconds = absolute % 60;
  return `${durationS < 0 ? "−" : ""}${minutes}:${String(seconds).padStart(2, "0")} min`;
}

export function formatSignedShiftS(shiftS: number): string {
  const sign = shiftS < 0 ? "−" : "+";
  return `${sign}${formatDurationS(Math.abs(shiftS))}`;
}

// Jede bestätigte Revision ist ein neues readonly-Projektionsobjekt. WeakMap
// hält ältere Revisionen nicht fest und vermeidet Vollscans je SVG-Koordinate.
const timeExtents = new WeakMap<PlanningProjectionV1, readonly [number, number]>();
const distanceExtents = new WeakMap<PlanningProjectionV1, readonly [number, number]>();

export function timeExtentS(projection: PlanningProjectionV1): readonly [number, number] {
  const cached = timeExtents.get(projection);
  if (cached !== undefined) return cached;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const train of projection.trains) for (const call of train.calls) {
    minimum = Math.min(minimum, call.timeS);
    maximum = Math.max(maximum, call.timeS);
  }
  for (const occupation of projection.occupations) {
    minimum = Math.min(minimum, occupation.startS, occupation.endS);
    maximum = Math.max(maximum, occupation.startS, occupation.endS);
  }
  for (const conflict of projection.conflicts) {
    minimum = Math.min(minimum, conflict.window.startS, conflict.window.endS);
    maximum = Math.max(maximum, conflict.window.startS, conflict.window.endS);
  }
  const from = Math.floor((minimum - 300) / 300) * 300;
  const to = Math.ceil((maximum + 300) / 300) * 300;
  const extent = Object.freeze<readonly [number, number]>(minimum === Infinity ? [0, 3_600] : to > from ? [from, to] : [from, from + 600]);
  timeExtents.set(projection, extent);
  return extent;
}

export function distanceExtentMm(projection: PlanningProjectionV1): readonly [number, number] {
  const cached = distanceExtents.get(projection);
  if (cached !== undefined) return cached;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const station of projection.stations) {
    minimum = Math.min(minimum, station.distanceMm);
    maximum = Math.max(maximum, station.distanceMm);
  }
  for (const occupation of projection.occupations) {
    minimum = Math.min(minimum, occupation.startDistanceMm, occupation.endDistanceMm);
    maximum = Math.max(maximum, occupation.startDistanceMm, occupation.endDistanceMm);
  }
  const extent = Object.freeze<readonly [number, number]>(minimum === Infinity ? [0, 1] : maximum > minimum ? [minimum, maximum] : [minimum, minimum + 1]);
  distanceExtents.set(projection, extent);
  return extent;
}

export function positionY(
  projection: PlanningProjectionV1,
  distanceMm: number,
  height = 460,
): number {
  const [minimum, maximum] = distanceExtentMm(projection);
  return 54 + ((distanceMm - minimum) / (maximum - minimum)) * (height - 92);
}

export function stationY(
  projection: PlanningProjectionV1,
  stationId: string,
  height = 460,
): number {
  const station = projection.stations.find((candidate) => candidate.id === stationId);
  if (station === undefined) throw new Error(`Unbekannte Betriebsstelle: ${stationId}`);
  return positionY(projection, station.distanceMm, height);
}

export function timeX(
  projection: PlanningProjectionV1,
  timeS: number,
  width = 980,
): number {
  const [from, to] = timeExtentS(projection);
  return 150 + ((timeS - from) / (to - from)) * (width - 180);
}

export function pathPoints(
  projection: PlanningProjectionV1,
  train: PlanningTrainProjection,
): string {
  return train.calls
    .map((call) => `${timeX(projection, call.timeS)},${stationY(projection, call.stationId)}`)
    .join(" ");
}

export function conflictsForTrain(
  projection: PlanningProjectionV1,
  trainId: string,
): readonly PlanningConflictProjection[] {
  return projection.conflicts.filter((conflict) => conflict.trainIds.includes(trainId));
}

export function conflictDistanceMm(
  projection: PlanningProjectionV1,
  conflict: PlanningConflictProjection,
): number {
  const matching = projection.occupations.find(
    (occupation) =>
      occupation.resource.id === conflict.resource.id &&
      conflict.trainIds.includes(occupation.trainId),
  );
  if (matching !== undefined) {
    return Math.floor((matching.startDistanceMm + matching.endDistanceMm) / 2);
  }
  const [minimum, maximum] = distanceExtentMm(projection);
  return Math.floor((minimum + maximum) / 2);
}
