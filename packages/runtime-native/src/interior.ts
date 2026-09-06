import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { validateM5VehicleConfiguration } from "./vehicle-configuration.js";
import type {
  BindInteriorPassengerPlacesInputV1, BuildInteriorLayoutInputV1, CheckInteriorMovementInputV1,
  FindInteriorPathInputV1, InteriorLayoutV1, InteriorMovementResultV1, InteriorPassengerPlacesV2,
  InteriorPathV1, InteriorPointV1, PassengerProjectionV2, ProjectConductorPassengersInputV2,
} from "./interior-types.js";

export interface ConductorInteriorRuntime {
  build(input: BuildInteriorLayoutInputV1): InteriorLayoutV1;
  bind(input: BindInteriorPassengerPlacesInputV1): InteriorPassengerPlacesV2;
  project(input: ProjectConductorPassengersInputV2): PassengerProjectionV2;
  path(input: FindInteriorPathInputV1): InteriorPathV1;
  movement(input: CheckInteriorMovementInputV1): InteriorMovementResultV1;
}
export interface ConductorInteriorAddon {
  buildConductorInterior(input: string): string;
  bindConductorInterior(input: string): string;
  projectConductorPassengersV2(input: string): string;
  findConductorInteriorPath(input: string): string;
  checkConductorInteriorMovement(input: string): string;
}

/** Stabile Fachdiagnose ohne ungeprüfte native Fehlermeldung oder Eingabedaten. */
export class ConductorInteriorError extends Error {
  constructor(readonly code: string, readonly vehicleId?: string, readonly bodyId?: string) {
    super(`Innenraumkern: ${code}`); this.name = "ConductorInteriorError";
  }
}
const invalid = (): TypeError => new TypeError("Innenraumantwort verletzt den versionierten Transportvertrag.");
type Check = (value: unknown) => void;
const object = (shape: Readonly<Record<string, Check>>): Check => (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== Object.keys(shape).length) throw invalid();
  for (const [key, check] of Object.entries(shape)) {
    if (!Object.hasOwn(data, key)) throw invalid();
    check(data[key]);
  }
};
const choice = (...values: readonly string[]): Check => (value) => {
  if (typeof value !== "string" || !values.includes(value)) throw invalid();
};
const integer = (maximum = Number.MAX_SAFE_INTEGER, minimum = 0): Check => (value) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid();
};
const natural = integer(), positive = integer(Number.MAX_SAFE_INTEGER, 1), u32 = integer(4_294_967_295);
const identifier: Check = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,500}$/.test(value)) throw invalid();
};
const hash: Check = (value) => { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw invalid(); };
const boolean: Check = (value) => { if (typeof value !== "boolean") throw invalid(); };
const nullable = (check: Check): Check => (value) => { if (value !== null) check(value); };
const array = (check: Check, maximum: number, minimum = 0): Check => (value) => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw invalid();
  for (const item of value) check(item);
};
const distinct = (values: readonly string[]): void => { if (new Set(values).size !== values.length) throw invalid(); };
const deck = choice("main", "lower", "upper"), comfort = choice("standard", "premium");
const needs = choice("ordinary", "wheelchair", "bicycle", "stroller");
const locationShape = { vehicleId: identifier, bodyId: identifier, deckId: deck };
const pointShape = { ...locationShape, xMm: natural, yMm: natural };
const rect = object({ xMm: natural, yMm: natural, lengthMm: positive, widthMm: positive });
const capacity = object({ standardSeats: u32, standardStanding: u32, premiumSeats: u32,
  wheelchairSpaces: u32, bicycleSpaces: u32, strollerSpaces: u32 });
const bindingShape = { worldId: identifier, periodId: identifier, operatorId: identifier, formationId: identifier,
  formationRevision: positive, fleetStateHash: hash, fleetAuthorityReleaseId: identifier, fleetAuthorityReleaseHash: hash,
  mobilizationSnapshotHash: hash, geometryPolicyHash: hash, artReleaseId: identifier, artManifestHash: hash };
const passengerBindingShape = { worldId: identifier, periodId: identifier, demandReleaseId: identifier,
  releaseHash: hash, seedHash: hash, trainRunId: identifier, operatorId: identifier, manifestRevision: natural,
  demandStateHash: hash, operationalReceiptId: identifier };
const place = object({ ...pointShape, placeId: identifier, comfortClass: comfort, kind: choice("seat", "standing"), spaceNeeds: array(needs, 4, 1) });
const bay = object({ ...pointShape, spaceId: identifier, spaceNeed: choice("wheelchair", "bicycle", "stroller") });
const body = object({ bodyId: identifier, vehicleId: identifier, lengthMm: positive, widthMm: positive,
  vehicleOffsetMm: u32, formationOffsetMm: natural, reversed: boolean, deckIds: array(deck, 2, 1), entranceDeckId: deck,
  passengerAccessible: boolean, frontGangway: boolean, rearGangway: boolean, gapAfterMm: u32 });
