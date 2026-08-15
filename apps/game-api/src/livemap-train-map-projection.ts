import { createHash } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import {
  allocatePublicRegionalTrainNumbers,
  publicRegionalTrainNumber,
  verifiedBaseTrainRunId,
} from "@zugfolge/livemap-stream";

import type {
  LivemapConfigV2,
  PublicInfrastructureDisruption,
  PublicExternalTrain,
  PublicMapEstimate,
  PublicMapPosition,
  PublicObjectState,
  PublicObjectStateProjector,
  PublicTrain,
  PublicTrainMapProjector,
} from "@zugfolge/livemap-stream";

const TRAIN_MAP_PROJECTION_SCHEMA = "zugfolge-train-map-projection/v2";
const TRAIN_MAP_PROJECTION_SQLITE_APPLICATION_ID = 0x5a54504a;
const TRAIN_MAP_PROJECTION_SQLITE_USER_VERSION = 2;
const TRAIN_MAP_PROJECTION_SCHEMA_SQL_SHA256 = "69f4b7d6fa7ce1f6ab21c2dbcd954a3324e9b6457203afab3a28f3cb8854bca0";
const SHA256 = /^[a-f0-9]{64}$/u;

const publicTables = Object.freeze({
  display_path_geometries: ["world_id", "infrastructure_release_id", "display_path_id", "length_mm", "geometry_json"],
  metadata: ["key", "value"],
  resource_display_spans: [
    "world_id", "infrastructure_release_id", "resource_id", "resource_start_mm", "resource_end_mm",
    "method", "display_path_id", "display_start_offset_mm", "display_end_offset_mm",
    "uncertainty_start_mm", "uncertainty_end_mm", "is_resource_end",
  ],
  track_geometries: ["world_id", "infrastructure_release_id", "track_id", "length_mm", "geometry_json"],
  resource_track_spans: [
    "world_id", "infrastructure_release_id", "resource_id", "resource_start_mm", "resource_end_mm",
    "track_id", "track_start_offset_mm", "track_end_offset_mm", "is_resource_end",
  ],
  train_resource_spans: [
    "world_id", "infrastructure_release_id", "train_id", "position_start_mm", "position_end_mm",
    "resource_id", "is_train_end",
  ],
} as const);

const publicSchemaObjects = Object.freeze([
  { type: "index", name: "resource_display_lookup", table: "resource_display_spans" },
  { type: "index", name: "resource_track_lookup", table: "resource_track_spans" },
  { type: "index", name: "train_position_lookup", table: "train_resource_spans" },
  { type: "table", name: "display_path_geometries", table: "display_path_geometries" },
  { type: "table", name: "metadata", table: "metadata" },
  { type: "table", name: "resource_display_spans", table: "resource_display_spans" },
  { type: "table", name: "resource_track_spans", table: "resource_track_spans" },
  { type: "table", name: "track_geometries", table: "track_geometries" },
  { type: "table", name: "train_resource_spans", table: "train_resource_spans" },
] as const);

interface GeometryVertex {
  readonly offsetMm: number;
  readonly latitudeE7: number;
  readonly longitudeE7: number;
  readonly bearingMilliDegrees?: number;
}

