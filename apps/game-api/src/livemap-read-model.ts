import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import {
  LIVEMAP_CONFIG_SCHEMA,
  LIVEMAP_OBJECT_DETAIL_SCHEMA,
  OWNER_TRAIN_DETAIL_SCHEMA,
  STATION_BOARD_SCHEMA,
  type LivemapConfigV2,
  type LivemapObjectDetailV1,
  type LivemapObjectKind,
  type LivemapProjectionCursor,
  type LivemapReadModel,
  type OwnerTrainDetailV1,
  type PassengerInformationPlan,
  type StationBoardV1,
} from "@zugfolge/livemap-stream";

const LIVEMAP_READ_MODEL_CATALOG_SCHEMA = "zugfolge-livemap-read-model-catalog/v1" as const;
const LIVEMAP_SQLITE_APPLICATION_ID = 0x5a554746;
const LIVEMAP_SQLITE_USER_VERSION = 3;
const LIVEMAP_SQLITE_SCHEMA = "zugfolge-livemap-read-model-sqlite/v2";
const NORMALIZED_SCHEDULE_TIME_ZONE = "Europe/Berlin";
const NORMALIZED_SCHEDULE_REPEAT_EVERY_S = 86_400;
const requiredMetadataKeys = Object.freeze([
  "gtfs_service_date",
  "infrastructure_release_id",
  "repeat_every_s",
  "schema",
  "service_start_offset_s",
  "time_zone",
  "world_epoch",
  "world_id",
]);

const publicSqliteTables = Object.freeze({
  metadata: ["key", "value"],
  world_config: ["world_id", "infrastructure_release_id", "config_json"],
  object_details: ["world_id", "infrastructure_release_id", "kind", "object_id", "name", "quality_class", "facts_json"],
  station_identifiers: ["world_id", "station_id", "scheme", "value"],
  station_schedule_calls: ["world_id", "station_id", "call_type", "train_id", "scheduled_time_s", "train_number", "category", "platform", "origin", "destination"],
  passenger_information: ["world_id", "train_id", "destination", "following_stops_json", "messages_json"],
} as const);

interface WorldCatalog {
  readonly config: LivemapConfigV2;
  readonly objects: readonly LivemapObjectDetailV1[];
  readonly stationBoards: readonly StationBoardV1[];
  readonly passengerInformation: readonly PassengerInformationPlan[];
  readonly ownerTrainDetails: readonly OwnerTrainDetailV1[];
}

interface Catalog {
  readonly schemaVersion: typeof LIVEMAP_READ_MODEL_CATALOG_SCHEMA;
  readonly worlds: readonly WorldCatalog[];
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} muss ein Objekt sein.`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} muss eine nichtleere Zeichenkette sein.`);
  }
  return value;
}

function list(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} muss eine Liste sein.`);
  return value;
}

function sameOriginPath(value: unknown, name: string): string {
  const path = nonEmptyString(value, name);
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError(`${name} muss auf einen selbst gehosteten Same-Origin-Pfad zeigen.`);
  }
  return path;
}

function safeInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${name} muss eine sichere Ganzzahl zwischen ${minimum} und ${maximum} sein.`);
  }
  return value as number;
}

function stringList(value: unknown, name: string): readonly string[] {
  const values = list(value, name);
  if (values.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError(`${name} muss nur nichtleere Zeichenketten enthalten.`);
  }
  return values as readonly string[];
}

function validateConfig(config: LivemapConfigV2): void {
  if (config.schemaVersion !== LIVEMAP_CONFIG_SCHEMA || config.basemap.selfHosted !== true) {
    throw new TypeError("Livemap-Katalog besitzt keine selbst gehostete v1-Konfiguration.");
  }
  nonEmptyString(config.worldId, "config.worldId");
  nonEmptyString(config.worldName, "config.worldName");
  nonEmptyString(config.infrastructureReleaseId, "config.infrastructureReleaseId");
  sameOriginPath(config.basemap.styleUrl, "basemap.styleUrl");
  if (config.basemap.tilesUrl !== undefined) sameOriginPath(config.basemap.tilesUrl, "basemap.tilesUrl");
  nonEmptyString(config.basemap.attribution, "basemap.attribution");
  sameOriginPath(config.infrastructure.pmtilesUrl, "infrastructure.pmtilesUrl");
  nonEmptyString(config.infrastructure.attribution, "infrastructure.attribution");
  if (config.infrastructure.coverage !== "DE") throw new TypeError("Infrastrukturabdeckung muss Gesamtdeutschland sein.");
  safeInteger(config.initialView.latitudeE7, "initialView.latitudeE7", -900_000_000, 900_000_000);
  safeInteger(config.initialView.longitudeE7, "initialView.longitudeE7", -1_800_000_000, 1_800_000_000);
  safeInteger(config.initialView.zoomMilli, "initialView.zoomMilli", 0, 30_000);
  const bounds = config.playableArea?.boundsE7;
  if (bounds !== undefined) {
    safeInteger(bounds.west, "playableArea.west", -1_800_000_000, 1_800_000_000);
    safeInteger(bounds.east, "playableArea.east", -1_800_000_000, 1_800_000_000);
    safeInteger(bounds.south, "playableArea.south", -900_000_000, 900_000_000);
    safeInteger(bounds.north, "playableArea.north", -900_000_000, 900_000_000);
    if (bounds.west >= bounds.east || bounds.south >= bounds.north) {
      throw new TypeError("Spielgebietsgrenzen muessen eine positive Flaeche beschreiben.");
    }
    nonEmptyString(config.playableArea?.label, "playableArea.label");
  }
}

