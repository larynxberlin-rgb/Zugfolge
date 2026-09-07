export const PLANNING_PROJECTION_SCHEMA_VERSION = "planning-projection/v1" as const;
export const PLANNING_ALTERNATIVE_COMMAND_SCHEMA_VERSION =
  "planning-alternative-command/v1" as const;

export const BLOCKING_PHASES = [
  "route-setting",
  "signal-sighting",
  "approach",
  "running",
  "clearing",
  "route-release",
] as const;

export const CONFLICT_KINDS = [
  "headway",
  "opposing-move",
  "route-exclusion",
  "facility-contention",
] as const;

export const CONFLICT_RESOURCE_KINDS = ["block", "track", "route", "facility"] as const;
export const TRAVEL_DIRECTIONS = ["with-chainage", "against-chainage"] as const;

export type BlockingPhase = (typeof BLOCKING_PHASES)[number];
export type ConflictKind = (typeof CONFLICT_KINDS)[number];
export type ConflictResourceKind = (typeof CONFLICT_RESOURCE_KINDS)[number];
export type TravelDirection = (typeof TRAVEL_DIRECTIONS)[number];

export interface PlanningCorridorProjection {
  readonly id: string;
  readonly name: string;
}

export interface PlanningStationProjection {
  readonly id: string;
  readonly name: string;
  /** Ganzzahlige Entfernung vom Korridoranfang. */
  readonly distanceMm: number;
}

export interface PlanningTrainCallProjection {
  readonly stationId: string;
  /** Ganzzahlige Sekunde seit Weltepoche. */
  readonly timeS: number;
}

export interface PlanningAdjustmentProjection {
  readonly kind: "departure-shift" | "operational-stop" | "dwell-extension" | "running-time-extension";
  readonly stationId: string;
  /** Abfahrt: absolute Weltsekunden; Halte: Aufenthalt; Fahrzeit: gesamte Fahrtdauer. */
  readonly requestedS: number;
  readonly plannedS: number;
  readonly explanation: string;
}

/** Vollständiger, geordneter Betriebsstellenlauf aus einem nativen Fahrprofil. */
export interface PlanningTimelineCallProjection {
  readonly stationId: string;
  readonly arrivalS: number;
  readonly departureS: number;
  readonly kind: "origin" | "destination" | "passenger-stop" | "operational-stop" | "pass";
}

export interface PlanningTimelineProjection {
  readonly requested: readonly PlanningTimelineCallProjection[];
  /** Ohne Zuteilung oder konkreten Vorschlag fehlen tatsächliche Planzeiten. */
  readonly planned: readonly PlanningTimelineCallProjection[] | null;
}

/** Native Kandidatenfakten; eine vorgeschlagene Alternative ist noch nicht zugeteilt. */
export interface PlanningResultProjection {
  readonly status: "requested" | "proposed" | "allocated" | "rejected";
  readonly requestedDepartureS: number;
  readonly plannedDepartureS: number | null;
  readonly adjustments: readonly PlanningAdjustmentProjection[];
  readonly routeChange?: { readonly additionalDistanceMm: number; readonly explanation: string };
  /** Fehlt bei älteren Projektionen; Zwischenzeiten werden dann nicht rekonstruiert. */
  readonly timeline?: PlanningTimelineProjection;
}

export interface PlanningTrainProjection {
  readonly id: string;
  readonly number: string;
  readonly direction: TravelDirection;
  readonly calls: readonly PlanningTrainCallProjection[];
  /** Nicht bearbeitbare Randbedingungen einer gebietsueberschreitenden Fahrt. */
  readonly boundaryWindows?: readonly PlanningBoundaryWindowProjection[];
  /** Fehlt bei historischen Projektionen ohne belegten Wunsch-/Planvergleich. */
  readonly planning?: PlanningResultProjection;
}

export interface PlanningBoundaryWindowProjection {
  readonly windowId: string;
  readonly portalId: string;
  readonly direction: "entry" | "exit";
  readonly earliestS: number;
  readonly targetS: number;
  readonly latestS: number;
}