const vehicle = object({ vehicleId: identifier, vehicleTypeId: natural, configuration: nullable(validateM5VehicleConfiguration),
  configurationHash: nullable(hash), artFamily: choice("regional-single", "regional-double", "intercity-single", "intercity-double", "dining", "sleeper"),
  capacity, bodies: array(body, 32, 1) });
const obstacleKind = choice("wall", "cab", "seat", "toilet", "accessible_toilet", "stair", "bicycle", "stroller", "wheelchair");
const checkLayout = object({ schemaVersion: choice("interior-layout/v1"), binding: object(bindingShape), layoutId: identifier,
  layoutHash: hash, capacity, vehicles: array(vehicle, 32, 1), passengerPlaces: array(place, 20_000), specialBays: array(bay, 20_000),
  obstacles: array(object({ ...locationShape, obstacleId: identifier, kind: obstacleKind, rect }), 100_000),
  nodes: array(object({ nodeId: identifier, point: object(pointShape) }), 100_000, 1),
  edges: array(object({ edgeId: identifier, fromNodeId: identifier, toNodeId: identifier, kind: choice("walk", "stair", "gangway"), lengthMm: natural, wheelchairAccessible: boolean }), 200_000),
  interactions: array(object({ interactionId: identifier, kind: choice("passenger", "door", "toilet", "accessible_toilet", "cab", "stair", "bicycle", "stroller", "wheelchair"), targetId: identifier, nodeId: identifier }), 100_000),
  doors: array(object({ ...locationShape, doorId: identifier, side: choice("left", "right"), rect, nodeId: identifier }), 4096),
  seats: array(object({ placeId: identifier, obstacleId: identifier, facing: choice("forward", "backward") }), 20_000), entranceNodeId: identifier });
const checkPlaces = object({ schemaVersion: choice("interior-passenger-places/v2"), worldId: identifier, trainRunId: identifier,
  layoutId: identifier, sourceLayoutHash: hash, layoutHash: hash, places: array(place, 20_000), specialBays: array(bay, 20_000) });
const checkProjection = object({ schemaVersion: choice("passenger-projection/v2"), binding: object(passengerBindingShape),
  segmentId: identifier, fromStopId: identifier, toStopId: identifier, layoutId: identifier, sourceLayoutHash: hash,
  layoutHash: hash, asOfMs: natural, phase: choice("in_transit", "at_stop"), currentStopId: nullable(identifier),
  passengers: array(object({ ...pointShape, passengerKey: identifier, placeId: identifier, spaceId: nullable(identifier),
    comfortClass: comfort, spaceNeeds: needs, posture: choice("seated", "standing"), appearanceVariant: u32, activity: choice("onboard", "alighting") }), 20_000), stateHash: hash });

function nativeError(error: unknown): ConductorInteriorError {
  try {
    const value: unknown = JSON.parse(error instanceof Error ? error.message : "");
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((key) => !["code", "vehicleId", "bodyId"].includes(key))
      || typeof row["code"] !== "string" || !/^[a-z][a-z0-9_]{1,99}$/.test(row["code"])) throw invalid();
    if (Object.hasOwn(row, "vehicleId")) identifier(row["vehicleId"]);
    if (Object.hasOwn(row, "bodyId")) identifier(row["bodyId"]);
    return new ConductorInteriorError(row["code"], row["vehicleId"] as string | undefined, row["bodyId"] as string | undefined);
  } catch { return new ConductorInteriorError("interior_native_rejected"); }
}
function decode<T>(call: (json: string) => string, input: unknown, check: Check): T {
  let json: string;
  try { json = call(JSON.stringify(input)); } catch (error) { throw nativeError(error); }
  if (typeof json !== "string" || json.length > 128 * 1024 * 1024) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw invalid(); }
  check(parsed); return parsed as T;
}
function equalFields(actual: object, expected: object): void {
  for (const key of Object.keys(actual)) if (Reflect.get(actual, key) !== Reflect.get(expected, key)) throw invalid();
}
function samePoint(a: InteriorPointV1, b: InteriorPointV1): boolean {
  return a.vehicleId === b.vehicleId && a.bodyId === b.bodyId && a.deckId === b.deckId && a.xMm === b.xMm && a.yMm === b.yMm;
}

