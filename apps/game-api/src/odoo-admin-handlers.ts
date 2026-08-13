import { accounts, alphaWorldProfiles, odooProjectionOutbox, worldAccesses, worlds } from "@zugfolge/db";
import { decodeEconomyValue, parseStartingCapitalPolicy, serializeStartingCapitalPolicy } from "@zugfolge/economy";
import {
  validateWorldBlueprint,
  effectiveStartingCapitalPolicy,
  type AbuseGuard,
  type AlphaWorldBlueprint,
  type InfraUpdateService,
  type WorldEndService,
} from "@zugfolge/alpha";
import {
  canonicalJson,
  enqueueGameAdminCapabilityProjection,
  type GameAdminCommandContext,
  type GameAdminCommandHandler,
  type GameAdminCapabilityProjection,
} from "@zugfolge/commerce";
import type { IdentityDatabase, KeycloakAdminClient } from "@zugfolge/identity";
import type { FleetRuntime } from "@zugfolge/runtime-native";
import type { LivemapRegistry } from "@zugfolge/livemap-stream";
import type { OperationsRegistry } from "@zugfolge/dispatch";
import { and, eq, sql } from "drizzle-orm";

import {
  ProductionWorldStartPort,
  parseSignedAlphaWorldDeployment,
  persistSignedAlphaWorldDeployment,
  startSignedAlphaWorld,
  type SignedAlphaWorldDeployment,
} from "./alpha-world-start.js";
import type { RegionalSimulationWorker } from "./regional-simulation-worker.js";

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

export const WORLD_DEPLOY_CAPABILITY: GameAdminCapabilityProjection = Object.freeze({
  actionType: "world_deploy",
  availability: "available",
  detail: "Game prueft Ed25519-Signatur, Deployment- und Blueprint-Hash, Weltdefinition sowie Startkapital und startet erst danach alle autoritativen Projektionen.",
});

/** Weltunabhaengige, signierte Capability-Projektion fuer die Anlage neuer Welten. */
export const WORLD_DEPLOY_CAPABILITY_SCOPE_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Der globale Weltstartvertrag und alle aktuell registrierten Welten muessen
 * in jedem Bridge-Zyklus erneut aus der Live-Registry abgeleitet werden. Ein
 * beim Prozessstart eingefrorener Satz wuerde spaeter aktivierte Welten bis
 * zum Neustart von Odoo abschneiden.
 */
export function worldIdsForOdooProjectionDispatch(
  activeWorldIds: readonly string[],
  pendingOutboxWorldIds: readonly string[] = [],
): readonly string[] {
  return [...new Set([
    WORLD_DEPLOY_CAPABILITY_SCOPE_ID,
    ...activeWorldIds,
    ...pendingOutboxWorldIds,
  ])].sort();
}

export class WorldDeploymentAdminError extends Error {
  constructor(readonly code: "schema" | "world_conflict" | "projection_conflict") {
    super(`Welt-Deployment wurde abgelehnt: ${code}.`);
    this.name = "WorldDeploymentAdminError";
  }
}

/**
 * Legt die weltgebundenen Capabilities eines frisch gestarteten Deployments
 * atomar und idempotent in die Outbox. Ein Fehler rollt den gesamten Satz
 * zurueck; ein Command-Retry ergaenzt deshalb weder Duplikate noch Teilsicht.
 */