export interface PlanningConflictResourceProjection {
  readonly id: string;
  readonly kind: ConflictResourceKind;
  readonly label: string;
}

export interface PlanningOccupationProjection {
  readonly trainId: string;
  readonly resource: PlanningConflictResourceProjection;
  readonly governingStationId: string;
  readonly phase: BlockingPhase;
  /** Halboffenes Zeitintervall [startS, endS), in ganzzahligen Sekunden. */
  readonly startS: number;
  readonly endS: number;
  /** Ganzzahlige Positionen entlang des Korridors. */
  readonly startDistanceMm: number;
  readonly endDistanceMm: number;
}

export interface PlanningConflictWindowProjection {
  readonly startS: number;
  readonly endS: number;
}

export interface PlanningAlternativeProjection {
  /** Serverautoritaere, ueber Revisionen hinweg stabile Angebotskennung. */
  readonly alternativeId: string;
  readonly trainId: string;
  readonly departureShiftS: number;
  readonly explanation: string;
  readonly planning?: PlanningResultProjection;
}

export interface PlanningConflictProjection {
  readonly id: string;
  readonly kind: ConflictKind;
  readonly resource: PlanningConflictResourceProjection;
  readonly window: PlanningConflictWindowProjection;
  readonly trainIds: readonly [string, string];
  readonly explanation: string;
  /** Eine Ablehnung kann bewusst ohne zulassige Alternative projiziert werden. */
  readonly alternative: PlanningAlternativeProjection | null;
}

export interface PlanningProjectionV1 {
  readonly schemaVersion: typeof PLANNING_PROJECTION_SCHEMA_VERSION;
  /** Monotone fachliche Revision; die Eventlog-Sequenz ist dafuer kein Ersatz. */
  readonly projectionRevision: number;
  readonly worldId: string;
  readonly corridor: PlanningCorridorProjection;
  readonly stations: readonly PlanningStationProjection[];
  readonly trains: readonly PlanningTrainProjection[];
  readonly occupations: readonly PlanningOccupationProjection[];
  readonly conflicts: readonly PlanningConflictProjection[];
  /** Reiner Anzeigevertrag; wird vom API-Envelope serverseitig ergänzt. */
  readonly timeBasis?: PlanningTimeBasisProjection;
}

export interface PlanningTimeBasisProjection {
  readonly epoch: string;
  readonly timeZone: "Europe/Berlin";
  readonly operatingDayBoundaryS: 0;
}

export interface PlanningProjectionEnvelopeV1 {
  /** Transportsequenz des Eventlogs; nicht fuer fachliche Aktualitaet verwenden. */
  readonly sequence: number;
  readonly timeBasis: PlanningTimeBasisProjection;
  readonly data: PlanningProjectionV1;
}

export interface PlanningAlternativeCommandV1 {
  readonly schemaVersion: typeof PLANNING_ALTERNATIVE_COMMAND_SCHEMA_VERSION;
  readonly projectionRevision: number;
  readonly alternativeId: string;
  readonly idempotencyKey: string;
}

export class PlanningProjectionValidationError extends Error {
  constructor(readonly path: string, expected: string) {
    super(`Ungueltige Planner-Projektion bei ${path}: ${expected}.`);
    this.name = "PlanningProjectionValidationError";
  }
}

type JsonRecord = Record<string, unknown>;

function fail(path: string, expected: string): never {
  throw new PlanningProjectionValidationError(path, expected);
}

function record(value: unknown, path: string, keys: readonly string[]): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path, "Objekt erwartet");
  }
  const result = value as JsonRecord;
  const actualKeys = Object.keys(result);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => !keys.includes(key))
  ) {
    return fail(path, `genau die Felder ${keys.join(", ")} erwartet`);
  }
  return result;
}

function stringValue(value: unknown, path: string, maximumLength = 256): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength
  ) {
    return fail(path, `nichtleere Zeichenkette mit hoechstens ${maximumLength} Zeichen erwartet`);
  }
  return value;
}

