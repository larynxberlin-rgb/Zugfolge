import { accounts, alphaWorldProfiles, domainEvents, fleetMobilizationSnapshots, onboardingGrants, operatingProgramVersions, worlds } from "@zugfolge/db";
import { and, desc, eq, sql } from "drizzle-orm";

import { AlphaAuthorizationError, AlphaConflictError, AlphaValidationError } from "./errors.js";
import { alphaHash } from "./hash.js";
import type { AlphaDatabase } from "./world.js";

export interface StartPackageSpec {
  readonly schemaVersion: "zugfolge-start-package/v1";
  readonly version: string;
  readonly emergencyLotId: string;
  readonly maximumTrainKmPerPeriod: number;
  readonly vehicleClass: string;
  readonly maximumVehicleValueCents: bigint;
  readonly durationS: number;
  readonly pathWindowId: string;
  readonly personnelPoolId: string;
  readonly operatingProgramTemplateId: string;
}

export interface StartPackageProof {
  readonly operatorId: string;
  readonly lotId: string;
  readonly vehicleId: string;
  readonly vehicleLeaseContractId: string;
  readonly pathReceiptId: string;
  readonly personnelPoolId: string;
  readonly operatingProgramId: string;
  readonly operatingProgramActive: boolean;
  readonly fleetStateHash: string;
  readonly economyStateHash: string;
}

export interface CapacityCell {
  readonly resourceId: string;
  readonly intervalStartS: number;
  readonly intervalEndS: number;
  readonly usedSeconds: number;
  readonly capacitySeconds: number;
  readonly qualityClass: "A" | "B" | "C";
  readonly orderable: boolean;
}

export interface OnboardingPort {
  grantThroughAuthoritativePaths(input: {
    readonly tx: AlphaDatabase;
    readonly worldId: string;
    readonly accountId: string;
    readonly keycloakSubject: string;
    readonly atS: number;
    readonly idempotencyKey: string;
    readonly spec: StartPackageSpec;
  }): Promise<StartPackageProof>;
  capacityCells(worldId: string, fromS: number, untilS: number): Promise<readonly CapacityCell[]>;
  afterGrantCommitted?(worldId: string, idempotencyKey: string): Promise<void>;
}

function validateSpec(spec: StartPackageSpec): void {
  if (spec.schemaVersion !== "zugfolge-start-package/v1" || spec.version.trim() === "") throw new AlphaValidationError("Startpaket-Spezifikation ist ungültig.");
  if (!Number.isSafeInteger(spec.maximumTrainKmPerPeriod) || spec.maximumTrainKmPerPeriod < 1 || spec.maximumTrainKmPerPeriod > 25_000) throw new AlphaValidationError("Startlos ist nicht klein genug begrenzt.");
  if (spec.maximumVehicleValueCents <= 0n || spec.maximumVehicleValueCents > 2_000_000_000n) throw new AlphaValidationError("Leasingfahrzeug liegt ausserhalb der Alpha-Startgrenze.");
  if (!Number.isSafeInteger(spec.durationS) || spec.durationS < 86_400 || spec.durationS > 8 * 7 * 86_400) throw new AlphaValidationError("Startpaket darf hoechstens eine Fahrplanperiode dauern.");
}

export class OnboardingService {
  constructor(private readonly db: AlphaDatabase, private readonly port: OnboardingPort) {}

  async grantForAccount(worldId: string, accountId: string) {
    const [grant] = await this.db.select().from(onboardingGrants).where(and(
      eq(onboardingGrants.worldId, worldId), eq(onboardingGrants.accountId, accountId), eq(onboardingGrants.revoked, false),
    )).limit(1);
    return grant === undefined ? undefined : { grant, idempotentReplay: true };
  }