interface CachedGeometry {
  readonly lengthMm: number;
  readonly vertices: readonly GeometryVertex[];
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} muss ein Objekt sein.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} muss eine nichtleere Zeichenkette sein.`);
  return value;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new TypeError(`${name} muss eine sichere Ganzzahl ab ${minimum} sein.`);
  return value as number;
}

function sqliteRow(value: unknown, name: string): Readonly<Record<string, unknown>> | undefined {
  return value === undefined ? undefined : record(value, name);
}

function sqliteRows(statement: StatementSync, ...values: readonly (string | number)[]): readonly Readonly<Record<string, unknown>>[] {
  return statement.all(...values).map((value) => record(value, "SQLite-Projektionsergebnis"));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function validateSchema(database: DatabaseSync): void {
  const applicationId = record(database.prepare("PRAGMA application_id").get(), "SQLite application_id")["application_id"];
  const userVersion = record(database.prepare("PRAGMA user_version").get(), "SQLite user_version")["user_version"];
  if (applicationId !== TRAIN_MAP_PROJECTION_SQLITE_APPLICATION_ID || userVersion !== TRAIN_MAP_PROJECTION_SQLITE_USER_VERSION) {
    throw new TypeError("Zugkartenprojektion besitzt keinen gueltigen SQLite-Headervertrag.");
  }
  const objects = database.prepare("SELECT type, name, tbl_name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
    .map((value) => {
      const object = record(value, "SQLite-Schemaobjekt");
      return { type: object["type"], name: object["name"], table: object["tbl_name"] };
    });
  if (canonicalJson(objects) !== canonicalJson(publicSchemaObjects)) {
    throw new TypeError("Zugkartenprojektion verletzt die exakte Schemaobjekt-Allowlist.");
  }
  for (const [table, expectedColumns] of Object.entries(publicTables)) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all()
      .map((value) => text(record(value, `SQLite-Spalte ${table}`)["name"], `SQLite-Spalte ${table}.name`));
    if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)) {
      throw new TypeError(`Zugkartenprojektion verletzt den Spaltenvertrag von '${table}'.`);
    }
  }
  const schemaSql = database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
    .map((value) => record(value, "SQLite-Schema-SQL"));
  const schemaSqlSha256 = createHash("sha256").update(canonicalJson(schemaSql)).digest("hex");
  if (schemaSqlSha256 !== TRAIN_MAP_PROJECTION_SCHEMA_SQL_SHA256) {
    throw new TypeError("Zugkartenprojektion verletzt den gepinnten Schema-SQL-Hash.");
  }
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new TypeError("Zugkartenprojektion verletzt ihre Fremdschluessel.");
  }
  const quick = record(database.prepare("PRAGMA quick_check").get(), "SQLite-Schnellpruefung")["quick_check"];
  if (quick !== "ok") throw new TypeError("Zugkartenprojektion besteht die SQLite-Schnellpruefung nicht.");
  const integrity = record(database.prepare("PRAGMA integrity_check").get(), "SQLite-Integritaet")["integrity_check"];
  if (integrity !== "ok") throw new TypeError("Zugkartenprojektion besteht die SQLite-Integritaetspruefung nicht.");
}

function parseGeometry(raw: string, lengthMm: number, allowAnchor = false): CachedGeometry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError("Gleisgeometrie enthaelt kein gueltiges JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length < (allowAnchor ? 1 : 2)) throw new TypeError("Kartenpfadgeometrie besitzt zu wenige Punkte.");
  const vertices = parsed.map((rawVertex, index): GeometryVertex => {
    const vertex = record(rawVertex, `Gleisgeometriepunkt ${index + 1}`);
    const offsetMm = integer(vertex["offsetMm"], `Gleisgeometriepunkt ${index + 1}.offsetMm`);
    const latitudeE7 = integer(vertex["latitudeE7"], `Gleisgeometriepunkt ${index + 1}.latitudeE7`, -900_000_000);
    const longitudeE7 = integer(vertex["longitudeE7"], `Gleisgeometriepunkt ${index + 1}.longitudeE7`, -1_800_000_000);
    if (latitudeE7 > 900_000_000 || longitudeE7 > 1_800_000_000) throw new TypeError("Gleisgeometriepunkt liegt ausserhalb der Erde.");
    const bearing = vertex["bearingMilliDegrees"];
    if (index < parsed.length - 1 && (!Number.isSafeInteger(bearing) || (bearing as number) < 0 || (bearing as number) >= 360_000)) {
      throw new TypeError("Gleisgeometriesegment besitzt keine ganzzahlige Richtung.");
    }
    if (index === parsed.length - 1 && bearing !== undefined) throw new TypeError("Letzter Gleisgeometriepunkt darf keine Segmentrichtung tragen.");
    return Object.freeze({ offsetMm, latitudeE7, longitudeE7, ...(bearing === undefined ? {} : { bearingMilliDegrees: bearing as number }) });
  });
  if (vertices[0]?.offsetMm !== 0 || vertices.at(-1)?.offsetMm !== lengthMm) {
    throw new TypeError("Gleisgeometrie verletzt ihre Laengenbindung.");
  }
  if (lengthMm === 0 && (!allowAnchor || vertices.length !== 1)) throw new TypeError("Nur ein Darstellungspfad darf eine punktfoermige Ankergeometrie besitzen.");
  for (let index = 1; index < vertices.length; index += 1) {
    if (vertices[index]!.offsetMm <= vertices[index - 1]!.offsetMm) throw new TypeError("Gleisgeometrieoffsets sind nicht streng steigend.");
  }
  return Object.freeze({ lengthMm, vertices: Object.freeze(vertices) });
}

function roundedDivision(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("Interpolationsnenner muss positiv sein.");
  if (numerator < 0n) return -((-numerator + denominator / 2n) / denominator);
  return (numerator + denominator / 2n) / denominator;
}

function interpolate(start: number, end: number, numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator < 0 || denominator <= 0 || numerator > denominator) {
    throw new RangeError("Ganzzahlige Karteninterpolation liegt ausserhalb ihres Intervalls.");
  }
  const delta = BigInt(end) - BigInt(start);
  const result = BigInt(start) + roundedDivision(delta * BigInt(numerator), BigInt(denominator));
  const value = Number(result);
  if (!Number.isSafeInteger(value)) throw new RangeError("Ganzzahlige Karteninterpolation ueberschreitet den sicheren Bereich.");
  return value;
}

function positionOnGeometry(geometry: CachedGeometry, offsetMm: number, reverseBearing: boolean): Pick<PublicMapPosition, "latitudeE7" | "longitudeE7" | "bearingMilliDegrees"> {
  if (!Number.isSafeInteger(offsetMm) || offsetMm < 0 || offsetMm > geometry.lengthMm) {
    throw new RangeError("Gleisoffset liegt ausserhalb der nachgewiesenen Geometrie.");
  }
  if (geometry.lengthMm === 0) {
    const anchor = geometry.vertices[0]!;
    return Object.freeze({ latitudeE7: anchor.latitudeE7, longitudeE7: anchor.longitudeE7 });
  }
  let endIndex = geometry.vertices.findIndex((vertex) => vertex.offsetMm >= offsetMm);
  if (endIndex <= 0) endIndex = 1;
  const end = geometry.vertices[Math.min(endIndex, geometry.vertices.length - 1)]!;
  const start = geometry.vertices[Math.max(0, Math.min(endIndex, geometry.vertices.length - 1) - 1)]!;
  const numerator = offsetMm - start.offsetMm;
  const denominator = end.offsetMm - start.offsetMm;
  const baseBearing = start.bearingMilliDegrees;
  if (baseBearing === undefined) throw new TypeError("Gleisgeometrie besitzt am Projektionssegment keine Richtung.");
  return Object.freeze({
    latitudeE7: interpolate(start.latitudeE7, end.latitudeE7, numerator, denominator),
    longitudeE7: interpolate(start.longitudeE7, end.longitudeE7, numerator, denominator),
    bearingMilliDegrees: reverseBearing ? (baseBearing + 180_000) % 360_000 : baseBearing,
  });
}

function estimateMethod(value: unknown): PublicMapEstimate["method"] {
  if (value !== "topological-track" && value !== "route-corridor" && value !== "anchor-hold") {
    throw new TypeError("Darstellungspfad besitzt eine unbekannte Schaetzmethode.");
  }
  return value;
}

function withoutUnprovenPosition(train: PublicTrain): PublicTrain {
  if (train.mapPosition === undefined && train.mapEstimate === undefined) return train;
  const { mapPosition: _mapPosition, mapEstimate: _mapEstimate, ...plain } = train;
  return Object.freeze(plain);
}

function projectionTrainId(train: PublicTrain): string | undefined {
  if (train.baseTrainRunId === undefined) return train.id;
  return verifiedBaseTrainRunId(train);
}

function withCompatiblePublicTrainNumber<T extends Readonly<{
  operator: string;
  trainNumber: string;
}>>(
  train: T,
  trustedTrainId: string,
  allocated: ReadonlyMap<string, number>,
): T {
  if (train.operator !== "public") return train;
  const legacy = /^(.*\D)(\d{6,})$/u.exec(train.trainNumber);
  if (legacy === null || !allocated.has(trustedTrainId)) return train;
  const prefix = legacy[1]!.replace(/[-\s]+$/u, "");
  return Object.freeze({
    ...train,
    trainNumber: publicRegionalTrainNumber(prefix, trustedTrainId, allocated),
  });
}

function projectionExternalTrainId(train: PublicExternalTrain): string | undefined {
  const base = train.journeyChainId;
  if (base.includes(":day-")) return undefined;
  if (train.id === base) return base;
  const prefix = `${base}:day-`;
  return train.id.startsWith(prefix) && /^[1-9][0-9]*$/u.test(train.id.slice(prefix.length))
    ? base
    : undefined;
}

/** Read-only-Projektor; jeder Lookup bleibt an Welt und InfraRelease gebunden. */
export class SQLiteTrainMapProjector implements PublicTrainMapProjector, PublicObjectStateProjector {
  readonly #database: DatabaseSync;
  readonly #trainSpan: StatementSync;
  readonly #resourceSpan: StatementSync;
  readonly #resourceDisplaySpan: StatementSync;
  readonly #geometry: StatementSync;
  readonly #displayGeometry: StatementSync;
  readonly #resourceTracks: StatementSync;
  readonly #publicTrainNumbers: ReadonlyMap<string, number>;
  readonly #geometryCache = new Map<string, CachedGeometry>();
  readonly #displayGeometryCache = new Map<string, CachedGeometry>();
  readonly worldId: string;
  readonly infrastructureReleaseId: string;
  readonly deploymentHash: string;
  #closed = false;

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
      validateSchema(this.#database);
      const metadata = Object.fromEntries(this.#database.prepare("SELECT key, value FROM metadata ORDER BY key").all().map((value) => {
        const row = record(value, "Projektionsmetadatum");
        return [text(row["key"], "metadata.key"), text(row["value"], "metadata.value")];
      }));
      if (metadata["schema"] !== TRAIN_MAP_PROJECTION_SCHEMA) throw new TypeError("Zugkartenprojektion besitzt ein unbekanntes Schema.");
      this.worldId = text(metadata["world_id"], "metadata.world_id");
      this.infrastructureReleaseId = text(metadata["infrastructure_release_id"], "metadata.infrastructure_release_id");
      this.deploymentHash = text(metadata["deployment_sha256"], "metadata.deployment_sha256");
      if (!SHA256.test(this.deploymentHash)) {
        throw new TypeError("Zugkartenprojektion besitzt keinen gueltigen Deploymenthash.");
      }
      const trainIds = this.#database.prepare(`SELECT DISTINCT train_id
        FROM train_resource_spans
        WHERE world_id = ? AND infrastructure_release_id = ?
        ORDER BY train_id`).all(this.worldId, this.infrastructureReleaseId)
        .map((value) => text(record(value, "Zugnummernreservierung")["train_id"], "train_resource_spans.train_id"));
      this.#publicTrainNumbers = allocatePublicRegionalTrainNumbers(trainIds);
      this.#trainSpan = this.#database.prepare(`SELECT position_start_mm, position_end_mm, resource_id, is_train_end
        FROM train_resource_spans
        WHERE world_id = ? AND infrastructure_release_id = ? AND train_id = ?
          AND position_start_mm <= ?
          AND (position_end_mm > ? OR (is_train_end = 1 AND position_end_mm = ?))
        ORDER BY position_start_mm DESC LIMIT 2`);
      this.#resourceSpan = this.#database.prepare(`SELECT resource_start_mm, resource_end_mm, track_id, track_start_offset_mm, track_end_offset_mm, is_resource_end
        FROM resource_track_spans
        WHERE world_id = ? AND infrastructure_release_id = ? AND resource_id = ?
          AND resource_start_mm <= ?
          AND (resource_end_mm > ? OR (is_resource_end = 1 AND resource_end_mm = ?))
        ORDER BY resource_start_mm DESC, track_id LIMIT 2`);
      this.#resourceDisplaySpan = this.#database.prepare(`SELECT resource_start_mm, resource_end_mm, method, display_path_id,
          display_start_offset_mm, display_end_offset_mm, uncertainty_start_mm, uncertainty_end_mm, is_resource_end
        FROM resource_display_spans
        WHERE world_id = ? AND infrastructure_release_id = ? AND resource_id = ?
          AND resource_start_mm <= ?
          AND (resource_end_mm > ? OR (is_resource_end = 1 AND resource_end_mm = ?))
        ORDER BY resource_start_mm DESC, method, display_path_id LIMIT 2`);
      this.#geometry = this.#database.prepare(`SELECT length_mm, geometry_json FROM track_geometries
        WHERE world_id = ? AND infrastructure_release_id = ? AND track_id = ?`);
      this.#displayGeometry = this.#database.prepare(`SELECT length_mm, geometry_json FROM display_path_geometries
        WHERE world_id = ? AND infrastructure_release_id = ? AND display_path_id = ?`);
      this.#resourceTracks = this.#database.prepare(`SELECT DISTINCT track_id FROM resource_track_spans
        WHERE world_id = ? AND infrastructure_release_id = ? AND resource_id = ?
        ORDER BY track_id`);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  get binding(): Readonly<{ worldId: string; infrastructureReleaseId: string; deploymentHash: string }> {
    return Object.freeze({
      worldId: this.worldId,
      infrastructureReleaseId: this.infrastructureReleaseId,
      deploymentHash: this.deploymentHash,
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Zugkartenprojektion ist bereits geschlossen.");
  }

  #trackGeometry(trackId: string): CachedGeometry {
    const cached = this.#geometryCache.get(trackId);
    if (cached !== undefined) return cached;
    const row = sqliteRow(this.#geometry.get(this.worldId, this.infrastructureReleaseId, trackId), "Gleisgeometrie");
    if (row === undefined) throw new TypeError(`Nachgewiesenes Gleis '${trackId}' besitzt keine Geometrie.`);
    const geometry = parseGeometry(text(row["geometry_json"], "track_geometries.geometry_json"), integer(row["length_mm"], "track_geometries.length_mm", 1));
    this.#geometryCache.set(trackId, geometry);
    return geometry;
  }

  #displayPathGeometry(displayPathId: string): CachedGeometry {
    const cached = this.#displayGeometryCache.get(displayPathId);
    if (cached !== undefined) return cached;
    const row = sqliteRow(this.#displayGeometry.get(this.worldId, this.infrastructureReleaseId, displayPathId), "Darstellungspfadgeometrie");
    if (row === undefined) throw new TypeError(`Darstellungspfad '${displayPathId}' besitzt keine Geometrie.`);
    const geometry = parseGeometry(
      text(row["geometry_json"], "display_path_geometries.geometry_json"),
      integer(row["length_mm"], "display_path_geometries.length_mm"),
      true,
    );
    this.#displayGeometryCache.set(displayPathId, geometry);
    return geometry;
  }

  project(worldId: string, train: PublicTrain): PublicTrain {
    this.#assertOpen();
    const unpositioned = withoutUnprovenPosition(train);
    if (worldId !== this.worldId) return unpositioned;
    const trustedTrainId = projectionTrainId(train);
    if (trustedTrainId === undefined) return unpositioned;
    const plain = withCompatiblePublicTrainNumber(unpositioned, trustedTrainId, this.#publicTrainNumbers);
    if (!Number.isSafeInteger(train.positionMm) || train.positionMm < 0) return plain;
    const trainRows = sqliteRows(this.#trainSpan, worldId, this.infrastructureReleaseId, trustedTrainId, train.positionMm, train.positionMm, train.positionMm);
    if (trainRows.length === 0) return plain;
    if (trainRows.length !== 1) throw new TypeError(`Zug '${train.id}' besitzt mehrdeutige kumulative Positionsspannen.`);
    const trainSpan = trainRows[0]!;
    const positionStartMm = integer(trainSpan["position_start_mm"], "train_resource_spans.position_start_mm");
    const positionEndMm = integer(trainSpan["position_end_mm"], "train_resource_spans.position_end_mm", positionStartMm + 1);
    if (train.positionMm > positionEndMm) return plain;
    const resourceId = text(trainSpan["resource_id"], "train_resource_spans.resource_id");
    const resourceOffsetMm = train.positionMm - positionStartMm;
    const resourceRows = sqliteRows(this.#resourceSpan, worldId, this.infrastructureReleaseId, resourceId, resourceOffsetMm, resourceOffsetMm, resourceOffsetMm);
    if (resourceRows.length > 1) throw new TypeError(`Ressource '${resourceId}' besitzt mehrdeutige Gleisspannen.`);
    if (resourceRows.length === 1) {
      const resourceSpan = resourceRows[0]!;
      const resourceStartMm = integer(resourceSpan["resource_start_mm"], "resource_track_spans.resource_start_mm");
      const resourceEndMm = integer(resourceSpan["resource_end_mm"], "resource_track_spans.resource_end_mm", resourceStartMm + 1);
      if (resourceOffsetMm <= resourceEndMm) {
        const trackId = text(resourceSpan["track_id"], "resource_track_spans.track_id");
        const trackStartOffsetMm = integer(resourceSpan["track_start_offset_mm"], "resource_track_spans.track_start_offset_mm");
        const trackEndOffsetMm = integer(resourceSpan["track_end_offset_mm"], "resource_track_spans.track_end_offset_mm");
        const trackOffsetMm = interpolate(
          trackStartOffsetMm,
          trackEndOffsetMm,
          resourceOffsetMm - resourceStartMm,
          resourceEndMm - resourceStartMm,
        );
        const mapGeometry = positionOnGeometry(this.#trackGeometry(trackId), trackOffsetMm, trackEndOffsetMm < trackStartOffsetMm);
        return Object.freeze({
          ...plain,
          mapPosition: Object.freeze({
            infrastructureReleaseId: this.infrastructureReleaseId,
            resourceId,
            trackId,
            offsetMm: trackOffsetMm,
            ...mapGeometry,
          }),
        });
      }
    }
    const displayRows = sqliteRows(this.#resourceDisplaySpan, worldId, this.infrastructureReleaseId, resourceId, resourceOffsetMm, resourceOffsetMm, resourceOffsetMm);
    if (displayRows.length === 0) return plain;
    if (displayRows.length !== 1) throw new TypeError(`Ressource '${resourceId}' besitzt mehrdeutige Darstellungspfade.`);
    const displaySpan = displayRows[0]!;
    const resourceStartMm = integer(displaySpan["resource_start_mm"], "resource_display_spans.resource_start_mm");
    const resourceEndMm = integer(displaySpan["resource_end_mm"], "resource_display_spans.resource_end_mm", resourceStartMm + 1);
    if (resourceOffsetMm > resourceEndMm) return plain;
    const method = estimateMethod(displaySpan["method"]);
    const displayPathId = text(displaySpan["display_path_id"], "resource_display_spans.display_path_id");
    const displayStartOffsetMm = integer(displaySpan["display_start_offset_mm"], "resource_display_spans.display_start_offset_mm");
    const displayEndOffsetMm = integer(displaySpan["display_end_offset_mm"], "resource_display_spans.display_end_offset_mm");
    const uncertaintyStartMm = integer(displaySpan["uncertainty_start_mm"], "resource_display_spans.uncertainty_start_mm");
    const uncertaintyEndMm = integer(displaySpan["uncertainty_end_mm"], "resource_display_spans.uncertainty_end_mm");
    const numerator = resourceOffsetMm - resourceStartMm;
    const denominator = resourceEndMm - resourceStartMm;
    const displayOffsetMm = interpolate(displayStartOffsetMm, displayEndOffsetMm, numerator, denominator);
    const uncertaintyMm = interpolate(uncertaintyStartMm, uncertaintyEndMm, numerator, denominator);
    const mapGeometry = positionOnGeometry(
      this.#displayPathGeometry(displayPathId),
      displayOffsetMm,
      displayEndOffsetMm < displayStartOffsetMm,
    );
    return Object.freeze({
      ...plain,
      mapEstimate: Object.freeze({
        infrastructureReleaseId: this.infrastructureReleaseId,
        resourceId,
        method,
        displayPathId,
        displayOffsetMm,
        ...mapGeometry,
        uncertaintyMm,
      }),
    });
  }

  projectExternal(worldId: string, train: PublicExternalTrain): PublicExternalTrain {
    this.#assertOpen();
    if (worldId !== this.worldId) return train;
    const trustedTrainId = projectionExternalTrainId(train);
    if (trustedTrainId === undefined) return train;
    return withCompatiblePublicTrainNumber(train, trustedTrainId, this.#publicTrainNumbers);
  }

  projectDisruption(
    worldId: string,
    disruption: PublicInfrastructureDisruption,
  ): readonly PublicObjectState[] {
    this.#assertOpen();
    if (worldId !== this.worldId) return [];
    let state: PublicObjectState["state"] | undefined;
    if (disruption.authoritativeObjectState === "construction") {
      if (disruption.kind !== "planned") {
        throw new TypeError("Nur eine autoritativ geplante Massnahme darf als Baustelle erscheinen.");
      }
      state = "construction";
    } else if (disruption.effect === "closure") {
      state = "closure";
    } else if (disruption.effect === "speed-restriction" || disruption.effect === "single-track") {
      state = "restriction";
    }
    if (state === undefined) return [];
    const resourceId = text(disruption.affectedResource, "Stoerung.affectedResource");
    const trackIds = sqliteRows(this.#resourceTracks, worldId, this.infrastructureReleaseId, resourceId)
      .map((row) => text(row["track_id"], "resource_track_spans.track_id"));
    return Object.freeze(trackIds.map((trackId): PublicObjectState => Object.freeze({
      id: `disruption:${encodeURIComponent(disruption.disruptionId)}:track:${encodeURIComponent(trackId)}`,
      objectKind: "track",
      objectId: trackId,
      state,
      disruptionId: disruption.disruptionId,
      validUntilS: disruption.validUntilS,
    })));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#geometryCache.clear();
    this.#displayGeometryCache.clear();
    this.#database.close();
  }
}

export function loadTrainMapProjector(path: string): SQLiteTrainMapProjector {
  return new SQLiteTrainMapProjector(path);
}

export function assertTrainMapProjectionBinding(
  projector: SQLiteTrainMapProjector,
  config: LivemapConfigV2 | undefined,
  activeSignedDeploymentHash: string | undefined,
): void {
  if (
    config === undefined
    || config.worldId !== projector.worldId
    || config.infrastructureReleaseId !== projector.infrastructureReleaseId
    || activeSignedDeploymentHash === undefined
    || !SHA256.test(activeSignedDeploymentHash)
    || activeSignedDeploymentHash !== projector.deploymentHash
  ) {
    throw new TypeError("Zugkartenprojektion, Livemap-Detailkatalog und aktives signiertes Deployment verletzen ihre Welt-, Release- oder Deploymentbindung.");
  }
}