export async function enqueueStartedWorldCapabilities(
  db: IdentityDatabase,
  input: {
    readonly worldId: string;
    readonly deploymentHash: string;
    readonly capabilities: readonly GameAdminCapabilityProjection[];
    readonly occurredAt: Date;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${input.worldId} for update`);
    for (const capability of input.capabilities) {
      const correlationId = `world-deploy:${input.deploymentHash}:${capability.actionType}`;
      const [existing] = await tx.select({
        payload: odooProjectionOutbox.payload,
      }).from(odooProjectionOutbox).where(and(
        eq(odooProjectionOutbox.worldId, input.worldId),
        eq(odooProjectionOutbox.messageType, "admin.capability.projection"),
        eq(odooProjectionOutbox.correlationId, correlationId),
      )).limit(1);
      if (existing !== undefined) {
        // PostgreSQL jsonb normalisiert die Schluesselreihenfolge. Der
        // idempotente Retry muss deshalb den JSON-Inhalt vergleichen und darf
        // nicht von der urspruenglichen Objekt-Reihenfolge abhaengen.
        if (canonicalJson(existing.payload) !== canonicalJson(capability)) {
          throw new WorldDeploymentAdminError("projection_conflict");
        }
        continue;
      }
      await enqueueGameAdminCapabilityProjection(tx, {
        worldId: input.worldId,
        correlationId,
        capability,
        occurredAt: input.occurredAt,
      });
    }
  });
}

export async function ensureSignedPlanningAuthority(
  db: IdentityDatabase,
  signed: SignedAlphaWorldDeployment,
): Promise<void> {
  const { accountId, keycloakSubject, displayName } = signed.deployment.planning.authority;
  await db.transaction(async (tx) => {
    await tx.insert(worldAccesses).values({
      worldId: signed.deployment.worldId,
      keycloakSubject,
    }).onConflictDoNothing();
    await tx.insert(accounts).values({
      id: accountId,
      worldId: signed.deployment.worldId,
      keycloakSubject,
      displayName,
    }).onConflictDoNothing();
    const [access] = await tx.select({ status: worldAccesses.status }).from(worldAccesses).where(and(
      eq(worldAccesses.worldId, signed.deployment.worldId),
      eq(worldAccesses.keycloakSubject, keycloakSubject),
    )).limit(1);
    const [account] = await tx.select({
      id: accounts.id,
      keycloakSubject: accounts.keycloakSubject,
      displayName: accounts.displayName,
      erasedAt: accounts.erasedAt,
    }).from(accounts).where(and(
      eq(accounts.worldId, signed.deployment.worldId),
      eq(accounts.id, accountId),
    )).limit(1);
    if (
      access?.status !== "active"
      || account?.keycloakSubject !== keycloakSubject
      || account.displayName !== displayName
      || account.erasedAt !== null
    ) throw new WorldDeploymentAdminError("projection_conflict");
  });
}

export function createWorldDeployAdminHandler(options: {
  readonly db: IdentityDatabase;
  readonly trustedKeys: Readonly<Record<string, string>>;
  readonly fleetRuntime: FleetRuntime;
  readonly regionalSimulation: RegionalSimulationWorker;
  readonly livemap: LivemapRegistry;
  readonly operations: OperationsRegistry;
  readonly registerStartedWorld?: (world: {
    readonly signed: SignedAlphaWorldDeployment;
    readonly epoch: Date;
    readonly occurredAt: Date;
  }) => void | Promise<void>;
}): GameAdminCommandHandler {
  return async (context) => {
    const { payload } = context;
    if (
      payload.kind !== "admin.world_deploy"
      || payload.actionType !== "world_deploy"
      || payload.riskClass !== "high"
      || payload.signedDeployment === undefined
      || payload.worldDefinition === undefined
      || payload.startingCapitalPolicy === undefined
      || payload.deploymentHash === undefined
    ) throw new WorldDeploymentAdminError("schema");
    const signed = parseSignedAlphaWorldDeployment(payload.signedDeployment, options.trustedKeys);
    const blueprint = signed.deployment.blueprint;
    const policy = serializeStartingCapitalPolicy(parseStartingCapitalPolicy(payload.startingCapitalPolicy));
    const blueprintPolicy = serializeStartingCapitalPolicy(effectiveStartingCapitalPolicy(blueprint));
    const signedDefinition = signed.deployment.worldDefinition;
    if (
      signed.deployment.worldId !== payload.worldId
      || signed.deploymentHash !== payload.deploymentHash
      || blueprint.profileKind !== payload.worldDefinition.kind
      || JSON.stringify(blueprintPolicy) !== JSON.stringify(policy)
      || signedDefinition.name !== payload.worldDefinition.name
      || signedDefinition.kind !== payload.worldDefinition.kind
      || signedDefinition.rankingStatus !== payload.worldDefinition.rankingStatus
      || signedDefinition.schedulePeriodWeeks !== payload.worldDefinition.schedulePeriodWeeks
      || new Date(signedDefinition.epoch).getTime() !== new Date(payload.worldDefinition.epoch).getTime()
    ) throw new WorldDeploymentAdminError("schema");
    const expectedWorld = {
      name: signedDefinition.name,
      schedulePeriodWeeks: signedDefinition.schedulePeriodWeeks,
      epoch: new Date(signedDefinition.epoch),
      worldKind: signedDefinition.kind === "public" ? "public" as const : "private" as const,
      rankingStatus: signedDefinition.rankingStatus,
    };
    let [world] = await options.db.select().from(worlds).where(eq(worlds.id, payload.worldId)).limit(1);
    if (world === undefined) {
      [world] = await options.db.insert(worlds).values({
        id: payload.worldId,
        ...expectedWorld,
        lifecycleStatus: "provisioning",
      }).onConflictDoNothing().returning();
      if (world === undefined) [world] = await options.db.select().from(worlds).where(eq(worlds.id, payload.worldId)).limit(1);
    }
    if (
      world === undefined
      || world.name !== expectedWorld.name
      || world.schedulePeriodWeeks !== expectedWorld.schedulePeriodWeeks
      || world.epoch.getTime() !== expectedWorld.epoch.getTime()
      || world.worldKind !== expectedWorld.worldKind
      || world.rankingStatus !== expectedWorld.rankingStatus
      || world.lifecycleStatus === "archived"
    ) throw new WorldDeploymentAdminError("world_conflict");
    const existingProfile = (await options.db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, payload.worldId)).limit(1))[0];
    if (world.lifecycleStatus === "active" && existingProfile?.state !== "running") {
      throw new WorldDeploymentAdminError("world_conflict");
    }
    if (existingProfile !== undefined) {
      const existing = decodeEconomyValue(existingProfile.blueprint) as AlphaWorldBlueprint;
      if (
        existingProfile.blueprintHash !== validateWorldBlueprint(blueprint)
        || existingProfile.deploymentHash !== null && existingProfile.deploymentHash !== signed.deploymentHash
        || JSON.stringify(serializeStartingCapitalPolicy(effectiveStartingCapitalPolicy(existing))) !== JSON.stringify(policy)
      ) throw new WorldDeploymentAdminError("projection_conflict");
    }
    await ensureSignedPlanningAuthority(options.db, signed);
    await persistSignedAlphaWorldDeployment(options.db, signed);
    const port = new ProductionWorldStartPort(
      options.db,
      signed,
      options.fleetRuntime,
      options.regionalSimulation,
      options.livemap,
      options.operations,
    );
    const profile = await startSignedAlphaWorld(options.db, signed, port);
    if (world.lifecycleStatus === "provisioning") {
      const [activated] = await options.db.update(worlds).set({ lifecycleStatus: "active" }).where(and(
        eq(worlds.id, payload.worldId),
        eq(worlds.lifecycleStatus, "provisioning"),
      )).returning({ id: worlds.id });
      if (activated === undefined) {
        const [concurrent] = await options.db.select({ lifecycleStatus: worlds.lifecycleStatus }).from(worlds).where(eq(worlds.id, payload.worldId)).limit(1);
        if (concurrent?.lifecycleStatus !== "active") throw new WorldDeploymentAdminError("world_conflict");
      }
    }
    // Ab hier ist die signierte Weltwirkung dauerhaft aktiv. Scheitert nur
    // noch die prozesslokale Registry oder eine Odoo-Folgeprojektion, muss der
    // Queue-Worker denselben Wirkungs-Key retrybar nachholen und darf niemals
    // eine fachliche Ablehnung projizieren.
    context.markEffectApplied?.();
    await options.registerStartedWorld?.({ signed, epoch: expectedWorld.epoch, occurredAt: context.now });
    return {
      state: "completed",
      gameAuditEventId: `world-deploy:${payload.worldId}:${signed.deploymentHash}`,
      result: {
        profileKind: profile.profileKind,
        blueprintHash: profile.blueprintHash,
        deploymentHash: signed.deploymentHash,
        startingCapitalPolicy: policy,
      },
    };
  };
}

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
    const sanction = await abuse.activateSevere(payload.worldId, payload.targetReference, context.effectIdempotencyKey);
    return { state: "completed", gameAuditEventId: `abuse-sanction:${payload.worldId}:${sanction.id}:active` };
  };
}

export function createWorldCloseAdminHandler(worldEnd: WorldEndService): GameAdminCommandHandler {
  return async (context) => {
    const { payload } = context;
    if (payload.kind !== "admin.world_close" || payload.actionType !== "world_close" || payload.riskClass !== "high" || payload.requestedAtS === undefined) {
      throw new WorldAccessAdminError("schema");
    }
    const profile = await worldEnd.beginClosure(payload.worldId, payload.requestedAtS, context.effectIdempotencyKey);
    return { state: "completed", gameAuditEventId: `world-close:${payload.worldId}:${profile.closingAtS}` };
  };
}

export function createInfraReleaseAdoptionAdminHandler(infra: InfraUpdateService): GameAdminCommandHandler {
  return async (context) => {
    const { payload } = context;
    if (payload.kind !== "admin.infra_release_adoption" || payload.actionType !== "infra_release_adoption" || payload.riskClass !== "high" || payload.releaseHash === undefined || payload.requestedPeriodStart === undefined) {
      throw new WorldAccessAdminError("schema");
    }
    const scheduled = await infra.approveStagedAt(payload.worldId, payload.releaseHash, context.effectIdempotencyKey, new Date(payload.requestedPeriodStart));
    return { state: "completed", gameAuditEventId: `infra-release:${payload.worldId}:${scheduled.id}:scheduled` };
  };
}
