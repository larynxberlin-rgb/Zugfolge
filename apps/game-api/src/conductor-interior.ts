import { VEHICLE_VARIANTS } from "@zugfolge/conductor-art";
import { operators, worlds } from "@zugfolge/db";
import { loadFleetProducerCheckpoint } from "@zugfolge/economy";
import { AccessRevokedError, getAccount, type IdentityDatabase } from "@zugfolge/identity";
import { ConductorInteriorError as NativeInteriorError, type ConductorInteriorRuntime, type FleetRuntime, type InteriorLayoutV1 } from "@zugfolge/runtime-native";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ConductorInteriorDeployment } from "./conductor-interior-configuration.js";

export class ConductorInteriorError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly vehicleId?: string, readonly bodyId?: string,
    readonly telemetry?: { worldId: string; periodId?: string; formationRevision?: number }) { super(message); }
}
export interface ConductorInteriorAccess {
  readonly worldId: string; readonly keycloakSubject: string; readonly operatorId: string;
  readonly formationId: string; readonly expectedFleetStateHash: string; readonly periodId: string;
}
export interface ConductorInteriorDependencies {
  readonly db: IdentityDatabase;
  readonly fleetRuntime: Pick<FleetRuntime, "verifyFleetWorldState">;
  readonly interiorRuntime: Pick<ConductorInteriorRuntime, "build">;
  readonly deployment: ConductorInteriorDeployment;
  readonly committedTimeForWorld: (worldId: string) => number | undefined;
}
function unavailable(): never { throw new ConductorInteriorError(503, "interior_unavailable", "Der belegte Innenraum ist momentan nicht verfügbar."); }
function verify(value: unknown): asserts value { if (!value) unavailable(); }

