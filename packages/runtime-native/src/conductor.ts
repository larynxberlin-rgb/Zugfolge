import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

/** Vertrauenswürdige M10-Bindung; kein vom Browser eingereichtes Manifest. */
export interface ConductorPassengerBindingV1 {
  readonly worldId: string;
  readonly periodId: string;
  readonly demandReleaseId: string;
  readonly releaseHash: string;
  readonly seedHash: string;
  readonly trainRunId: string;
  readonly operatorId: string;
  readonly manifestRevision: number;
  readonly demandStateHash: string;
  readonly operationalReceiptId: string;
}

export type PassengerComfortClass = "standard" | "premium";
export type PassengerSpaceNeeds = "ordinary" | "wheelchair" | "bicycle" | "stroller";

/** Platzinventar eines serverseitig freigegebenen Layouts aus M15.4. */
export interface InteriorPassengerPlacesV1 {
  readonly schemaVersion: "interior-passenger-places/v1";
  readonly worldId: string;
  readonly trainRunId: string;
  readonly layoutId: string;
  readonly layoutHash: string;
  readonly places: readonly {
    readonly placeId: string;
    readonly vehicleId: string;
    readonly xMm: number;
    readonly yMm: number;
    readonly comfortClass: PassengerComfortClass;
    readonly kind: "seat" | "standing";
    readonly spaceNeeds: readonly PassengerSpaceNeeds[];
  }[];
}

export interface ProjectConductorPassengersInputV1 {
  readonly schemaVersion: "conductor-passenger-projection-input/v1";
  readonly binding: ConductorPassengerBindingV1;
  readonly evaluation: Readonly<Record<string, unknown>>;
  readonly service: Readonly<Record<string, unknown>>;
  readonly interior: InteriorPassengerPlacesV1;
  readonly previousProjection?: PassengerProjectionV1;
}

/** Ausschließlich sichtbare Daten; Fahrberechtigung und Reisejournal bleiben in M10. */
export interface PassengerProjectionV1 {
  readonly schemaVersion: "passenger-projection/v1";
  readonly binding: ConductorPassengerBindingV1;
  readonly segmentId: string;
  readonly fromStopId: string;
  readonly toStopId: string;
  readonly layoutId: string;
  readonly layoutHash: string;
  readonly asOfMs: number;
  readonly phase: "in_transit" | "at_stop";
  readonly currentStopId: string | null;
  readonly passengers: readonly {
    readonly passengerKey: string;
    readonly placeId: string;
    readonly vehicleId: string;
    readonly xMm: number;
    readonly yMm: number;
    readonly comfortClass: PassengerComfortClass;
    readonly spaceNeeds: PassengerSpaceNeeds;
    readonly posture: "seated" | "standing";
    readonly appearanceVariant: number;
    readonly activity: "onboard" | "alighting";
  }[];
  readonly stateHash: string;
}

export interface ConductorProjectionRuntime {
  project(input: ProjectConductorPassengersInputV1): PassengerProjectionV1;
}

const invalid = () => new TypeError("Fahrgastprojektion verletzt den versionierten Transportvertrag.");
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== keys.length || keys.some((key) => !Object.hasOwn(data, key))) throw invalid();
  return data;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 500) throw invalid();
  return value;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw invalid();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw invalid();
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw invalid();
  return value as T;
}