  async claim(worldId: string, keycloakSubject: string, atS: number, spec: StartPackageSpec) {
    validateSpec(spec);
    const [profile] = await this.db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, worldId)).limit(1);
    if (profile?.profileKind !== "public" || profile.state !== "running") throw new AlphaConflictError("Startpaket ist nur in einer laufenden öffentlichen Welt verfügbar.");
    const [account] = await this.db.select().from(accounts).where(and(eq(accounts.worldId, worldId), eq(accounts.keycloakSubject, keycloakSubject))).limit(1);
    if (account === undefined || account.erasedAt !== null) throw new AlphaAuthorizationError("Aktives Weltkonto fehlt.");
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select ${accounts.id} from ${accounts} where ${accounts.worldId} = ${worldId} and ${accounts.id} = ${account.id} for update`);
      const [prior] = await tx.select().from(onboardingGrants).where(and(eq(onboardingGrants.worldId, worldId), eq(onboardingGrants.accountId, account.id))).limit(1);
      if (prior !== undefined) return { grant: prior, idempotentReplay: true };
      const idempotencyKey = `start-package:${worldId}:${account.id}:${spec.version}`;
      const proof = await this.port.grantThroughAuthoritativePaths({ tx, worldId, accountId: account.id, keycloakSubject, atS, idempotencyKey, spec });
      if (proof.lotId !== spec.emergencyLotId || proof.personnelPoolId !== spec.personnelPoolId || !proof.operatingProgramActive) throw new AlphaConflictError("Autoritativer Startpaketbeleg ist unvollständig.", "start_package_incomplete");
      for (const hash of [proof.fleetStateHash, proof.economyStateHash]) if (!/^[a-f0-9]{64}$/.test(hash)) throw new AlphaConflictError("Startpaket besitzt keinen autoritativen Zustandshash.");
      const grantHash = alphaHash("zugfolge-start-package-grant/v1", { worldId, accountId: account.id, spec, proof, atS });
      const [grant] = await tx.insert(onboardingGrants).values({
        worldId, accountId: account.id, operatorId: proof.operatorId, packageVersion: spec.version,
        emergencyLotId: proof.lotId, vehicleId: proof.vehicleId, pathReceiptId: proof.pathReceiptId,
        personnelPoolId: proof.personnelPoolId, operatingProgramId: proof.operatingProgramId,
        grantHash, grantedAtS: atS, expiresAtS: atS + spec.durationS,
      }).returning();
      if (grant === undefined) throw new Error("Startpaket konnte nicht gespeichert werden.");
      await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${worldId} for update`);
      const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents).where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
      await tx.insert(domainEvents).values({
        worldId, sequence: (head?.sequence ?? 0) + 1, eventType: "alpha.start-package-granted",
        payload: { grantId: grant.id, operatorId: proof.operatorId, lotId: proof.lotId, vehicleId: proof.vehicleId, grantHash, advantageLimit: { maximumTrainKmPerPeriod: spec.maximumTrainKmPerPeriod, expiresAtS: atS + spec.durationS } },
        occurredAt: new Date((await tx.select({ epoch: worlds.epoch }).from(worlds).where(eq(worlds.id, worldId)).limit(1))[0]!.epoch.getTime() + atS * 1_000),
      });
      return { grant, idempotentReplay: false };
    });
    // Auch ein Replay projiziert die bereits committed Runtime-Ereignisse
    // erneut. Damit heilt ein voriger Ausfall nach dem DB-Commit beim naechsten
    // Request; die Projektoren deduplizieren anhand der stabilen Ereignis-IDs.
    await this.port.afterGrantCommitted?.(worldId, `start-package:${worldId}:${account.id}:${spec.version}`);
    return result;
  }

  async capacityHeatmap(worldId: string, fromS: number, untilS: number) {
    if (!Number.isSafeInteger(fromS) || !Number.isSafeInteger(untilS) || fromS < 0 || untilS <= fromS || untilS - fromS > 7 * 86_400) throw new AlphaValidationError("Heatmap-Zeitraum ist ungültig.");
    const cells = await this.port.capacityCells(worldId, fromS, untilS);
    return cells.map((cell) => {
      if (cell.intervalEndS <= cell.intervalStartS || cell.usedSeconds < 0 || cell.capacitySeconds <= 0 || cell.usedSeconds > cell.capacitySeconds) throw new AlphaConflictError("Kapazitätsquelle lieferte ungültige Ganzzahlwerte.");
      const utilizationBasisPoints = Math.floor(cell.usedSeconds * 10_000 / cell.capacitySeconds);
      return {
        ...cell,
        orderable: cell.qualityClass === "C" ? false : cell.orderable,
        utilizationBasisPoints,
        stateLabel: cell.qualityClass === "C" ? "sichtbar, nicht bestellbar" : utilizationBasisPoints >= 9_000 ? "nahezu belegt" : utilizationBasisPoints >= 7_000 ? "angespannt" : "verfügbar",
        pattern: cell.qualityClass === "C" ? "diagonal-hatch" : utilizationBasisPoints >= 9_000 ? "dense-dots" : "none",
      };
    });
  }

  async assistantForAccount(worldId: string, accountId: string) {
    const [grant] = await this.db.select().from(onboardingGrants).where(and(
      eq(onboardingGrants.worldId, worldId), eq(onboardingGrants.accountId, accountId), eq(onboardingGrants.revoked, false),
    )).limit(1);
    if (grant === undefined) {
      return {
        ready: false,
        facts: { pathConfirmed: false, vehicleAvailable: false, personnelCovered: false, operatingProgramActive: false },
        warnings: [{ code: "start-package-missing", severity: "blocking" as const, message: "Startpaket ist noch nicht autoritativ zugeteilt." }],
      };
    }
    const [snapshot, program] = await Promise.all([
      this.db.select({ payload: fleetMobilizationSnapshots.payload }).from(fleetMobilizationSnapshots)
        .where(eq(fleetMobilizationSnapshots.worldId, worldId)).orderBy(desc(fleetMobilizationSnapshots.revision)).limit(1),
      this.db.select({ id: operatingProgramVersions.id }).from(operatingProgramVersions).where(and(
        eq(operatingProgramVersions.worldId, worldId), eq(operatingProgramVersions.operatorId, grant.operatorId),
        eq(operatingProgramVersions.id, grant.operatingProgramId), eq(operatingProgramVersions.status, "active"),
      )).limit(1),
    ]);
    const payload = typeof snapshot[0]?.payload === "object" && snapshot[0].payload !== null && !Array.isArray(snapshot[0].payload)
      ? snapshot[0].payload as Record<string, unknown>
      : {};
    const rows = (name: string): readonly Record<string, unknown>[] => Array.isArray(payload[name])
      ? (payload[name] as unknown[]).filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry))
      : [];
    const formation = rows("formations").find((entry) => entry["operatorId"] === grant.operatorId && Array.isArray(entry["vehicleIds"]) && entry["vehicleIds"].includes(grant.vehicleId));
    const path = rows("pathReservations").find((entry) => entry["operatorId"] === grant.operatorId && entry["id"] === grant.pathReceiptId && entry["status"] === "confirmed");
    const personnel = rows("personnelDuties").find((entry) => entry["operatorId"] === grant.operatorId && entry["status"] === "ready");
    const facts = {
      pathConfirmed: path !== undefined,
      vehicleAvailable: formation !== undefined && formation["availability"] === "available",
      personnelCovered: personnel !== undefined,
      operatingProgramActive: program[0] !== undefined,
    };
    const warnings = this.operatingManagerWarnings({ ...facts, maintenanceDueInS: null, capacityBasisPoints: 0 });
    return { ready: Object.values(facts).every(Boolean), facts, warnings };
  }

  operatingManagerWarnings(input: { readonly pathConfirmed: boolean; readonly vehicleAvailable: boolean; readonly personnelCovered: boolean; readonly operatingProgramActive: boolean; readonly maintenanceDueInS: number | null; readonly capacityBasisPoints: number }): readonly { readonly code: string; readonly severity: "info" | "warning" | "blocking"; readonly message: string }[] {
    const warnings: { code: string; severity: "info" | "warning" | "blocking"; message: string }[] = [];
    if (!input.pathConfirmed) warnings.push({ code: "path-missing", severity: "blocking", message: "Keine bestätigte Trasse: der Betrieb kann nicht starten." });
    if (!input.vehicleAvailable) warnings.push({ code: "vehicle-missing", severity: "blocking", message: "Kein verfügbares und zugelassenes Fahrzeug." });
    if (!input.personnelCovered) warnings.push({ code: "personnel-missing", severity: "blocking", message: "Personalbedarf ist nicht vollständig gedeckt." });
    if (!input.operatingProgramActive) warnings.push({ code: "program-inactive", severity: "blocking", message: "Betriebsprogramm ist noch nicht aktiv." });
    if (input.maintenanceDueInS !== null && input.maintenanceDueInS <= 7 * 86_400) warnings.push({ code: "maintenance-due", severity: "warning", message: `Wartungsfrist in ${input.maintenanceDueInS} Simulationssekunden.` });
    if (input.capacityBasisPoints >= 9_000) warnings.push({ code: "capacity-tight", severity: "warning", message: "Gewähltes Kapazitätsfenster ist nahezu belegt." });
    return warnings;
  }
}