function integerValue(value: unknown, path: string, minimum = Number.MIN_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return fail(path, `sichere ganze Zahl ab ${minimum} erwartet`);
  }
  return value as number;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  path: string,
  values: Values,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    return fail(path, `einer der Werte ${values.join(", ")} erwartet`);
  }
  return value as Values[number];
}

function arrayValue(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) return fail(path, "Liste erwartet");
  return value;
}

function resourceValue(value: unknown, path: string): PlanningConflictResourceProjection {
  const input = record(value, path, ["id", "kind", "label"]);
  return {
    id: stringValue(input["id"], `${path}.id`, 128),
    kind: enumValue(input["kind"], `${path}.kind`, CONFLICT_RESOURCE_KINDS),
    label: stringValue(input["label"], `${path}.label`),
  };
}

function assertUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, "eindeutige Kennungen erwartet");
}

function timelineCallsValue(value: unknown, path: string, stationIds: ReadonlySet<string>, departureS: number): readonly PlanningTimelineCallProjection[] {
  const rows = arrayValue(value, path);
  if (rows.length < 2 || rows.length > 512) fail(path, "vollstaendiger Lauf mit 2 bis 512 Betriebsstellen erwartet");
  const calls = rows.map((value, index) => {
    const callPath = `${path}[${index}]`;
    const item = record(value, callPath, ["stationId", "arrivalS", "departureS", "kind"]);
    const stationId = stringValue(item["stationId"], `${callPath}.stationId`, 128);
    if (!stationIds.has(stationId)) fail(`${callPath}.stationId`, "bekannte Betriebsstelle erwartet");
    const arrivalS = integerValue(item["arrivalS"], `${callPath}.arrivalS`, 0);
    const departureS = integerValue(item["departureS"], `${callPath}.departureS`, 0);
    const kind = enumValue(item["kind"], `${callPath}.kind`, ["origin", "destination", "passenger-stop", "operational-stop", "pass"] as const);
    if (arrivalS > departureS || (kind === "operational-stop" && arrivalS === departureS)
      || ((kind === "origin" || kind === "destination" || kind === "pass") && arrivalS !== departureS)) {
      fail(callPath, "Ankunft vor Abfahrt, Aufenthalt bei Betriebshalt und identische Zeiten an Start, Ziel und Durchfahrt erwartet");
    }
    if ((index === 0) !== (kind === "origin") || (index === rows.length - 1) !== (kind === "destination")) {
      fail(`${callPath}.kind`, "Start nur am Anfang und Ziel nur am Ende des Laufs erwartet");
    }
    return { stationId, arrivalS, departureS, kind };
  });
  assertUnique(calls.map((call) => call.stationId), `${path}[].stationId`);
  if (calls[0]!.departureS !== departureS) fail(path, "Lauf muss an der belegten Abfahrt beginnen");
  if (calls.some((call, index) => index > 0 && call.arrivalS < calls[index - 1]!.departureS)) {
    fail(path, "chronologischer Lauf ohne Rueckspruenge erwartet");
  }
  return calls;
}