/** Lesende Projektion aus einem nativen, vollständig verifizierten M5-Checkpoint. */
export class ConductorInteriorService {
  constructor(private readonly deps: ConductorInteriorDependencies) {}
  async layout(access: ConductorInteriorAccess): Promise<InteriorLayoutV1> {
    let telemetry: ConductorInteriorError["telemetry"];
    try {
      return await this.deps.db.transaction(async (tx) => {
        const account = await getAccount(tx, { worldId: access.worldId, keycloakSubject: access.keycloakSubject });
        if (account === undefined) throw new ConductorInteriorError(403, "interior_access_denied", "Kein Zugriff auf diesen Innenraum.");
        // Der M5-Producer sperrt dieselbe Welt exklusiv vor jedem neuen Checkpoint.
        const [world] = await tx.select({ lifecycle: worlds.lifecycleStatus }).from(worlds).where(eq(worlds.id, access.worldId)).for("share");
        if (world?.lifecycle !== "active") throw new ConductorInteriorError(409, "interior_world_inactive", "Die Spielwelt ist nicht aktiv.");
        const [operator] = await tx.select({ id: operators.id }).from(operators).where(and(eq(operators.worldId, access.worldId),
          eq(operators.id, access.operatorId), eq(operators.foundingAccountId, account.id), eq(operators.lifecycle, "active")));
        if (operator === undefined) throw new ConductorInteriorError(403, "interior_access_denied", "Kein Zugriff auf diesen Innenraum.");
        telemetry = { worldId: access.worldId };
        const checkpoint = await loadFleetProducerCheckpoint(tx, access.worldId);
        if (checkpoint === undefined) unavailable();
        if (checkpoint.stateHash !== access.expectedFleetStateHash) throw new ConductorInteriorError(409, "interior_fleet_stale", "Die Formation wurde inzwischen aktualisiert.");
        const { state, stateHash, snapshot, snapshotHash } = checkpoint;
        const verification = this.deps.fleetRuntime.verifyFleetWorldState(state, stateHash);
        verify(verification.worldId === access.worldId && verification.revision === state.revision
          && verification.producedAt === state.producedAt && verification.authorityReleaseHash === state.authorityReleaseHash
          && verification.stateHash === stateHash && verification.snapshotHash === snapshotHash
          && snapshot.worldId === access.worldId && snapshot.revision === state.revision && snapshot.producedAt === state.producedAt);
        telemetry.formationRevision = state.revision;
        const nowMs = this.deps.committedTimeForWorld(access.worldId);
        verify(nowMs !== undefined && Number.isSafeInteger(nowMs) && nowMs >= 0 && state.producedAt <= Math.floor(nowMs / 1000));
        const period = this.deps.deployment.period(access.worldId, access.periodId, nowMs);
        if (period === undefined) throw new ConductorInteriorError(409, "interior_period_stale", "Die Innenraumperiode ist nicht aktuell.");
        telemetry.periodId = period.periodId;
        const formation = snapshot.formations.find((row) => row.id === access.formationId && row.operatorId === access.operatorId);
        const intent = state.formations[access.formationId];
        if (formation === undefined || intent === undefined) throw new ConductorInteriorError(404, "interior_formation_missing", "Keine eigene Formation vorhanden.");
        verify(intent.vehicleIds.length === formation.vehicleIds.length && intent.vehicleIds.every((id, index) => id === formation.vehicleIds[index]));
        if (formation.availability === "retired" || formation.procurement !== "delivered"
          || formation.availableFrom > Math.floor(nowMs / 1000) || formation.availableUntil <= Math.floor(nowMs / 1000))
          throw new ConductorInteriorError(409, "interior_formation_unavailable", "Die Formation ist nicht verfügbar.");
        const assets = intent.vehicleIds.map((vehicleId) => {
          const asset = state.authorityRelease.assets.find((row) => row.id === vehicleId);
          verify(asset !== undefined);
          const holding = state.assetHoldings?.[vehicleId];
          if ((holding?.holderOperatorId ?? asset.operatorId) !== access.operatorId
            || holding?.validUntilS !== undefined && holding.validUntilS !== null && holding.validUntilS <= Math.floor(nowMs / 1000))
            throw new ConductorInteriorError(403, "interior_access_denied", "Kein Zugriff auf diesen Innenraum.");
          return asset;
        });
        // Erst nach Autorisierung der gesamten Formation sind konkrete eigene Assetkennungen sichtbar.
        for (const asset of assets) if (asset.vehicleConfiguration === undefined
          && !("role" in asset.technical && asset.technical.role === "locomotive" && asset.passenger.seats === 0))
          throw new ConductorInteriorError(409, "interior_configuration_missing", "Für dieses Fahrzeug fehlt die vollständige M5-Innenraumkonfiguration.", asset.id);
        let layout: InteriorLayoutV1;
        try { layout = this.deps.interiorRuntime.build({ schemaVersion: "conductor-interior-layout-input/v1",
          binding: { worldId: access.worldId, periodId: period.periodId, operatorId: access.operatorId, formationId: access.formationId,
            formationRevision: state.revision, fleetStateHash: stateHash, fleetAuthorityReleaseId: state.authorityRelease.releaseId,
            fleetAuthorityReleaseHash: state.authorityReleaseHash, mobilizationSnapshotHash: snapshotHash,
            geometryPolicyHash: period.geometryPolicyHash, artReleaseId: period.artPin.releaseId, artManifestHash: period.artPin.manifestSha256 },
          authorityRelease: state.authorityRelease, mobilization: snapshot, geometryPolicy: period.geometryPolicy }); }
        catch (error) {
          if (error instanceof NativeInteriorError && error.code !== "interior_native_rejected"
            && (error.vehicleId === undefined || assets.some((asset) => asset.id === error.vehicleId)))
            throw new ConductorInteriorError(409, error.code, "Der belegte Innenraum kann mit diesem Konfigurations- und Geometrieprofil nicht abgeleitet werden.", error.vehicleId, error.bodyId);
          throw error;
        }
        for (const vehicle of layout.vehicles) {
          const variant = VEHICLE_VARIANTS.find((row) => row.id === vehicle.artFamily);
          verify(variant !== undefined);
          for (const part of variant.parts) period.atlas.asset(access.worldId, `vehicle.${variant.id}.${part}`);
        }
        for (const motif of ["floor", "wall", "window", "door-closed", "door-open", "seat", "standing", "multipurpose", "wc", "cab", "gangway"])
          period.atlas.asset(access.worldId, `interior.${motif}`);
        return layout;
      });
    } catch (error) {
      if (error instanceof ConductorInteriorError) throw new ConductorInteriorError(error.statusCode, error.code, error.message, error.vehicleId, error.bodyId, telemetry);
      if (error instanceof AccessRevokedError) throw new ConductorInteriorError(403, "interior_access_denied", "Kein Zugriff auf diesen Innenraum.");
      throw new ConductorInteriorError(503, "interior_unavailable", "Der belegte Innenraum ist momentan nicht verfügbar.", undefined, undefined, telemetry);
    }
  }
}

