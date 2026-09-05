import { operators, worlds } from "@zugfolge/db";
import { AccessRevokedError, getAccount, type IdentityDatabase } from "@zugfolge/identity";
import type { ConductorProjectionRuntime, DemandRuntime, InteriorPassengerPlacesV1, PassengerProjectionV1 } from "@zugfolge/runtime-native";
import { and, eq } from "drizzle-orm";
import { DemandError, DemandStore, demandInteger, demandList, demandRecord, demandText } from "./demand-store.js";

export interface ConductorProjectionAccess {
  readonly worldId: string;
  readonly keycloakSubject: string;
  readonly operatorId: string;
  readonly trainRunId: string;
  readonly expectedDemandStateHash: string;
}

/** Interne M10→M15-Grenze. Layout und Vorgänger kommen ausschließlich vom Server.
 * M15.7 bindet sie später an den Sitzungsspeicher; kein öffentlicher Manifest-POST.
 */
export class ConductorProjectionService {
  private readonly store: DemandStore;
  constructor(private readonly deps: {
    readonly db: IdentityDatabase;
    readonly demandRuntime: DemandRuntime;
    readonly projectionRuntime: ConductorProjectionRuntime;
  }) { this.store = new DemandStore(deps.db, deps.demandRuntime); }

  async project(access: ConductorProjectionAccess, interior: InteriorPassengerPlacesV1,
    previousProjection?: PassengerProjectionV1): Promise<PassengerProjectionV1> {
    try { return await this.projectVerified(access, interior, previousProjection); }
    catch (error) {
      if (error instanceof DemandError) throw error;
      if (error instanceof AccessRevokedError) throw new DemandError(403, "Kein aktiver Zugang zu dieser Welt.");
      // Native- und DB-Ausnahmen können private Manifeste enthalten. Keine Rohmeldung weiterreichen.
      throw new DemandError(503, "Die belegte Fahrgastprojektion ist momentan nicht verfügbar.");
    }
  }

  private async projectVerified(access: ConductorProjectionAccess, interior: InteriorPassengerPlacesV1,
    previousProjection?: PassengerProjectionV1): Promise<PassengerProjectionV1> {
    const { db } = this.deps;
    const account = await getAccount(db, { worldId: access.worldId, keycloakSubject: access.keycloakSubject });
    if (account === undefined) throw new DemandError(403, "Kein aktiver Zugang zu dieser Welt.");
    const [world] = await db.select({ status: worlds.lifecycleStatus }).from(worlds).where(eq(worlds.id, access.worldId));
    if (world?.status !== "active") throw new DemandError(409, "Die Spielwelt ist nicht aktiv.");
    const [operator] = await db.select({ id: operators.id }).from(operators).where(and(
      eq(operators.worldId, access.worldId), eq(operators.id, access.operatorId), eq(operators.foundingAccountId, account.id),
    ));
    if (operator === undefined) throw new DemandError(403, "Dieses Unternehmen gehört nicht zu deinem Zugang.");
    const checkpoint = await this.store.latest(access.worldId);
    if (checkpoint === undefined) throw new DemandError(503, "Es fehlt ein bestätigter M10-Nachfragestand.");
    const evaluation = checkpoint.result;
    if (evaluation["stateHash"] !== access.expectedDemandStateHash) throw new DemandError(409, "Der Fahrgastbestand wurde inzwischen aktualisiert.");
    const service = demandList(checkpoint.input["services"]).find((candidate) => candidate["trainRunId"] === access.trainRunId
      && candidate["operatorId"] === access.operatorId && candidate["worldId"] === access.worldId && candidate["mode"] === "spnv");
    if (service === undefined) throw new DemandError(404, "Für diese Fahrt liegt kein eigener SPNV-Bestand vor.");
    if (evaluation["projectionMode"] !== "progress_bound" || evaluation["operationalProgress"] === undefined)
      throw new DemandError(409, "Die Nachfrage ist eine Prognose; bestätigte Ein- und Ausstiegsbelege fehlen.");
    const progress = demandRecord(evaluation["operationalProgress"]);
    return this.deps.projectionRuntime.project({ schemaVersion: "conductor-passenger-projection-input/v1",
      binding: { worldId: access.worldId, periodId: demandText(evaluation["periodId"]), demandReleaseId: demandText(evaluation["demandReleaseId"]),
        releaseHash: demandText(evaluation["releaseHash"]), seedHash: demandText(evaluation["seedHash"]), trainRunId: access.trainRunId,
        operatorId: access.operatorId, manifestRevision: demandInteger(evaluation["revision"]), demandStateHash: access.expectedDemandStateHash,
        operationalReceiptId: demandText(progress["receiptId"]) },
      evaluation, service, interior, ...(previousProjection === undefined ? {} : { previousProjection }),
    });
  }
}