function planningResultValue(value: unknown, path: string, stationIds: ReadonlySet<string>): PlanningResultProjection {
  const input = record(value, path, ["status", "requestedDepartureS", "plannedDepartureS", "adjustments",
    ...(typeof value === "object" && value !== null && "routeChange" in value ? ["routeChange"] : []),
    ...(typeof value === "object" && value !== null && "timeline" in value ? ["timeline"] : [])]);
  const status = enumValue(input["status"], `${path}.status`, ["requested", "proposed", "allocated", "rejected"] as const);
  const requestedDepartureS = integerValue(input["requestedDepartureS"], `${path}.requestedDepartureS`, 0);
  const plannedDepartureS = input["plannedDepartureS"] === null ? null
    : integerValue(input["plannedDepartureS"], `${path}.plannedDepartureS`, 0);
  if ((status === "allocated" || status === "proposed") !== (plannedDepartureS !== null)) {
    fail(`${path}.plannedDepartureS`, "Planzeit nur fuer zugeteilte oder vorgeschlagene Trasse erwartet");
  }
  const adjustments = arrayValue(input["adjustments"], `${path}.adjustments`).map((value, index) => {
    const changePath = `${path}.adjustments[${index}]`;
    const item = record(value, changePath, ["kind", "stationId", "requestedS", "plannedS", "explanation"]);
    const kind = enumValue(item["kind"], `${changePath}.kind`, ["departure-shift", "operational-stop", "dwell-extension", "running-time-extension"] as const);
    const stationId = stringValue(item["stationId"], `${changePath}.stationId`, 128);
    if (!stationIds.has(stationId)) fail(`${changePath}.stationId`, "bekannte Betriebsstelle erwartet");
    const requestedS = integerValue(item["requestedS"], `${changePath}.requestedS`, 0);
    const plannedS = integerValue(item["plannedS"], `${changePath}.plannedS`, 0);
    if (requestedS === plannedS || (kind !== "departure-shift" && plannedS < requestedS)
      || (kind === "operational-stop" && requestedS !== 0)) {
      fail(changePath, "tatsaechliche Abfahrtsaenderung, zusaetzlicher Betriebshalt oder verlaengerter Aufenthalt erwartet");
    }
    if (kind === "departure-shift" && (requestedS !== requestedDepartureS || plannedS !== plannedDepartureS)) {
      fail(changePath, "Abfahrtsaenderung muss die belegten Wunsch- und Planzeiten vergleichen");
    }
    return { kind, stationId, requestedS, plannedS, explanation: stringValue(item["explanation"], `${changePath}.explanation`, 2_048) };
  });
  if (adjustments.length > 514 || (plannedDepartureS === null && adjustments.length !== 0)) {
    fail(`${path}.adjustments`, "begrenzte Aenderungsliste nur mit belegter Planzeit erwartet");
  }
  assertUnique(adjustments.map((change) => `${change.kind}:${change.stationId}`), `${path}.adjustments`);
  const departureChanges = adjustments.filter((change) => change.kind === "departure-shift");
  if (departureChanges.length > 1 || (plannedDepartureS !== null && plannedDepartureS !== requestedDepartureS && departureChanges.length !== 1)) {
    fail(`${path}.adjustments`, "genau ein Beleg fuer eine geaenderte Abfahrt erwartet");
  }
  let routeChange: PlanningResultProjection["routeChange"];
  if (Object.hasOwn(input, "routeChange")) {
    if (plannedDepartureS === null) fail(`${path}.routeChange`, "Fahrweganpassung nur fuer vorgeschlagene oder zugeteilte Trasse erwartet");
    const route = record(input["routeChange"], `${path}.routeChange`, ["additionalDistanceMm", "explanation"]);
    routeChange = { additionalDistanceMm: integerValue(route["additionalDistanceMm"], `${path}.routeChange.additionalDistanceMm`, 1),
      explanation: stringValue(route["explanation"], `${path}.routeChange.explanation`, 2_048) };
  }
  let timeline: PlanningTimelineProjection | undefined;
  if (Object.hasOwn(input, "timeline")) {
    const timelinePath = `${path}.timeline`;
    const item = record(input["timeline"], timelinePath, ["requested", "planned"]);
    const requested = timelineCallsValue(item["requested"], `${timelinePath}.requested`, stationIds, requestedDepartureS);
    if ((item["planned"] === null) !== (plannedDepartureS === null)) {
      fail(`${timelinePath}.planned`, "Planlauf nur bei konkretem Vorschlag oder Zuteilung erwartet");
    }
    const planned = item["planned"] === null ? null
      : timelineCallsValue(item["planned"], `${timelinePath}.planned`, stationIds, plannedDepartureS!);
    if (planned !== null && (planned[0]!.stationId !== requested[0]!.stationId || planned.at(-1)!.stationId !== requested.at(-1)!.stationId)) {
      fail(timelinePath, "identische Start- und Zielbetriebsstellen erwartet");
    }
    timeline = { requested, planned };
  }
  return { status, requestedDepartureS, plannedDepartureS, adjustments, ...(routeChange === undefined ? {} : { routeChange }),
    ...(timeline === undefined ? {} : { timeline }) };
}

