import type {
  BlockingPhase,
  ConflictKind,
  PlanningConflictProjection,
  PlanningProjectionV1,
  PlanningTrainProjection,
} from "@zugfolge/planning-projection";

export const phaseLabels: Readonly<Record<BlockingPhase, string>> = {
  "route-setting": "Fahrstrassenbildezeit",
  "signal-sighting": "Signalsichtzeit",
  approach: "Annaeherungsfahrzeit",
  running: "Fahrzeit",
  clearing: "Raeumfahrzeit",
  "route-release": "Fahrstrassenaufloesezeit",
};

export const conflictLabels: Readonly<Record<ConflictKind, string>> = {
  headway: "Zugfolge",
  "opposing-move": "Gegenfahrt",
  "route-exclusion": "Fahrstrassenausschluss",
  "facility-contention": "Anlagenbelegung",
};

function floorMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/** Darstellung einer ganzzahligen Weltsekunde; der Fachwert bleibt unveraendert. */
export function formatTimeS(timeS: number): string {
  const secondOfDay = floorMod(timeS, 86_400);
  const hours = Math.floor(secondOfDay / 3_600);
  const minutes = Math.floor((secondOfDay % 3_600) / 60);
  const seconds = secondOfDay % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
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

export function timeExtentS(projection: PlanningProjectionV1): readonly [number, number] {
  const values = [
    ...projection.trains.flatMap((train) => train.calls.map((call) => call.timeS)),
    ...projection.occupations.flatMap((occupation) => [occupation.startS, occupation.endS]),
    ...projection.conflicts.flatMap((conflict) => [conflict.window.startS, conflict.window.endS]),
  ];
  if (values.length === 0) return [0, 3_600];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const from = Math.floor((minimum - 300) / 300) * 300;
  const to = Math.ceil((maximum + 300) / 300) * 300;
  return to > from ? [from, to] : [from, from + 600];
}

export function distanceExtentMm(projection: PlanningProjectionV1): readonly [number, number] {
  const values = [
    ...projection.stations.map((station) => station.distanceMm),
    ...projection.occupations.flatMap((occupation) => [
      occupation.startDistanceMm,
      occupation.endDistanceMm,
    ]),
  ];
  if (values.length === 0) return [0, 1];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return maximum > minimum ? [minimum, maximum] : [minimum, minimum + 1];
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