/** Strikte Transport-/Offenlegungsprüfung; Platzwahl und Anzahl entscheidet allein Rust. */
export function conductorProjectionRuntimeFromAddon(addon: { projectConductorPassengers(input: string): string }): ConductorProjectionRuntime {
  return Object.freeze({ project(input: ProjectConductorPassengersInputV1): PassengerProjectionV1 {
    let parsed: unknown;
    try { parsed = JSON.parse(addon.projectConductorPassengers(JSON.stringify(input))); }
    catch { throw new TypeError("Der Fahrgastkern konnte die belegte Projektion nicht bestätigen."); }
    const output = record(parsed, ["schemaVersion", "binding", "segmentId", "fromStopId", "toStopId", "layoutId", "layoutHash", "asOfMs", "phase", "currentStopId", "passengers", "stateHash"]);
    if (output["schemaVersion"] !== "passenger-projection/v1") throw invalid();
    const bindingKeys = ["worldId", "periodId", "demandReleaseId", "releaseHash", "seedHash", "trainRunId", "operatorId", "manifestRevision", "demandStateHash", "operationalReceiptId"] as const;
    const binding = record(output["binding"], bindingKeys);
    for (const key of bindingKeys) if (binding[key] !== input.binding[key]) throw invalid();
    if (output["layoutId"] !== input.interior.layoutId || output["layoutHash"] !== input.interior.layoutHash
      || output["asOfMs"] !== input.evaluation["nowMs"]) throw invalid();
    if (!Array.isArray(output["passengers"]) || output["passengers"].length > input.interior.places.length) throw invalid();
    const keys = new Set<string>(), places = new Set<string>();
    const passengers = output["passengers"].map((value: unknown) => {
      const person = record(value, ["passengerKey", "placeId", "vehicleId", "xMm", "yMm", "comfortClass", "spaceNeeds", "posture", "appearanceVariant", "activity"]);
      const passengerKey = text(person["passengerKey"]), placeId = text(person["placeId"]);
      if (keys.has(passengerKey) || places.has(placeId)) throw invalid();
      keys.add(passengerKey); places.add(placeId);
      return { passengerKey, placeId, vehicleId: text(person["vehicleId"]), xMm: integer(person["xMm"]), yMm: integer(person["yMm"]),
        comfortClass: choice(person["comfortClass"], ["standard", "premium"] as const),
        spaceNeeds: choice(person["spaceNeeds"], ["ordinary", "wheelchair", "bicycle", "stroller"] as const),
        posture: choice(person["posture"], ["seated", "standing"] as const), appearanceVariant: integer(person["appearanceVariant"], 4_294_967_295),
        activity: choice(person["activity"], ["onboard", "alighting"] as const) };
    });
    return { schemaVersion: "passenger-projection/v1", binding: {
      worldId: text(binding["worldId"]), periodId: text(binding["periodId"]), demandReleaseId: text(binding["demandReleaseId"]),
      releaseHash: hash(binding["releaseHash"]), seedHash: hash(binding["seedHash"]), trainRunId: text(binding["trainRunId"]),
      operatorId: text(binding["operatorId"]), manifestRevision: integer(binding["manifestRevision"]),
      demandStateHash: hash(binding["demandStateHash"]), operationalReceiptId: text(binding["operationalReceiptId"]),
    },
      segmentId: text(output["segmentId"]), fromStopId: text(output["fromStopId"]), toStopId: text(output["toStopId"]),
      layoutId: text(output["layoutId"]), layoutHash: hash(output["layoutHash"]), asOfMs: integer(output["asOfMs"]),
      phase: choice(output["phase"], ["in_transit", "at_stop"] as const),
      currentStopId: output["currentStopId"] === null ? null : text(output["currentStopId"]), passengers, stateHash: hash(output["stateHash"]) };
  } });
}

/** Derselbe Linux-Addon wie M10; ein fehlender Export hat keinen JS-Fachfallback. */
export function loadConductorProjectionRuntime(addonPath = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"]): ConductorProjectionRuntime {
  if (addonPath === undefined || !isAbsolute(addonPath)) throw new TypeError("Absoluter Runtime-Addonpfad fehlt.");
  const addon: unknown = createRequire(import.meta.url)(addonPath);
  if (addon === null || typeof addon !== "object" || !("projectConductorPassengers" in addon) || typeof addon.projectConductorPassengers !== "function")
    throw new TypeError("Runtime-Addon exportiert projectConductorPassengers nicht.");
  return conductorProjectionRuntimeFromAddon(addon as { projectConductorPassengers(input: string): string });
}