function validateObjectDetail(detail: LivemapObjectDetailV1): void {
  nonEmptyString(detail.id, "object.id");
  nonEmptyString(detail.name, "object.name");
  if (!["track", "station", "platform", "switch", "signal", "block", "facility", "operating-point", "rail-context"].includes(detail.kind)) {
    throw new TypeError("Livemap-Objekt besitzt eine unbekannte Art.");
  }
  if (!["A", "B", "C"].includes(detail.qualityClass)) throw new TypeError("Livemap-Objekt besitzt keine Qualitaetsklasse.");
  list(detail.facts, "object.facts").forEach((fact, index) => {
    const value = record(fact, `object.fact ${index + 1}`);
    nonEmptyString(value["label"], `object.fact ${index + 1}.label`);
    nonEmptyString(value["value"], `object.fact ${index + 1}.value`);
    if (value["unit"] !== undefined) nonEmptyString(value["unit"], `object.fact ${index + 1}.unit`);
  });
}

function validateStationBoard(board: StationBoardV1): void {
  nonEmptyString(board.stationId, "stationBoard.stationId");
  nonEmptyString(board.stationName, "stationBoard.stationName");
  nonEmptyString(board.streamId, "stationBoard.streamId");
  safeInteger(board.sequence, "stationBoard.sequence", 0, Number.MAX_SAFE_INTEGER);
  safeInteger(board.atS, "stationBoard.atS", 0, Number.MAX_SAFE_INTEGER);
  for (const [name, calls] of [["departures", board.departures], ["arrivals", board.arrivals]] as const) {
    list(calls, `stationBoard.${name}`).forEach((call, index) => {
      const value = record(call, `stationBoard.${name} ${index + 1}`);
      nonEmptyString(value["trainId"], `stationBoard.${name}.trainId`);
      nonEmptyString(value["trainNumber"], `stationBoard.${name}.trainNumber`);
      nonEmptyString(value["category"], `stationBoard.${name}.category`);
      safeInteger(value["scheduledTimeS"], `stationBoard.${name}.scheduledTimeS`, 0, Number.MAX_SAFE_INTEGER);
      safeInteger(value["expectedTimeS"], `stationBoard.${name}.expectedTimeS`, 0, Number.MAX_SAFE_INTEGER);
      if (!["scheduled", "boarding", "arrived", "departed", "cancelled"].includes(String(value["status"]))) {
        throw new TypeError(`stationBoard.${name} besitzt einen unbekannten Status.`);
      }
    });
  }
}

function validatePassengerInformation(plan: PassengerInformationPlan): void {
  nonEmptyString(plan.trainId, "passengerInformation.trainId");
  if (plan.destination !== undefined) nonEmptyString(plan.destination, "passengerInformation.destination");
  stringList(plan.followingStops, "passengerInformation.followingStops");
  stringList(plan.messages, "passengerInformation.messages");
}

function validateOwnerDetail(detail: OwnerTrainDetailV1): void {
  nonEmptyString(detail.operatorId, "ownerTrainDetail.operatorId");
  nonEmptyString(detail.trainId, "ownerTrainDetail.trainId");
  nonEmptyString(detail.streamId, "ownerTrainDetail.streamId");
  safeInteger(detail.sequence, "ownerTrainDetail.sequence", 0, Number.MAX_SAFE_INTEGER);
  safeInteger(detail.atS, "ownerTrainDetail.atS", 0, Number.MAX_SAFE_INTEGER);
  if (detail.formationLabel !== undefined) nonEmptyString(detail.formationLabel, "ownerTrainDetail.formationLabel");
  stringList(detail.vehicleIds, "ownerTrainDetail.vehicleIds");
  stringList(detail.personnelDutyIds, "ownerTrainDetail.personnelDutyIds");
  stringList(detail.pathResourceIds, "ownerTrainDetail.pathResourceIds");
  if (detail.fixedCostCents !== undefined && !/^(0|[1-9][0-9]*)$/.test(detail.fixedCostCents)) {
    throw new TypeError("ownerTrainDetail.fixedCostCents muss eine nichtnegative Integer-Cent-Zahl sein.");
  }
}