function parseProjectionUnchecked(value: unknown): PlanningProjectionV1 {
  const input = record(value, "$", [
    "schemaVersion",
    "projectionRevision",
    "worldId",
    "corridor",
    "stations",
    "trains",
    "occupations",
    "conflicts",
  ]);
  if (input["schemaVersion"] !== PLANNING_PROJECTION_SCHEMA_VERSION) {
    fail("$.schemaVersion", PLANNING_PROJECTION_SCHEMA_VERSION);
  }

  const corridorInput = record(input["corridor"], "$.corridor", ["id", "name"]);
  const stations = arrayValue(input["stations"], "$.stations").map((station, index) => {
    const path = `$.stations[${index}]`;
    const item = record(station, path, ["id", "name", "distanceMm"]);
    return {
      id: stringValue(item["id"], `${path}.id`, 128),
      name: stringValue(item["name"], `${path}.name`),
      distanceMm: integerValue(item["distanceMm"], `${path}.distanceMm`, 0),
    };
  });
  assertUnique(stations.map((station) => station.id), "$.stations[].id");
  const stationIds = new Set(stations.map((station) => station.id));

  const trains = arrayValue(input["trains"], "$.trains").map((train, index) => {
    const path = `$.trains[${index}]`;
    const trainKeys = ["id", "number", "direction", "calls"];
    const trainRecord = train as Readonly<Record<string, unknown>>;
    if (typeof train === "object" && train !== null && !Array.isArray(train) && "boundaryWindows" in trainRecord) {
      trainKeys.push("boundaryWindows");
    }
    if (typeof train === "object" && train !== null && !Array.isArray(train) && "planning" in trainRecord) trainKeys.push("planning");
    const item = record(train, path, trainKeys);
    const calls = arrayValue(item["calls"], `${path}.calls`).map((call, callIndex) => {
      const callPath = `${path}.calls[${callIndex}]`;
      const callItem = record(call, callPath, ["stationId", "timeS"]);
      const stationId = stringValue(callItem["stationId"], `${callPath}.stationId`, 128);
      if (!stationIds.has(stationId)) fail(`${callPath}.stationId`, "bekannte Betriebsstelle erwartet");
      return {
        stationId,
        timeS: integerValue(callItem["timeS"], `${callPath}.timeS`, 0),
      };
    });
    if (calls.length === 0) fail(`${path}.calls`, "mindestens ein Fahrplanpunkt erwartet");
    const boundaryWindows = item["boundaryWindows"] === undefined
      ? undefined
      : arrayValue(item["boundaryWindows"], `${path}.boundaryWindows`).map((window, windowIndex) => {
        const windowPath = `${path}.boundaryWindows[${windowIndex}]`;
        const windowItem = record(window, windowPath, [
          "windowId", "portalId", "direction", "earliestS", "targetS", "latestS",
        ]);
        const earliestS = integerValue(windowItem["earliestS"], `${windowPath}.earliestS`, 0);
        const targetS = integerValue(windowItem["targetS"], `${windowPath}.targetS`, 0);
        const latestS = integerValue(windowItem["latestS"], `${windowPath}.latestS`, 0);
        if (earliestS > targetS || targetS > latestS) {
          fail(windowPath, "monotones Grenzfenster erwartet");
        }
        return {
          windowId: stringValue(windowItem["windowId"], `${windowPath}.windowId`, 128),
          portalId: stringValue(windowItem["portalId"], `${windowPath}.portalId`, 128),
          direction: enumValue(windowItem["direction"], `${windowPath}.direction`, ["entry", "exit"] as const),
          earliestS,
          targetS,
          latestS,
        };
      });
    if (boundaryWindows !== undefined) {
      assertUnique(boundaryWindows.map((window) => window.windowId), `${path}.boundaryWindows[].windowId`);
      assertUnique(boundaryWindows.map((window) => window.direction), `${path}.boundaryWindows[].direction`);
    }
    const planning = item["planning"] === undefined ? undefined : planningResultValue(item["planning"], `${path}.planning`, stationIds);
    if (planning?.status === "proposed") fail(`${path}.planning.status`, "Vorschlag gehoert zur Alternative, nicht zur dargestellten Zugtrasse");
    if (planning?.status === "allocated" && planning.plannedDepartureS !== calls[0]?.timeS) {
      fail(`${path}.planning.plannedDepartureS`, "Planabfahrt muss mit dem dargestellten Zuglauf uebereinstimmen");
    }
    const timelineCalls = planning?.timeline?.planned ?? planning?.timeline?.requested;
    if (timelineCalls !== undefined && (timelineCalls[0]!.stationId !== calls[0]!.stationId
      || timelineCalls.at(-1)!.stationId !== calls.at(-1)!.stationId
      || timelineCalls[0]!.departureS !== calls[0]!.timeS || timelineCalls.at(-1)!.arrivalS !== calls.at(-1)!.timeS)) {
      fail(`${path}.planning.timeline`, "Endpunkte und Zeiten muessen mit dem dargestellten Zuglauf uebereinstimmen");
    }
    return {
      id: stringValue(item["id"], `${path}.id`, 128),
      number: stringValue(item["number"], `${path}.number`, 64),
      direction: enumValue(item["direction"], `${path}.direction`, TRAVEL_DIRECTIONS),
      calls,
      ...(boundaryWindows === undefined ? {} : { boundaryWindows }),
      ...(planning === undefined ? {} : { planning }),
    };
  });
  assertUnique(trains.map((train) => train.id), "$.trains[].id");
  const trainIds = new Set(trains.map((train) => train.id));

  const occupations = arrayValue(input["occupations"], "$.occupations").map(
    (occupation, index) => {
      const path = `$.occupations[${index}]`;
      const item = record(occupation, path, [
        "trainId",
        "resource",
        "governingStationId",
        "phase",
        "startS",
        "endS",
        "startDistanceMm",
        "endDistanceMm",
      ]);
      const trainId = stringValue(item["trainId"], `${path}.trainId`, 128);
      if (!trainIds.has(trainId)) fail(`${path}.trainId`, "bekannte Zugfahrt erwartet");
      const governingStationId = stringValue(
        item["governingStationId"],
        `${path}.governingStationId`,
        128,
      );
      if (!stationIds.has(governingStationId)) {
        fail(`${path}.governingStationId`, "bekannte Betriebsstelle erwartet");
      }
      const startS = integerValue(item["startS"], `${path}.startS`, 0);
      const endS = integerValue(item["endS"], `${path}.endS`, 0);
      if (endS < startS) fail(`${path}.endS`, "Wert groesser oder gleich startS erwartet");
      return {
        trainId,
        resource: resourceValue(item["resource"], `${path}.resource`),
        governingStationId,
        phase: enumValue(item["phase"], `${path}.phase`, BLOCKING_PHASES),
        startS,
        endS,
        startDistanceMm: integerValue(
          item["startDistanceMm"],
          `${path}.startDistanceMm`,
          0,
        ),
        endDistanceMm: integerValue(item["endDistanceMm"], `${path}.endDistanceMm`, 0),
      };
    },
  );

  const conflicts = arrayValue(input["conflicts"], "$.conflicts").map((conflict, index) => {
    const path = `$.conflicts[${index}]`;
    const item = record(conflict, path, [
      "id",
      "kind",
      "resource",
      "window",
      "trainIds",
      "explanation",
      "alternative",
    ]);
    const projectedTrainIds = arrayValue(item["trainIds"], `${path}.trainIds`);
    if (projectedTrainIds.length !== 2) {
      fail(`${path}.trainIds`, "genau zwei beteiligte Zugfahrten erwartet");
    }
    const firstTrainId = stringValue(projectedTrainIds[0], `${path}.trainIds[0]`, 128);
    const secondTrainId = stringValue(projectedTrainIds[1], `${path}.trainIds[1]`, 128);
    if (firstTrainId === secondTrainId) {
      fail(`${path}.trainIds`, "zwei verschiedene Zugfahrten erwartet");
    }
    if (!trainIds.has(firstTrainId) || !trainIds.has(secondTrainId)) {
      fail(`${path}.trainIds`, "zwei bekannte Zugfahrten erwartet");
    }
    const windowInput = record(item["window"], `${path}.window`, ["startS", "endS"]);
    const startS = integerValue(windowInput["startS"], `${path}.window.startS`, 0);
    const endS = integerValue(windowInput["endS"], `${path}.window.endS`, 0);
    if (endS <= startS) fail(`${path}.window.endS`, "Wert groesser als startS erwartet");

    let alternative: PlanningAlternativeProjection | null = null;
    if (item["alternative"] !== null) {
      const alternativePath = `${path}.alternative`;
      const alternativeValue = item["alternative"];
      const alternativeInput = record(item["alternative"], alternativePath, [
        "alternativeId",
        "trainId",
        "departureShiftS",
        "explanation",
        ...(typeof alternativeValue === "object" && alternativeValue !== null && "planning" in alternativeValue ? ["planning"] : []),
      ]);
      const alternativeTrainId = stringValue(
        alternativeInput["trainId"],
        `${alternativePath}.trainId`,
        128,
      );
      if (alternativeTrainId !== firstTrainId && alternativeTrainId !== secondTrainId) {
        fail(`${alternativePath}.trainId`, "am Konflikt beteiligte Zugfahrt erwartet");
      }
      const departureShiftS = integerValue(
        alternativeInput["departureShiftS"],
        `${alternativePath}.departureShiftS`,
      );
      const planning = alternativeInput["planning"] === undefined ? undefined
        : planningResultValue(alternativeInput["planning"], `${alternativePath}.planning`, stationIds);
      if (planning !== undefined && (planning.status !== "proposed"
        || planning.plannedDepartureS! - planning.requestedDepartureS !== departureShiftS)) {
        fail(`${alternativePath}.planning`, "vorgeschlagene Trasse mit identischer Abfahrtsverschiebung erwartet");
      }
      if (departureShiftS === 0 && (planning === undefined || (planning.adjustments.length === 0 && planning.routeChange === undefined))) {
        fail(`${alternativePath}.departureShiftS`, "Zeitlagenaenderung ungleich null erwartet");
      }
      alternative = {
        alternativeId: stringValue(
          alternativeInput["alternativeId"],
          `${alternativePath}.alternativeId`,
          64,
        ),
        trainId: alternativeTrainId,
        departureShiftS,
        explanation: stringValue(
          alternativeInput["explanation"],
          `${alternativePath}.explanation`,
          2_048,
        ),
        ...(planning === undefined ? {} : { planning }),
      };
    }
    return {
      id: stringValue(item["id"], `${path}.id`, 128),
      kind: enumValue(item["kind"], `${path}.kind`, CONFLICT_KINDS),
      resource: resourceValue(item["resource"], `${path}.resource`),
      window: { startS, endS },
      trainIds: [firstTrainId, secondTrainId] as const,
      explanation: stringValue(item["explanation"], `${path}.explanation`, 2_048),
      alternative,
    };
  });
  assertUnique(conflicts.map((conflict) => conflict.id), "$.conflicts[].id");
  assertUnique(
    conflicts.flatMap((conflict) =>
      conflict.alternative === null ? [] : [conflict.alternative.alternativeId],
    ),
    "$.conflicts[].alternative.alternativeId",
  );

  return {
    schemaVersion: PLANNING_PROJECTION_SCHEMA_VERSION,
    projectionRevision: integerValue(input["projectionRevision"], "$.projectionRevision", 0),
    worldId: stringValue(input["worldId"], "$.worldId", 128),
    corridor: {
      id: stringValue(corridorInput["id"], "$.corridor.id", 128),
      name: stringValue(corridorInput["name"], "$.corridor.name"),
    },
    stations,
    trains,
    occupations,
    conflicts,
  };
}

