import { worldAccesses } from "@zugfolge/db";
import type { AbuseGuard, InfraUpdateService, WorldEndService } from "@zugfolge/alpha";
import type { GameAdminCommandContext, GameAdminCommandHandler, GameAdminCapabilityProjection } from "@zugfolge/commerce";
import type { IdentityDatabase, KeycloakAdminClient } from "@zugfolge/identity";
import { and, eq } from "drizzle-orm";

export const WORLD_ACCESS_REVOKE_CAPABILITY: GameAdminCapabilityProjection = Object.freeze({
  actionType: "world_access_revoke",
  availability: "available",
  detail: "M9 Odoo-Vier-Augen-Pfad aktiv; Game prueft Weltbindung, deaktiviert die Keycloak-Identitaet und entzieht den bestehenden Zugang idempotent.",
});

export const ABUSE_SANCTION_ACTIVATE_CAPABILITY: GameAdminCapabilityProjection = Object.freeze({
  actionType: "abuse_sanction_activate",
  availability: "available",
  detail: "M9 Missbrauchsschutz aktiv; nur zuvor erklaerbar vorgeschlagene Sanktionen werden nach Vier-Augen-Freigabe aktiviert.",
});

export const WORLD_CLOSE_CAPABILITY: GameAdminCapabilityProjection = Object.freeze({
  actionType: "world_close",
  availability: "available",
  detail: "M9 Weltabschluss aktiv; Game prueft Weltprofil, letzte Periode und erzeugt den Abschluss ausschliesslich serverautoritativ.",
});

export const INFRA_RELEASE_ADOPTION_CAPABILITY: GameAdminCapabilityProjection = Object.freeze({
  actionType: "infra_release_adoption",
  availability: "available",
  detail: "M9.10 aktiv; Odoo kann nur einen vorab signierten, rechte- und konfliktgeprueften Game-Kandidaten fuer den naechsten Periodenwechsel freigeben.",
});

export class WorldAccessAdminError extends Error {
  constructor(readonly code: "schema" | "not_found") {
    super(`Weltzugang konnte nicht entzogen werden: ${code}.`);
    this.name = "WorldAccessAdminError";
  }
}

export function createWorldAccessRevokeAdminHandler(options: {
  readonly db: IdentityDatabase;
  readonly keycloak: Pick<KeycloakAdminClient, "disable">;
}): GameAdminCommandHandler {
  return async (context: GameAdminCommandContext) => {
    const { payload } = context;
    if (payload.kind !== "admin.world_access_revoke" || payload.actionType !== "world_access_revoke" || payload.riskClass !== "high" || payload.targetReference === undefined || payload.targetReference.trim() === "") {
      throw new WorldAccessAdminError("schema");
    }
    const [existing] = await options.db.select({ id: worldAccesses.id, status: worldAccesses.status }).from(worldAccesses).where(and(
      eq(worldAccesses.worldId, payload.worldId), eq(worldAccesses.keycloakSubject, payload.targetReference),
    )).limit(1);
    if (existing === undefined) throw new WorldAccessAdminError("not_found");

    // Die externe Deaktivierung ist idempotent. Sie erfolgt vor dem lokalen
    // Commit, damit ein Keycloak-Fehler den Weltzugang nicht halb entzieht;
    // nach erfolgreicher Deaktivierung kann jeder Retry den Game-Commit sicher
    // nachholen.
    await options.keycloak.disable(payload.targetReference);
    if (existing.status === "active") {
      await options.db.update(worldAccesses).set({ status: "revoked", revokedAt: context.now }).where(and(
        eq(worldAccesses.worldId, payload.worldId),
        eq(worldAccesses.keycloakSubject, payload.targetReference),
        eq(worldAccesses.status, "active"),
      ));
    }
    return {
      state: "completed",
      gameAuditEventId: `world-access:${payload.worldId}:${existing.id}:revoked`,
      result: { keycloakSubject: payload.targetReference, revokedWorldId: payload.worldId },
    };
  };
}

export function createAbuseSanctionActivateAdminHandler(abuse: AbuseGuard): GameAdminCommandHandler {
  return async (context) => {
    const { payload } = context;
    if (payload.kind !== "admin.abuse_sanction_activate" || payload.actionType !== "abuse_sanction_activate" || payload.riskClass !== "high" || payload.targetReference === undefined) {
      throw new WorldAccessAdminError("schema");
    }
    const sanction = await abuse.activateSevere(payload.worldId, payload.targetReference, context.adminRequestId);
    return { state: "completed", gameAuditEventId: `abuse-sanction:${payload.worldId}:${sanction.id}:active` };
  };
}

export function createWorldCloseAdminHandler(worldEnd: WorldEndService): GameAdminCommandHandler {
  return async (context) => {
    const { payload } = context;
    if (payload.kind !== "admin.world_close" || payload.actionType !== "world_close" || payload.riskClass !== "high" || payload.requestedAtS === undefined) {
      throw new WorldAccessAdminError("schema");
    }
    const profile = await worldEnd.beginClosure(payload.worldId, payload.requestedAtS, context.adminRequestId);
    return { state: "completed", gameAuditEventId: `world-close:${payload.worldId}:${profile.closingAtS}` };
  };
}

export function createInfraReleaseAdoptionAdminHandler(infra: InfraUpdateService): GameAdminCommandHandler {
  return async (context) => {
    const { payload } = context;
    if (payload.kind !== "admin.infra_release_adoption" || payload.actionType !== "infra_release_adoption" || payload.riskClass !== "high" || payload.releaseHash === undefined || payload.requestedPeriodStart === undefined) {
      throw new WorldAccessAdminError("schema");
    }
    const scheduled = await infra.approveStagedAt(payload.worldId, payload.releaseHash, context.adminRequestId, new Date(payload.requestedPeriodStart));
    return { state: "completed", gameAuditEventId: `infra-release:${payload.worldId}:${scheduled.id}:scheduled` };
  };
}