function objectKey(kind: LivemapObjectKind, identifier: string): string {
  return `${kind}:${identifier}`;
}

/** Begrenzter JSON-Adapter; er fuehrt keinerlei Laufzeit- oder Fachlogik aus. */
export class PinnedLivemapReadModel implements LivemapReadModel {
  readonly #configs = new Map<string, LivemapConfigV2>();
  readonly #objects = new Map<string, LivemapObjectDetailV1>();
  readonly #boards = new Map<string, StationBoardV1>();
  readonly #passengerInformation = new Map<string, PassengerInformationPlan>();
  readonly #ownerDetails = new Map<string, OwnerTrainDetailV1>();

  constructor(catalog: Catalog) {
    if (catalog.schemaVersion !== LIVEMAP_READ_MODEL_CATALOG_SCHEMA) {
      throw new TypeError("Livemap-Katalog besitzt ein unbekanntes Schema.");
    }
    for (const world of catalog.worlds) {
      const { config } = world;
      validateConfig(config);
      if (this.#configs.has(config.worldId)) throw new TypeError(`Welt '${config.worldId}' ist im Livemap-Katalog doppelt.`);
      this.#configs.set(config.worldId, config);

      for (const detail of world.objects) {
        validateObjectDetail(detail);
        if (
          detail.schemaVersion !== LIVEMAP_OBJECT_DETAIL_SCHEMA ||
          detail.worldId !== config.worldId ||
          detail.infrastructureReleaseId !== config.infrastructureReleaseId
        ) {
          throw new TypeError("Livemap-Objektdetail verletzt Welt- oder Releasebindung.");
        }
        const key = `${config.worldId}:${objectKey(detail.kind, detail.id)}`;
        if (this.#objects.has(key)) throw new TypeError(`Livemap-Objekt '${key}' ist doppelt.`);
        this.#objects.set(key, detail);
      }

      for (const board of world.stationBoards) {
        validateStationBoard(board);
        if (board.schemaVersion !== STATION_BOARD_SCHEMA || board.worldId !== config.worldId) {
          throw new TypeError("Livemap-Abfahrtstafel verletzt die Weltbindung.");
        }
        const key = `${config.worldId}:${board.stationId}`;
        if (this.#boards.has(key)) throw new TypeError(`Abfahrtstafel '${key}' ist doppelt.`);
        this.#boards.set(key, board);
      }
      for (const plan of world.passengerInformation) {
        validatePassengerInformation(plan);
        const key = `${config.worldId}:${plan.trainId}`;
        if (this.#passengerInformation.has(key)) throw new TypeError(`FIS-Plan '${key}' ist doppelt.`);
        this.#passengerInformation.set(key, plan);
      }
      for (const detail of world.ownerTrainDetails) {
        validateOwnerDetail(detail);
        if (detail.schemaVersion !== OWNER_TRAIN_DETAIL_SCHEMA || detail.worldId !== config.worldId) {
          throw new TypeError("Livemap-Eigentuemerprojektion verletzt die Weltbindung.");
        }
        const key = `${config.worldId}:${detail.operatorId}:${detail.trainId}`;
        if (this.#ownerDetails.has(key)) throw new TypeError(`Eigentuemerprojektion '${key}' ist doppelt.`);
        this.#ownerDetails.set(key, detail);
      }
    }
  }

  async getConfig(worldId: string): Promise<LivemapConfigV2 | undefined> {
    return this.#configs.get(worldId);
  }

  async getObjectDetail(
    worldId: string,
    kind: LivemapObjectKind,
    objectId: string,
  ): Promise<LivemapObjectDetailV1 | undefined> {
    return this.#objects.get(`${worldId}:${objectKey(kind, objectId)}`);
  }

  async getStationBoard(
    worldId: string,
    stationId: string,
    cursor: LivemapProjectionCursor,
  ): Promise<StationBoardV1 | undefined> {
    const board = this.#boards.get(`${worldId}:${stationId}`);
    if (board === undefined) return undefined;
    const sortCalls = (calls: StationBoardV1["departures"]) => [...calls].sort((left, right) =>
      left.expectedTimeS - right.expectedTimeS ||
      left.scheduledTimeS - right.scheduledTimeS ||
      (left.trainId < right.trainId ? -1 : left.trainId > right.trainId ? 1 : 0));
    return Object.freeze({
      ...board,
      ...cursor,
      departures: Object.freeze(sortCalls(board.departures)),
      arrivals: Object.freeze(sortCalls(board.arrivals)),
    });
  }

  async getPassengerInformation(
    worldId: string,
    trainId: string,
  ): Promise<PassengerInformationPlan | undefined> {
    return this.#passengerInformation.get(`${worldId}:${trainId}`);
  }

  async getScheduledCall(worldId: string, stationId: string, trainId: string, atS: number, callType: "arrival" | "departure") {
    const board = this.#boards.get(`${worldId}:${stationId}`);
    return board?.[callType === "arrival" ? "arrivals" : "departures"].find((call) => call.trainId === trainId && call.scheduledTimeS === atS);
  }

  async getOwnerTrainDetail(
    worldId: string,
    operatorId: string,
    trainId: string,
    cursor: LivemapProjectionCursor,
  ): Promise<OwnerTrainDetailV1 | undefined> {
    const detail = this.#ownerDetails.get(`${worldId}:${operatorId}:${trainId}`);
    return detail === undefined ? undefined : Object.freeze({ ...detail, ...cursor });
  }

  close(): void {
    // JSON-Fixtures halten keine externen Ressourcen.
  }
}

function sqliteRow(value: unknown, name: string): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  return record(value, name);
}

function sqliteText(value: unknown, name: string): string {
  return nonEmptyString(value, name);
}

function optionalSqliteText(value: unknown, name: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return nonEmptyString(value, name);
}

function parseSqliteJson(value: unknown, name: string): unknown {
  const raw = sqliteText(value, name);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new TypeError(`${name} enthaelt kein gueltiges JSON.`);
  }
}

function sqliteInteger(value: unknown, name: string): number {
  return safeInteger(value, name, 0, Number.MAX_SAFE_INTEGER);
}

function metadataInteger(value: string, name: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new TypeError(`${name} ist keine kanonische nichtnegative Ganzzahl.`);
  return safeInteger(Number(value), name, 0, Number.MAX_SAFE_INTEGER);
}

export interface SQLiteScheduleTimeContract {
  readonly worldId: string;
  readonly infrastructureReleaseId: string;
  readonly worldEpoch: string;
  readonly serviceDate: string;
  readonly timeZone: typeof NORMALIZED_SCHEDULE_TIME_ZONE;
  readonly serviceStartOffsetS: 0;
  readonly repeatEveryS: typeof NORMALIZED_SCHEDULE_REPEAT_EVERY_S;
}

function loadSqliteScheduleTimeContract(database: DatabaseSync): SQLiteScheduleTimeContract {
  const metadata = new Map(database.prepare("SELECT key, value FROM metadata ORDER BY key").all().map((value) => {
    const row = record(value, "Livemap-SQLite-Metadatum");
    return [sqliteText(row["key"], "metadata.key"), sqliteText(row["value"], "metadata.value")] as const;
  }));
  if (JSON.stringify([...metadata.keys()]) !== JSON.stringify(requiredMetadataKeys)) {
    throw new TypeError("Livemap-SQLite besitzt keinen vollstaendigen normalisierten Schedule-Zeitvertrag.");
  }
  if (metadata.get("schema") !== LIVEMAP_SQLITE_SCHEMA) {
    throw new TypeError("Livemap-SQLite besitzt ein unbekanntes Metadaten-Schema.");
  }
  const worldId = nonEmptyString(metadata.get("world_id"), "metadata.world_id");
  const infrastructureReleaseId = nonEmptyString(metadata.get("infrastructure_release_id"), "metadata.infrastructure_release_id");
  const worldEpoch = nonEmptyString(metadata.get("world_epoch"), "metadata.world_epoch");
  const serviceDate = nonEmptyString(metadata.get("gtfs_service_date"), "metadata.gtfs_service_date");
  const timeZone = nonEmptyString(metadata.get("time_zone"), "metadata.time_zone");
  const serviceStartOffsetS = metadataInteger(nonEmptyString(metadata.get("service_start_offset_s"), "metadata.service_start_offset_s"), "metadata.service_start_offset_s");
  const repeatEveryS = metadataInteger(nonEmptyString(metadata.get("repeat_every_s"), "metadata.repeat_every_s"), "metadata.repeat_every_s");
  const epoch = new Date(worldEpoch);
  if (
    Number.isNaN(epoch.getTime())
    || epoch.toISOString() !== worldEpoch
    || !/^20[0-9]{6}$/u.test(serviceDate)
    || epoch.toISOString().slice(0, 10).replaceAll("-", "") !== serviceDate
    || timeZone !== NORMALIZED_SCHEDULE_TIME_ZONE
    || serviceStartOffsetS !== 0
    || repeatEveryS !== NORMALIZED_SCHEDULE_REPEAT_EVERY_S
  ) {
    throw new TypeError("Livemap-SQLite verletzt den normalisierten Schedule-Zeitvertrag.");
  }
  const worlds = database.prepare("SELECT world_id, infrastructure_release_id FROM world_config ORDER BY world_id").all()
    .map((value) => record(value, "Livemap-SQLite-Weltbindung"));
  if (
    worlds.length !== 1
    || worlds[0]?.["world_id"] !== worldId
    || worlds[0]?.["infrastructure_release_id"] !== infrastructureReleaseId
  ) {
    throw new TypeError("Livemap-SQLite-Metadaten verletzen die Welt- oder Releasebindung.");
  }
  return Object.freeze({
    worldId,
    infrastructureReleaseId,
    worldEpoch,
    serviceDate,
    timeZone: NORMALIZED_SCHEDULE_TIME_ZONE,
    serviceStartOffsetS: 0,
    repeatEveryS: NORMALIZED_SCHEDULE_REPEAT_EVERY_S,
  });
}

function concreteScheduleTrainId(baseTrainId: string, serviceDay: number): string {
  if (baseTrainId.includes(":day-") || !Number.isSafeInteger(serviceDay) || serviceDay < 0) {
    throw new TypeError("Livemap-SQLite besitzt keine kanonische Basisfahrtbindung.");
  }
  return serviceDay === 0 ? baseTrainId : `${baseTrainId}:day-${serviceDay}`;
}

function validateSqliteSchema(database: DatabaseSync): void {
  const applicationId = sqliteRow(database.prepare("PRAGMA application_id").get(), "SQLite application_id");
  const userVersion = sqliteRow(database.prepare("PRAGMA user_version").get(), "SQLite user_version");
  if (applicationId?.["application_id"] !== LIVEMAP_SQLITE_APPLICATION_ID) {
    throw new TypeError("Livemap-SQLite besitzt eine fremde application_id.");
  }
  if (userVersion?.["user_version"] !== LIVEMAP_SQLITE_USER_VERSION) {
    throw new TypeError("Livemap-SQLite besitzt eine unbekannte Schema-Version.");
  }
  const objects = database.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
    .map((value) => record(value, "SQLite-Schemaobjekt"));
  if (objects.some((value) => !["table", "index"].includes(String(value["type"])))) {
    throw new TypeError("Livemap-SQLite enthaelt nicht erlaubte Views oder Trigger.");
  }
  const actualTables = objects.filter((value) => value["type"] === "table").map((value) => String(value["name"])).sort();
  const expectedTables = Object.keys(publicSqliteTables).sort();
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    throw new TypeError("Livemap-SQLite entspricht nicht der oeffentlichen Tabellen-Allowlist.");
  }
  for (const [table, expected] of Object.entries(publicSqliteTables)) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all()
      .map((value) => sqliteText(record(value, `SQLite-Spalte ${table}`)["name"], `SQLite-Spalte ${table}.name`));
    if (JSON.stringify(columns) !== JSON.stringify(expected)) {
      throw new TypeError(`Livemap-SQLite verletzt den Spaltenvertrag von '${table}'.`);
    }
  }
}

function statementRows(statement: StatementSync, ...values: readonly (string | number)[]): readonly Readonly<Record<string, unknown>>[] {
  return statement.all(...values).map((value) => record(value, "SQLite-Ergebnis"));
}

/**
 * Skalierbarer produktiver Adapter. Die Datei wird read-only geoeffnet;
 * Details, Tafeln und FIS werden nur ueber indizierte Einzelabfragen geladen.
 */
export class SQLiteLivemapReadModel implements LivemapReadModel {
  readonly #database: DatabaseSync;
  readonly #scheduleTime: SQLiteScheduleTimeContract;
  readonly #config: StatementSync;
  readonly #object: StatementSync;
  readonly #station: StatementSync;
  readonly #callBounds: StatementSync;
  readonly #calls: StatementSync;
  readonly #exactCall: StatementSync;
  readonly #passengerInformation: StatementSync;
  #closed = false;