/** Parse- statt Type-Cast-Grenze fuer nicht vertrauenswuerdige Event-Payloads. */
export function parsePlanningProjection(value: unknown): PlanningProjectionV1 {
  return parseProjectionUnchecked(value);
}

export function isPlanningProjection(value: unknown): value is PlanningProjectionV1 {
  try {
    parseProjectionUnchecked(value);
    return true;
  } catch {
    return false;
  }
}

export function parsePlanningProjectionEnvelope(value: unknown): PlanningProjectionEnvelopeV1 {
  const input = record(value, "$envelope", ["sequence", "timeBasis", "data"]);
  const timeBasis = record(input["timeBasis"], "$envelope.timeBasis", ["epoch", "timeZone", "operatingDayBoundaryS"]);
  const epoch = stringValue(timeBasis["epoch"], "$envelope.timeBasis.epoch");
  if (!Number.isFinite(Date.parse(epoch))) fail("$envelope.timeBasis.epoch", "ISO-Zeitpunkt erwartet");
  if (timeBasis["timeZone"] !== "Europe/Berlin") fail("$envelope.timeBasis.timeZone", "Europe/Berlin erwartet");
  if (timeBasis["operatingDayBoundaryS"] !== 0) fail("$envelope.timeBasis.operatingDayBoundaryS", "0 erwartet");
  return {
    sequence: integerValue(input["sequence"], "$envelope.sequence", 0),
    timeBasis: { epoch, timeZone: "Europe/Berlin", operatingDayBoundaryS: 0 },
    data: parsePlanningProjection(input["data"]),
  };
}

