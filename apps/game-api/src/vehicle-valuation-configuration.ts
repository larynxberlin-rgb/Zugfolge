import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { CooperationConflictError, CooperationService, validateValuationSpec, type VehicleValuationSpec } from "@zugfolge/cooperation";
import { domainEvents, vehicleAssets, worlds } from "@zugfolge/db";
import { canonicalFleetJson, loadEconomyWorldStateForUpdate, loadFleetProducerCheckpoint, type EconomyDatabase } from "@zugfolge/economy";
import { and, desc, eq, sql } from "drizzle-orm";
import { compareUtf8 } from "./utf8.js";

export interface ConfiguredVehicleValuation {
  readonly vehicleId: string;
  readonly atS: number;
  readonly odometerMetres: string;
  readonly conditionBasisPoints: number;
  readonly basis: {
    readonly baseValueCents: string;
    readonly ageYears: number;
    readonly spec: Omit<VehicleValuationSpec, "mileageStepMetres"> & { readonly mileageStepMetres: string };
  };
}

export interface WorldVehicleValuationConfiguration {
  readonly worldId: string;
  readonly authorityReleaseId: string;
  readonly economyReleaseChecksum: string;
  readonly vehicles: readonly ConfiguredVehicleValuation[];
  readonly configurationHash: string;
}

export type VehicleValuationCatalog = Readonly<Record<string, WorldVehicleValuationConfiguration>>;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError("Bewertungskatalog enthält ein ungültiges oder unvollständiges Objekt.");
  }
  return value as Record<string, unknown>;
}

function nonnegativeInteger(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("Bewertungskatalog braucht sichere nichtnegative Ganzzahlen.");
}

function cents(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new TypeError("Bewertungskatalog enthält keinen sicheren ganzzahligen Cent-/Zählerwert.");
  }
}

export function parseVehicleValuationCatalog(raw: string): VehicleValuationCatalog {
  const input = object(JSON.parse(raw), ["schemaVersion", "entries"]);
  if (input["schemaVersion"] !== "zugfolge-vehicle-valuation-catalog/v1" || !Array.isArray(input["entries"])) throw new TypeError("Unbekannter Bewertungskatalog.");
  const result: Record<string, WorldVehicleValuationConfiguration> = {};
  for (const rawEntry of input["entries"]) {
    const entry = object(rawEntry, ["worldId", "authorityReleaseId", "economyReleaseChecksum", "vehicles"]);
    if (typeof entry["worldId"] !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry["worldId"])
      || Object.hasOwn(result, entry["worldId"]) || typeof entry["authorityReleaseId"] !== "string" || entry["authorityReleaseId"].trim() === ""
      || typeof entry["economyReleaseChecksum"] !== "string" || !/^[a-f0-9]{64}$/.test(entry["economyReleaseChecksum"])
      || !Array.isArray(entry["vehicles"])) throw new TypeError("Bewertungskatalog bindet keine eindeutige Welt und Releases.");
    const seen = new Set<string>();
    for (const rawVehicle of entry["vehicles"]) {
      const vehicle = object(rawVehicle, ["vehicleId", "atS", "odometerMetres", "conditionBasisPoints", "basis"]);
      if (typeof vehicle["vehicleId"] !== "string" || vehicle["vehicleId"].trim() === "" || seen.has(vehicle["vehicleId"])) throw new TypeError("Bewertungskatalog braucht eindeutige konkrete Fahrzeugkennungen.");
      seen.add(vehicle["vehicleId"]);
      nonnegativeInteger(vehicle["atS"]);
      nonnegativeInteger(vehicle["conditionBasisPoints"]);
      if (vehicle["conditionBasisPoints"] > 10_000) throw new TypeError("Bewertungszustand überschreitet 10.000 Basispunkte.");
      cents(vehicle["odometerMetres"]);
      const basis = object(vehicle["basis"], ["baseValueCents", "ageYears", "spec"]);
      cents(basis["baseValueCents"]);
      nonnegativeInteger(basis["ageYears"]);
      const spec = object(basis["spec"], ["specId", "annualDepreciationBasisPoints", "mileageStepMetres", "mileageDepreciationBasisPoints", "maximumMileageSteps", "damageDeductionsBasisPoints", "minimumResidualBasisPoints"]);
      cents(spec["mileageStepMetres"]);
      validateValuationSpec({ ...spec, mileageStepMetres: BigInt(spec["mileageStepMetres"]) } as unknown as VehicleValuationSpec);
    }
    const canonical = { ...entry, vehicles: [...entry["vehicles"]].sort((a, b) => compareUtf8((a as ConfiguredVehicleValuation).vehicleId, (b as ConfiguredVehicleValuation).vehicleId)) };
    result[entry["worldId"]] = freeze({ ...canonical, configurationHash: createHash("sha256").update(canonicalFleetJson(canonical)).digest("hex") }) as unknown as WorldVehicleValuationConfiguration;
  }
  return Object.freeze(result);
}