  get scheduleTimeContract(): SQLiteScheduleTimeContract {
    return this.#scheduleTime;
  }

  constructor(path: string) {
    this.#database = new DatabaseSync(path, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      defensive: true,
      timeout: 0,
    });
    try {
      this.#database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
      validateSqliteSchema(this.#database);
      this.#scheduleTime = loadSqliteScheduleTimeContract(this.#database);
      this.#config = this.#database.prepare("SELECT infrastructure_release_id, config_json FROM world_config WHERE world_id = ?");
      this.#object = this.#database.prepare(`SELECT infrastructure_release_id, name, quality_class, facts_json
        FROM object_details WHERE world_id = ? AND kind = ? AND object_id = ?`);
      this.#station = this.#database.prepare(`SELECT name FROM object_details
        WHERE world_id = ? AND kind = 'station' AND object_id = ?`);
      this.#callBounds = this.#database.prepare(`SELECT MIN(scheduled_time_s) AS minimum_s, MAX(scheduled_time_s) AS maximum_s
        FROM station_schedule_calls WHERE world_id = ? AND station_id = ?`);
      this.#calls = this.#database.prepare(`SELECT call_type, train_id, scheduled_time_s, train_number, category, platform, origin, destination
        FROM station_schedule_calls
        WHERE world_id = ? AND station_id = ? AND scheduled_time_s BETWEEN ? AND ?
        ORDER BY scheduled_time_s, train_id, call_type LIMIT 160`);
      this.#exactCall = this.#database.prepare(`SELECT train_id, train_number, category FROM station_schedule_calls
        WHERE world_id = ? AND station_id = ? AND scheduled_time_s = ? AND call_type = ?`);
      this.#passengerInformation = this.#database.prepare(`SELECT destination, following_stops_json, messages_json
        FROM passenger_information WHERE world_id = ? AND train_id = ?`);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Livemap-SQLite ist bereits geschlossen.");
  }

  async getScheduledCall(worldId: string, stationId: string, trainId: string, atS: number, callType: "arrival" | "departure") {
    this.#assertOpen();
    if (worldId !== this.#scheduleTime.worldId || !Number.isSafeInteger(atS) || atS < 0) return undefined;
    const bounds = sqliteRow(this.#callBounds.get(worldId, stationId), "Nachfrage-Fahrplanzeitgrenzen");
    if (bounds?.["minimum_s"] === null || bounds?.["minimum_s"] === undefined || bounds["maximum_s"] === null) return undefined;
    const minimum = sqliteInteger(bounds["minimum_s"], "minimum"), maximum = sqliteInteger(bounds["maximum_s"], "maximum");
    const repeat = this.#scheduleTime.repeatEveryS;
    for (let day = Math.max(0, Math.ceil((atS - maximum) / repeat)); day <= Math.floor((atS - minimum) / repeat); day += 1) {
      for (const row of statementRows(this.#exactCall, worldId, stationId, atS - day * repeat, callType)) {
        if (concreteScheduleTrainId(sqliteText(row["train_id"], "trainId"), day) !== trainId) continue;
        return { trainId, trainNumber: sqliteText(row["train_number"], "trainNumber"), category: sqliteText(row["category"], "category"),
          scheduledTimeS: atS, expectedTimeS: atS, status: "scheduled" as const };
      }
    }
    return undefined;
  }

  async getConfig(worldId: string): Promise<LivemapConfigV2 | undefined> {
    this.#assertOpen();
    const row = sqliteRow(this.#config.get(worldId), "Livemap-Konfiguration");
    if (row === undefined) return undefined;
    const config = record(parseSqliteJson(row["config_json"], "world_config.config_json"), "Livemap-Konfiguration") as unknown as LivemapConfigV2;
    validateConfig(config);
    if (config.worldId !== worldId || config.infrastructureReleaseId !== row["infrastructure_release_id"]) {
      throw new TypeError("Livemap-SQLite verletzt die Welt- oder Releasebindung der Konfiguration.");
    }
    return Object.freeze(config);
  }

  async getObjectDetail(worldId: string, kind: LivemapObjectKind, objectId: string): Promise<LivemapObjectDetailV1 | undefined> {
    this.#assertOpen();
    const row = sqliteRow(this.#object.get(worldId, kind, objectId), "Livemap-Objektdetail");
    if (row === undefined) return undefined;
    const facts = parseSqliteJson(row["facts_json"], "object_details.facts_json");
    const detail: LivemapObjectDetailV1 = Object.freeze({
      schemaVersion: LIVEMAP_OBJECT_DETAIL_SCHEMA,
      worldId,
      infrastructureReleaseId: sqliteText(row["infrastructure_release_id"], "object_details.infrastructure_release_id"),
      kind,
      id: objectId,
      name: sqliteText(row["name"], "object_details.name"),
      qualityClass: sqliteText(row["quality_class"], "object_details.quality_class") as LivemapObjectDetailV1["qualityClass"],
      facts: list(facts, "object_details.facts_json") as LivemapObjectDetailV1["facts"],
    });
    validateObjectDetail(detail);
    return detail;
  }

  async getStationBoard(worldId: string, stationId: string, cursor: LivemapProjectionCursor): Promise<StationBoardV1 | undefined> {
    this.#assertOpen();
    if (worldId !== this.#scheduleTime.worldId) return undefined;
    const station = sqliteRow(this.#station.get(worldId, stationId), "Livemap-Station");
    if (station === undefined) return undefined;
    const start = Math.max(0, cursor.atS - 3_600);
    const end = Math.min(Number.MAX_SAFE_INTEGER, cursor.atS + 10_800);
    const bounds = sqliteRow(this.#callBounds.get(worldId, stationId), "Livemap-Fahrplanzeitgrenzen");
    const minimumS = bounds?.["minimum_s"] === null || bounds?.["minimum_s"] === undefined
      ? undefined
      : sqliteInteger(bounds["minimum_s"], "station_schedule_calls.minimum_s");
    const maximumS = bounds?.["maximum_s"] === null || bounds?.["maximum_s"] === undefined
      ? undefined
      : sqliteInteger(bounds["maximum_s"], "station_schedule_calls.maximum_s");
    const calls: Array<StationBoardV1["departures"][number] & { readonly callType: string }> = [];
    if (minimumS !== undefined && maximumS !== undefined) {
      const repeatEveryS = this.#scheduleTime.repeatEveryS;
      const firstServiceDay = Math.max(0, Math.ceil((start - maximumS) / repeatEveryS));
      const lastServiceDay = Math.floor((end - minimumS) / repeatEveryS);
      for (let serviceDay = firstServiceDay; serviceDay <= lastServiceDay; serviceDay += 1) {
        const shiftS = serviceDay * repeatEveryS;
        if (!Number.isSafeInteger(shiftS)) throw new TypeError("Livemap-Schedule-Tagesverschiebung ist nicht darstellbar.");
        const baseStart = Math.max(0, start - shiftS);
        const baseEnd = end - shiftS;
        if (baseEnd < baseStart) continue;
        for (const row of statementRows(this.#calls, worldId, stationId, baseStart, baseEnd)) {
          const baseScheduledTimeS = sqliteInteger(row["scheduled_time_s"], "station_schedule_calls.scheduled_time_s");
          const scheduledTimeS = baseScheduledTimeS + shiftS;
          if (!Number.isSafeInteger(scheduledTimeS)) throw new TypeError("Livemap-Schedule-Zeit ist nicht darstellbar.");
          calls.push(Object.freeze({
            trainId: concreteScheduleTrainId(sqliteText(row["train_id"], "station_schedule_calls.train_id"), serviceDay),
            trainNumber: sqliteText(row["train_number"], "station_schedule_calls.train_number"),
            category: sqliteText(row["category"], "station_schedule_calls.category"),
            scheduledTimeS,
            expectedTimeS: scheduledTimeS,
            ...(optionalSqliteText(row["platform"], "station_schedule_calls.platform") === undefined ? {} : { platform: String(row["platform"]) }),
            ...(optionalSqliteText(row["origin"], "station_schedule_calls.origin") === undefined ? {} : { origin: String(row["origin"]) }),
            ...(optionalSqliteText(row["destination"], "station_schedule_calls.destination") === undefined ? {} : { destination: String(row["destination"]) }),
            status: "scheduled" as const,
            callType: sqliteText(row["call_type"], "station_schedule_calls.call_type"),
          }));
        }
      }
      calls.sort((left, right) => left.scheduledTimeS - right.scheduledTimeS || left.trainId.localeCompare(right.trainId) || left.callType.localeCompare(right.callType));
      calls.splice(160);
    }
    const withoutType = (call: typeof calls[number]): StationBoardV1["departures"][number] => {
      const { callType: _callType, ...value } = call;
      return Object.freeze(value);
    };
    const board: StationBoardV1 = Object.freeze({
      schemaVersion: STATION_BOARD_SCHEMA,
      worldId,
      stationId,
      stationName: sqliteText(station["name"], "object_details.name"),
      ...cursor,
      departures: Object.freeze(calls.filter((call) => call.callType === "departure").map(withoutType)),
      arrivals: Object.freeze(calls.filter((call) => call.callType === "arrival").map(withoutType)),
    });
    validateStationBoard(board);
    return board;
  }

  async getPassengerInformation(worldId: string, trainId: string): Promise<PassengerInformationPlan | undefined> {
    this.#assertOpen();
    if (worldId !== this.#scheduleTime.worldId || trainId.includes(":day-")) return undefined;
    const row = sqliteRow(this.#passengerInformation.get(worldId, trainId), "FIS-Plan");
    if (row === undefined) return undefined;
    const plan: PassengerInformationPlan = Object.freeze({
      trainId,
      ...(optionalSqliteText(row["destination"], "passenger_information.destination") === undefined ? {} : { destination: String(row["destination"]) }),
      followingStops: Object.freeze(stringList(parseSqliteJson(row["following_stops_json"], "passenger_information.following_stops_json"), "passenger_information.following_stops_json")),
      messages: Object.freeze(stringList(parseSqliteJson(row["messages_json"], "passenger_information.messages_json"), "passenger_information.messages_json")),
    });
    validatePassengerInformation(plan);
    return plan;
  }

  async getOwnerTrainDetail(
    _worldId: string,
    _operatorId: string,
    _trainId: string,
    _cursor: LivemapProjectionCursor,
  ): Promise<OwnerTrainDetailV1 | undefined> {
    // Das verteilbare SQLite-Artefakt besitzt absichtlich keine EVU-internen Tabellen.
    return undefined;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }
}

export function parseLivemapReadModelCatalog(value: unknown): PinnedLivemapReadModel {
  const root = record(value, "Livemap-Katalog");
  if (root["schemaVersion"] !== LIVEMAP_READ_MODEL_CATALOG_SCHEMA) {
    throw new TypeError("Livemap-Katalog besitzt ein unbekanntes Schema.");
  }
  const worlds = list(root["worlds"], "Livemap-Katalog.worlds").map((value, index) => {
    const world = record(value, `Livemap-Welt ${index + 1}`);
    const config = record(world["config"], `Livemap-Welt ${index + 1}.config`) as unknown as LivemapConfigV2;
    nonEmptyString(config.worldId, `Livemap-Welt ${index + 1}.worldId`);
    return {
      config,
      objects: list(world["objects"], "Livemap-Welt.objects") as readonly LivemapObjectDetailV1[],
      stationBoards: list(world["stationBoards"], "Livemap-Welt.stationBoards") as readonly StationBoardV1[],
      passengerInformation: list(world["passengerInformation"], "Livemap-Welt.passengerInformation") as readonly PassengerInformationPlan[],
      ownerTrainDetails: list(world["ownerTrainDetails"], "Livemap-Welt.ownerTrainDetails") as readonly OwnerTrainDetailV1[],
    };
  });
  return new PinnedLivemapReadModel({
    schemaVersion: LIVEMAP_READ_MODEL_CATALOG_SCHEMA,
    worlds,
  });
}

export type CloseableLivemapReadModel = LivemapReadModel & {
  close(): void;
  readonly scheduleTimeContract?: SQLiteScheduleTimeContract;
};

export function assertLivemapReadModelRuntimeScheduleBinding(
  readModel: CloseableLivemapReadModel | undefined,
  runtime: { readonly worldId: string; readonly worldEpoch: string; readonly repeatEveryS: number },
): void {
  const schedule = readModel?.scheduleTimeContract;
  if (schedule === undefined) return;
  if (schedule.worldId !== runtime.worldId) {
    throw new TypeError(`Livemap-ReadModel und Runtime besitzen fuer '${runtime.worldId}' verschiedene Weltbindungen.`);
  }
  if (
    schedule.worldEpoch !== runtime.worldEpoch
    || schedule.repeatEveryS !== runtime.repeatEveryS
  ) {
    throw new TypeError(`Livemap-ReadModel und Runtime besitzen fuer '${runtime.worldId}' verschiedene Schedule-Zeitachsen.`);
  }
}

export async function loadLivemapReadModel(path: string): Promise<CloseableLivemapReadModel> {
  const extension = extname(path).toLowerCase();
  if (extension === ".json") {
    const raw = await readFile(path, "utf8");
    return parseLivemapReadModelCatalog(JSON.parse(raw) as unknown);
  }
  if (![".sqlite", ".sqlite3", ".db"].includes(extension)) {
    throw new TypeError("LIVEMAP_READ_MODEL_PATH muss auf JSON oder eine oeffentliche SQLite-Datei zeigen.");
  }
  const header = await readFile(path).then((value) => value.subarray(0, 16).toString("binary"));
  if (header !== "SQLite format 3\u0000") throw new TypeError("Livemap-ReadModel besitzt keinen SQLite-3-Header.");
  return new SQLiteLivemapReadModel(path);
}
