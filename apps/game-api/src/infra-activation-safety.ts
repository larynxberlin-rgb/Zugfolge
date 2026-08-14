import { alphaHash, type AlphaDatabase, type InfraActivationSafety } from "@zugfolge/alpha";
import { alphaWorldProfiles, fleetWorldCheckpoints, operatorContracts } from "@zugfolge/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

interface SafetyReport {
  readonly worldId: string;
  readonly predecessorHash: string;
  readonly releaseHash: string;
  readonly activateAtPeriod: number;
  readonly expectedConstraintHash: string;
  readonly conflictCount: number;
  readonly invalidPathCount: number;
  readonly invalidCirculationCount: number;
  readonly invalidContractCount: number;
  readonly invariantOneProofHash: string;
  readonly explanation: string;
}

function hash(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} ist kein SHA-256.`);
}

function count(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} ist keine nichtnegative Ganzzahl.`);
}

export function parseInfraActivationSafetyReports(value: string): readonly SafetyReport[] {
  const raw: unknown = JSON.parse(value);
  // An empty, explicitly configured catalog is the fail-closed state for an
  // installation that has not approved any future infrastructure activation.
  // GameInfraActivationSafety then rejects every adoption as missing evidence.
  if (!Array.isArray(raw)) throw new Error("INFRA_ACTIVATION_SAFETY_REPORTS_JSON muss eine Liste sein.");
  const reports = raw.map((entry, index): SafetyReport => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`Sicherheitsbericht ${index + 1} ist kein Objekt.`);
    const item = entry as Record<string, unknown>;
    for (const key of ["predecessorHash", "releaseHash", "expectedConstraintHash", "invariantOneProofHash"]) hash(item[key], `Sicherheitsbericht ${index + 1}.${key}`);
    for (const key of ["activateAtPeriod", "conflictCount", "invalidPathCount", "invalidCirculationCount", "invalidContractCount"]) count(item[key], `Sicherheitsbericht ${index + 1}.${key}`);
    if (typeof item["worldId"] !== "string" || typeof item["explanation"] !== "string") throw new Error(`Sicherheitsbericht ${index + 1} ist unvollstaendig.`);
    return item as unknown as SafetyReport;
  });
  const keys = reports.map((report) => `${report.worldId}:${report.releaseHash}:${report.activateAtPeriod}`);
  if (new Set(keys).size !== keys.length) throw new Error("Infra-Sicherheitsberichte enthalten doppelte Welt-/Release-/Periodenbindungen.");
  return reports;
}

export class GameInfraActivationSafety implements InfraActivationSafety {
  constructor(private readonly db: AlphaDatabase, private readonly reports: readonly SafetyReport[]) {}

  private async constraintHash(worldId: string): Promise<string> {
    const [[profile], [fleet], contracts] = await Promise.all([
      this.db.select({ infraReleaseHash: alphaWorldProfiles.infraReleaseHash, currentPeriod: alphaWorldProfiles.currentPeriod }).from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, worldId)).limit(1),
      this.db.select({ revision: fleetWorldCheckpoints.revision, stateHash: fleetWorldCheckpoints.stateHash, snapshotHash: fleetWorldCheckpoints.snapshotHash }).from(fleetWorldCheckpoints).where(eq(fleetWorldCheckpoints.worldId, worldId)).orderBy(desc(fleetWorldCheckpoints.revision)).limit(1),
      this.db.select({ id: operatorContracts.id, revision: operatorContracts.revision, status: operatorContracts.status, subject: operatorContracts.subject, validUntilS: operatorContracts.validUntilS }).from(operatorContracts).where(and(
        eq(operatorContracts.worldId, worldId), inArray(operatorContracts.status, ["accepted", "active"]),
      )).orderBy(asc(operatorContracts.id)),
    ]);
    return alphaHash("zugfolge-infra-active-constraints/v1", {
      worldId,
      activeInfraReleaseHash: profile?.infraReleaseHash ?? null,
      currentPeriod: profile?.currentPeriod ?? null,
      fleet: fleet ?? null,
      contracts,
    });
  }

  async verify(input: Parameters<InfraActivationSafety["verify"]>[0]) {
    const report = this.reports.find((candidate) => candidate.worldId === input.worldId && candidate.releaseHash === input.releaseHash && candidate.activateAtPeriod === input.activateAtPeriod);
    if (report === undefined || report.predecessorHash !== input.predecessorHash) return {
      safe: false, conflictCount: 1, invalidPathCount: 0, invalidCirculationCount: 0, invalidContractCount: 0,
      invariantOneProofHash: alphaHash("zugfolge-infra-safety-missing/v1", input),
      explanation: "Kein passend gebundener technischer Validierungsbericht vorhanden.",
    };
    const actualConstraintHash = await this.constraintHash(input.worldId);
    const countsAreZero = report.conflictCount === 0 && report.invalidPathCount === 0 && report.invalidCirculationCount === 0 && report.invalidContractCount === 0;
    return {
      safe: countsAreZero && actualConstraintHash === report.expectedConstraintHash,
      conflictCount: actualConstraintHash === report.expectedConstraintHash ? report.conflictCount : Math.max(1, report.conflictCount),
      invalidPathCount: report.invalidPathCount,
      invalidCirculationCount: report.invalidCirculationCount,
      invalidContractCount: report.invalidContractCount,
      invariantOneProofHash: report.invariantOneProofHash,
      explanation: actualConstraintHash === report.expectedConstraintHash ? report.explanation : "Aktive Trassen-, Umlauf-, Flotten- oder Vertragsbindung hat sich seit dem technischen Validierungslauf geaendert.",
    };
  }
}