export async function loadVehicleValuationCatalog(path: string | undefined): Promise<VehicleValuationCatalog> {
  if (path === undefined || path.trim() === "") return Object.freeze({});
  if (!isAbsolute(path)) throw new TypeError("ZUGFOLGE_VEHICLE_VALUATION_CATALOG_PATH muss absolut sein.");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 8 * 1024 * 1024) throw new TypeError("Bewertungskatalog braucht eine reguläre Datei bis 8 MiB.");
  return parseVehicleValuationCatalog(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)));
}

/** Der erste gültige Katalog wird je Welt dauerhaft gepinnt; Neustarts können ihn nicht austauschen. */
export async function applyConfiguredVehicleValuations(
  db: EconomyDatabase, configuration: WorldVehicleValuationConfiguration, atS: number,
): Promise<void> {
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as EconomyDatabase;
    const worldId = configuration.worldId;
    await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${worldId} for update`);
    const [world] = await tx.select().from(worlds).where(eq(worlds.id, worldId)).limit(1);
    if (world?.lifecycleStatus !== "active") return;
    const fleet = await loadFleetProducerCheckpoint(tx, worldId);
    const economy = await loadEconomyWorldStateForUpdate(tx, worldId);
    if (fleet === undefined || economy === undefined) return;
    if (fleet.state.authorityRelease.releaseId !== configuration.authorityReleaseId || economy.releasePin.releaseChecksum !== configuration.economyReleaseChecksum) {
      throw new CooperationConflictError("Bewertungskatalog stimmt nicht mit den gepinnten Welt-Releases überein.", "valuation_release_mismatch");
    }
    const [pin] = await tx.select().from(domainEvents).where(and(eq(domainEvents.worldId, worldId), eq(domainEvents.eventType, "vehicle.valuation-catalog-pinned"))).limit(1);
    if (pin !== undefined && (pin.payload as { configurationHash?: unknown }).configurationHash !== configuration.configurationHash) {
      throw new CooperationConflictError("Bewertungskatalog wurde nach der Weltfreigabe verändert.", "valuation_catalog_changed");
    }
    const append = async (eventType: string, payload: Record<string, unknown>) => {
      const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents).where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
      const sequence = (head?.sequence ?? 0) + 1;
      await tx.insert(domainEvents).values({ worldId, sequence, eventType, payload, occurredAt: new Date(world.epoch.getTime() + atS * 1000) });
      return sequence;
    };
    if (pin === undefined) await append("vehicle.valuation-catalog-pinned", {
      configurationHash: configuration.configurationHash, authorityReleaseId: configuration.authorityReleaseId, economyReleaseChecksum: configuration.economyReleaseChecksum,
    });
    const service = new CooperationService(tx);
    for (const valuation of configuration.vehicles) {
      if (valuation.atS > atS) continue;
      const [asset] = await tx.select().from(vehicleAssets).where(and(eq(vehicleAssets.worldId, worldId), eq(vehicleAssets.vehicleId, valuation.vehicleId))).limit(1);
      if (asset === undefined || asset.valuationBasis !== null) continue;
      const sequence = await append("vehicle.valuation-confirmed", {
        schemaVersion: "zugfolge-vehicle-valuation-confirmation/v1", worldId, authorityReleaseId: configuration.authorityReleaseId,
        configurationHash: configuration.configurationHash, ...valuation,
      });
      await service.applyVehicleValuationEvidence({ worldId, vehicleId: valuation.vehicleId, sourceEventSequence: sequence,
        expectedRevision: asset.revision, atS, idempotencyKey: `valuation-catalog:${configuration.configurationHash}:${valuation.vehicleId}` });
    }
  });
}