/** Der Browser übermittelt nur den erwarteten bestehenden Stand, keine Projektionsfakten. */
export function registerConductorInteriorRoutes(app: FastifyInstance, deps: {
  readonly conductorInterior?: Pick<ConductorInteriorService, "layout">;
  readonly authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}): void {
  app.get<{ Params: { worldId: string; operatorId: string; formationId: string }; Querystring: { expectedFleetStateHash: string; periodId: string } }>(
    "/worlds/:worldId/operators/:operatorId/fleet/formations/:formationId/interior", {
      preHandler: deps.authenticate,
      errorHandler(error, request, reply) {
        const invalid = error.validation !== undefined;
        request.log.info({ event: "conductor_interior_result", outcome: "rejected", code: invalid ? "interior_request_invalid" : "interior_unavailable" });
        void reply.code(invalid ? 400 : 503).send({ code: invalid ? "interior_request_invalid" : "interior_unavailable",
          error: invalid ? "Die Innenraumanfrage ist ungültig." : "Der belegte Innenraum ist momentan nicht verfügbar." });
      },
      schema: {
        params: { type: "object", additionalProperties: false, required: ["worldId", "operatorId", "formationId"], properties: {
          worldId: { type: "string", format: "uuid" }, operatorId: { type: "string", format: "uuid" }, formationId: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$" } } },
        querystring: { type: "object", additionalProperties: false, required: ["expectedFleetStateHash", "periodId"], properties: {
          expectedFleetStateHash: { type: "string", pattern: "^[a-f0-9]{64}$" }, periodId: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$" } } },
      },
    }, async (request, reply) => {
      if (request.identity === undefined) return reply.code(401).send({ error: "Kein Zugriffstoken übermittelt." });
      if (deps.conductorInterior === undefined) {
        request.log.info({ event: "conductor_interior_result", outcome: "unavailable", code: "interior_disabled" });
        return reply.code(503).send({ code: "interior_disabled", error: "Der Innenraumzugriff ist für diese Welt nicht eingerichtet." });
      }
      try {
        const layout = await deps.conductorInterior.layout({ ...request.params, ...request.query, keycloakSubject: request.identity.keycloakSubject });
        request.log.info({ event: "conductor_interior_result", outcome: "built", code: "interior_built", worldId: layout.binding.worldId,
          periodId: layout.binding.periodId, formationRevision: layout.binding.formationRevision });
        return layout;
      }
      catch (error) {
        const failure = error instanceof ConductorInteriorError ? error : new ConductorInteriorError(503, "interior_unavailable", "Der belegte Innenraum ist momentan nicht verfügbar.");
        request.log.info({ event: "conductor_interior_result", outcome: "rejected", code: failure.code, ...failure.telemetry });
        return reply.code(failure.statusCode).send({ code: failure.code, error: failure.message, ...(failure.vehicleId === undefined ? {} : { vehicleId: failure.vehicleId }),
          ...(failure.bodyId === undefined ? {} : { bodyId: failure.bodyId }) });
      }
    });
}