export function idempotencyKeyForAlternative(
  projectionRevision: number,
  alternativeId: string,
): string {
  const revision = integerValue(projectionRevision, "$command.projectionRevision", 0);
  const id = stringValue(alternativeId, "$command.alternativeId", 64);
  return `alternative:${revision}:${id}`;
}

export function createPlanningAlternativeCommand(
  projectionRevision: number,
  alternativeId: string,
): PlanningAlternativeCommandV1 {
  return {
    schemaVersion: PLANNING_ALTERNATIVE_COMMAND_SCHEMA_VERSION,
    projectionRevision,
    alternativeId,
    idempotencyKey: idempotencyKeyForAlternative(projectionRevision, alternativeId),
  };
}

export function parsePlanningAlternativeCommand(value: unknown): PlanningAlternativeCommandV1 {
  const input = record(value, "$command", [
    "schemaVersion",
    "projectionRevision",
    "alternativeId",
    "idempotencyKey",
  ]);
  if (input["schemaVersion"] !== PLANNING_ALTERNATIVE_COMMAND_SCHEMA_VERSION) {
    fail("$command.schemaVersion", PLANNING_ALTERNATIVE_COMMAND_SCHEMA_VERSION);
  }
  const projectionRevision = integerValue(
    input["projectionRevision"],
    "$command.projectionRevision",
    0,
  );
  const alternativeId = stringValue(input["alternativeId"], "$command.alternativeId", 64);
  const expectedKey = idempotencyKeyForAlternative(projectionRevision, alternativeId);
  if (input["idempotencyKey"] !== expectedKey) {
    fail("$command.idempotencyKey", `deterministischer Wert ${expectedKey} erwartet`);
  }
  return {
    schemaVersion: PLANNING_ALTERNATIVE_COMMAND_SCHEMA_VERSION,
    projectionRevision,
    alternativeId,
    idempotencyKey: expectedKey,
  };
}
