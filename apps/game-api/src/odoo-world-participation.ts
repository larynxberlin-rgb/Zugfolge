import type { AlphaWorldBlueprint } from "@zugfolge/alpha";
import type { WorldParticipationCommandHandler, WorldParticipationCommandResult } from "@zugfolge/commerce";
import {
  alphaWorldProfiles,
  worldAccesses,
  worldParticipations,
  worlds,
} from "@zugfolge/db";
import { decodeEconomyValue } from "@zugfolge/economy";
import { requestWorldAccess, type IdentityDatabase } from "@zugfolge/identity";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

function rejected(code: string): WorldParticipationCommandResult {
  return { state: "rejected", rejectionCode: code };
}

/**
 * Odoo gibt nur die bezahlte/kommerzielle Teilnahme frei. Das Game prueft
 * Weltphase und Kapazitaet unter einem Welt-Lock und erzeugt erst danach den
 * wirklichen Zugang. Keycloak-Rollen werden hier absichtlich nie gelesen.
 */
export function createWorldParticipationHandler(db: IdentityDatabase): WorldParticipationCommandHandler {
  return async (context) => db.transaction(async (tx) => {
    const payload = context.payload;
    const [world] = await tx.select({ lifecycle: worlds.lifecycleStatus }).from(worlds)
      .where(eq(worlds.id, payload.worldId)).limit(1);
    if (world === undefined) return rejected("world_not_found");
    await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${payload.worldId} for update`);
    const [profile] = await tx.select({
      state: alphaWorldProfiles.state,
      profileKind: alphaWorldProfiles.profileKind,
      blueprint: alphaWorldProfiles.blueprint,
    }).from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, payload.worldId)).limit(1);
    if (profile === undefined || profile.profileKind !== "public") return rejected("world_not_public");
    const blueprint = decodeEconomyValue(profile.blueprint) as AlphaWorldBlueprint;
    if (blueprint.schemaVersion !== "zugfolge-alpha-world-blueprint/v2" || blueprint.admission === undefined || blueprint.publicMetadata === undefined) {
      return rejected("world_contract_unavailable");
    }

    const [existing] = await tx.select().from(worldParticipations).where(and(
      eq(worldParticipations.worldId, payload.worldId),
      eq(worldParticipations.keycloakSubject, payload.keycloakSubject),
    )).limit(1);
    if (existing?.lastIdempotencyKey === payload.idempotencyKey && existing.state !== "provisioning") {
      return {
        state: existing.state,
        participationId: existing.id,
        rejectionCode: existing.rejectionCode ?? undefined,
      };
    }

    const common = {
      displayName: payload.displayName,
      odooPartnerReference: payload.odooPartnerReference,
      odooOrderReference: payload.odooOrderReference,
      paymentReference: payload.paymentReference,
      lastIdempotencyKey: payload.idempotencyKey,
      correlationId: context.correlationId,
      changedAt: context.now,
    };
    if (payload.action === "cancel" || payload.action === "refund") {
      if (existing === undefined) return rejected("participation_not_found");
      const state = payload.action === "refund" ? "refunded" : "cancelled";
      await tx.update(worldParticipations).set({ ...common, state, rejectionCode: null }).where(and(
        eq(worldParticipations.worldId, payload.worldId), eq(worldParticipations.id, existing.id),
      ));
      await tx.update(worldAccesses).set({ status: "revoked", revokedAt: context.now }).where(and(
        eq(worldAccesses.worldId, payload.worldId), eq(worldAccesses.keycloakSubject, payload.keycloakSubject), eq(worldAccesses.status, "active"),
      ));
      return { state, participationId: existing.id };
    }

    const admissionOpen = blueprint.admission.status === "open"
      && (blueprint.publicMetadata.phase === "registration_open" || blueprint.publicMetadata.phase === "active")
      && profile.state === "running" && world.lifecycle === "active";
    let rejectionCode: string | undefined;
    if (!admissionOpen) rejectionCode = "admission_closed";
    if (rejectionCode === undefined) {
      const occupied = await tx.select({ id: worldParticipations.id }).from(worldParticipations).where(and(
        eq(worldParticipations.worldId, payload.worldId),
        inArray(worldParticipations.state, ["provisioning", "active"]),
        ...(existing === undefined ? [] : [ne(worldParticipations.id, existing.id)]),
      ));
      if (occupied.length >= blueprint.admission.capacity) rejectionCode = "capacity_full";
    }
    if (rejectionCode !== undefined) {
      let participationId = existing?.id;
      if (existing === undefined) {
        const [created] = await tx.insert(worldParticipations).values({
          worldId: payload.worldId,
          keycloakSubject: payload.keycloakSubject,
          ...common,
          state: "rejected",
          rejectionCode,
          createdAt: context.now,
        }).returning({ id: worldParticipations.id });
        participationId = created?.id;
      } else {
        await tx.update(worldParticipations).set({ ...common, state: "rejected", rejectionCode }).where(and(
          eq(worldParticipations.worldId, payload.worldId), eq(worldParticipations.id, existing.id),
        ));
      }
      return { state: "rejected", participationId, rejectionCode };
    }

    let participationId = existing?.id;
    if (existing === undefined) {
      const [created] = await tx.insert(worldParticipations).values({
        worldId: payload.worldId,
        keycloakSubject: payload.keycloakSubject,
        ...common,
        state: "provisioning",
        createdAt: context.now,
      }).returning({ id: worldParticipations.id });
      participationId = created?.id;
    } else {
      await tx.update(worldParticipations).set({ ...common, state: "provisioning", rejectionCode: null }).where(and(
        eq(worldParticipations.worldId, payload.worldId), eq(worldParticipations.id, existing.id),
      ));
      await tx.update(worldAccesses).set({ status: "active", revokedAt: null }).where(and(
        eq(worldAccesses.worldId, payload.worldId), eq(worldAccesses.keycloakSubject, payload.keycloakSubject), eq(worldAccesses.status, "revoked"),
      ));
    }
    if (participationId === undefined) throw new Error("Weltteilnahme konnte nicht persistiert werden.");
    const account = await requestWorldAccess(tx, {
      worldId: payload.worldId,
      keycloakSubject: payload.keycloakSubject,
      displayName: payload.displayName,
    });
    await tx.update(worldParticipations).set({ state: "active", rejectionCode: null, changedAt: context.now }).where(and(
      eq(worldParticipations.worldId, payload.worldId), eq(worldParticipations.id, participationId),
    ));
    return { state: "active", participationId, gameAccountReference: account.id };
  });
}