/** Prüft Transport, Referenzen und Autoritätsbindung. Geometrie und Fachentscheidungen bleiben Rust. */
export function conductorInteriorRuntimeFromAddon(addon: ConductorInteriorAddon): ConductorInteriorRuntime {
  return Object.freeze({
    build(input: BuildInteriorLayoutInputV1): InteriorLayoutV1 {
      const layout = decode<InteriorLayoutV1>((json) => addon.buildConductorInterior(json), input, checkLayout);
      equalFields(layout.binding, input.binding);
      const formation = input.mobilization.formations.find((item) => item.id === input.binding.formationId);
      if (formation === undefined || JSON.stringify(layout.vehicles.map((item) => item.vehicleId)) !== JSON.stringify(formation.vehicleIds)) throw invalid();
      distinct(layout.vehicles.map((item) => item.vehicleId));
      const bodies = new Map(layout.vehicles.flatMap((item) => {
        distinct(item.bodies.map((part) => part.bodyId));
        if (item.bodies.some((part) => part.vehicleId !== item.vehicleId)) throw invalid();
        return item.bodies.map((part) => [`${item.vehicleId}/${part.bodyId}`, part] as const);
      }));
      const checkPoint = (point: InteriorPointV1): void => {
        const part = bodies.get(`${point.vehicleId}/${point.bodyId}`);
        if (!part || !part.deckIds.includes(point.deckId) || point.xMm > part.lengthMm || point.yMm > part.widthMm) throw invalid();
      };
      for (const point of [...layout.passengerPlaces, ...layout.specialBays, ...layout.nodes.map((node) => node.point)]) checkPoint(point);
      distinct(layout.passengerPlaces.map((item) => item.placeId)); distinct(layout.specialBays.map((item) => item.spaceId));
      distinct(layout.nodes.map((item) => item.nodeId)); distinct(layout.edges.map((item) => item.edgeId));
      distinct(layout.obstacles.map((item) => item.obstacleId)); distinct(layout.interactions.map((item) => item.interactionId));
      distinct(layout.doors.map((item) => item.doorId));
      distinct(layout.seats.map((item) => item.placeId)); distinct(layout.seats.map((item) => item.obstacleId));
      const seatPlaces = new Set(layout.passengerPlaces.filter((item) => item.kind === "seat").map((item) => item.placeId));
      const seatObstacles = new Set(layout.obstacles.filter((item) => item.kind === "seat").map((item) => item.obstacleId));
      if (layout.seats.length !== seatPlaces.size || layout.seats.length !== seatObstacles.size
        || layout.seats.some((item) => !seatPlaces.has(item.placeId) || !seatObstacles.has(item.obstacleId))) throw invalid();
      const nodes = new Set(layout.nodes.map((node) => node.nodeId));
      if (!nodes.has(layout.entranceNodeId) || layout.edges.some((edge) => !nodes.has(edge.fromNodeId) || !nodes.has(edge.toNodeId))
        || layout.interactions.some((item) => !nodes.has(item.nodeId)) || layout.doors.some((item) => !nodes.has(item.nodeId))) throw invalid();
      for (const item of [...layout.obstacles, ...layout.doors]) {
        checkPoint({ ...item, xMm: item.rect.xMm, yMm: item.rect.yMm });
        checkPoint({ ...item, xMm: item.rect.xMm + item.rect.lengthMm, yMm: item.rect.yMm + item.rect.widthMm });
      }
      return layout;
    },
    bind(input: BindInteriorPassengerPlacesInputV1): InteriorPassengerPlacesV2 {
      const result = decode<InteriorPassengerPlacesV2>((json) => addon.bindConductorInterior(json), input, checkPlaces);
      if (result.worldId !== input.layout.binding.worldId || result.trainRunId !== input.trainRunId || result.layoutId !== input.layout.layoutId
        || result.sourceLayoutHash !== input.layout.layoutHash) throw invalid();
      // Bindung darf keine neuen Kapazitätsplätze oder Raumressourcen einführen.
      const places = new Map(input.layout.passengerPlaces.map((item) => [item.placeId, item]));
      const bays = new Map(input.layout.specialBays.map((item) => [item.spaceId, item]));
      if (result.places.length !== places.size || result.specialBays.length !== bays.size) throw invalid();
      distinct(result.places.map((item) => item.placeId)); distinct(result.specialBays.map((item) => item.spaceId));
      for (const item of result.places) {
        const source = places.get(item.placeId);
        if (!source || !samePoint(item, source) || item.comfortClass !== source.comfortClass || item.kind !== source.kind
          || [...item.spaceNeeds].sort().join() !== [...source.spaceNeeds].sort().join()) throw invalid();
      }
      for (const item of result.specialBays) { const source = bays.get(item.spaceId); if (!source || !samePoint(item, source) || item.spaceNeed !== source.spaceNeed) throw invalid(); }
      return result;
    },
    project(input: ProjectConductorPassengersInputV2): PassengerProjectionV2 {
      const result = decode<PassengerProjectionV2>((json) => addon.projectConductorPassengersV2(json), input, checkProjection);
      equalFields(result.binding, input.binding);
      if (result.layoutId !== input.interior.layoutId || result.layoutHash !== input.interior.layoutHash
        || result.sourceLayoutHash !== input.interior.sourceLayoutHash || result.asOfMs !== input.evaluation["nowMs"]
        || result.passengers.length > input.interior.places.length) throw invalid();
      distinct(result.passengers.map((item) => item.passengerKey)); distinct(result.passengers.map((item) => item.placeId));
      distinct(result.passengers.flatMap((item) => item.spaceId === null ? [] : [item.spaceId]));
      const places = new Map(input.interior.places.map((item) => [item.placeId, item]));
      const bays = new Map(input.interior.specialBays.map((item) => [item.spaceId, item]));
      for (const passenger of result.passengers) {
        const assigned = places.get(passenger.placeId);
        if (!assigned || assigned.comfortClass !== passenger.comfortClass || !assigned.spaceNeeds.includes(passenger.spaceNeeds)
          || passenger.posture !== (assigned.kind === "seat" ? "seated" : "standing")) throw invalid();
        const special = passenger.spaceId === null ? undefined : bays.get(passenger.spaceId);
        if (passenger.spaceNeeds === "ordinary" ? passenger.spaceId !== null
          : !special || special.spaceNeed !== passenger.spaceNeeds || special.vehicleId !== assigned.vehicleId) throw invalid();
        if (!samePoint(passenger, passenger.spaceNeeds === "wheelchair" && special ? special : assigned)) throw invalid();
      }
      return result;
    },
    path(input: FindInteriorPathInputV1): InteriorPathV1 {
      const result = decode<InteriorPathV1>((json) => addon.findConductorInteriorPath(json), input,
        object({ schemaVersion: choice("interior-path/v1"), layoutHash: hash, nodeIds: array(identifier, 100_000, 1), edgeIds: array(identifier, 100_000), lengthMm: natural }));
      if (result.layoutHash !== input.expectedLayoutHash || result.layoutHash !== input.layout.layoutHash
        || result.nodeIds[0] !== input.fromNodeId || result.nodeIds.at(-1) !== input.toNodeId || result.nodeIds.length !== result.edgeIds.length + 1) throw invalid();
      const nodes = new Set(input.layout.nodes.map((item) => item.nodeId));
      const edges = new Map(input.layout.edges.map((item) => [item.edgeId, item]));
      let length = 0;
      for (let index = 0; index < result.edgeIds.length; index++) {
        const edge = edges.get(result.edgeIds[index]!); const from = result.nodeIds[index], to = result.nodeIds[index + 1];
        if (!edge || (input.wheelchair && !edge.wheelchairAccessible)
          || !((edge.fromNodeId === from && edge.toNodeId === to) || (edge.toNodeId === from && edge.fromNodeId === to))) throw invalid();
        length += edge.lengthMm;
      }
      if (result.nodeIds.some((node) => !nodes.has(node)) || length !== result.lengthMm) throw invalid();
      return result;
    },
    movement(input: CheckInteriorMovementInputV1): InteriorMovementResultV1 {
      const result = decode<InteriorMovementResultV1>((json) => addon.checkConductorInteriorMovement(json), input,
        object({ schemaVersion: choice("interior-movement-result/v1"), layoutHash: hash, allowed: boolean, issue: nullable(identifier) }));
      if (result.layoutHash !== input.expectedLayoutHash || result.layoutHash !== input.layout.layoutHash || result.allowed !== (result.issue === null)) throw invalid();
      return result;
    },
  });
}

export function loadConductorInteriorRuntime(addonPath = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"]): ConductorInteriorRuntime {
  if (addonPath === undefined || !isAbsolute(addonPath)) throw new TypeError("Absoluter Runtime-Addonpfad fehlt.");
  const addon: unknown = createRequire(import.meta.url)(addonPath);
  if (addon === null || typeof addon !== "object" || ["buildConductorInterior", "bindConductorInterior", "projectConductorPassengersV2", "findConductorInteriorPath", "checkConductorInteriorMovement"]
    .some((key) => typeof Reflect.get(addon, key) !== "function")) throw new TypeError("Runtime-Addon exportiert den vollständigen Innenraumvertrag nicht.");
  return conductorInteriorRuntimeFromAddon(addon as ConductorInteriorAddon);
}
