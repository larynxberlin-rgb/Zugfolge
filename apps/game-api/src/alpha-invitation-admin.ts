import type { GameAdminCommandHandler } from "@zugfolge/commerce";
import { accountRoles, accounts, alphaWorldProfiles, worldAccesses, worlds } from "@zugfolge/db";
import { type IdentityDatabase, type KeycloakAdminClient } from "@zugfolge/identity";
import { and, eq, sql } from "drizzle-orm";

class AlphaInvitationWorldUnavailableError extends Error {
  constructor() {
    super("Alpha-Einladungen sind nur fuer eine aktive oeffentliche Zielwelt erlaubt.");
    this.name = "AlphaInvitationWorldUnavailableError";
  }
}

async function requireActiveInvitationWorld(
  db: IdentityDatabase,
  targetWorldId: string,
): Promise<void> {
  // Welt- und Profilzeile bleiben bis nach dem externen Keycloak-Aufruf
  // gesperrt. Ein paralleler Archivierungs- oder Profilwechsel kann damit nicht
  // zwischen Gate und Side-Effect rutschen.
  await db.execute(sql`
    select ${worlds.id}
    from ${worlds}
    where ${worlds.id} = ${targetWorldId}
    for update
  `);
  await db.execute(sql`
    select ${alphaWorldProfiles.worldId}
    from ${alphaWorldProfiles}
    where ${alphaWorldProfiles.worldId} = ${targetWorldId}
    for update
  `);

  const [target] = await db
    .select({
      worldId: worlds.id,
      lifecycleStatus: worlds.lifecycleStatus,
      worldKind: worlds.worldKind,
      rankingStatus: worlds.rankingStatus,
      profileKind: alphaWorldProfiles.profileKind,
      profileState: alphaWorldProfiles.state,
      accelerationFactor: alphaWorldProfiles.accelerationFactor,
    })
    .from(worlds)
    .innerJoin(alphaWorldProfiles, eq(alphaWorldProfiles.worldId, worlds.id))
    .where(eq(worlds.id, targetWorldId))
    .limit(1);

  if (
    target?.lifecycleStatus !== "active"
    || target.worldKind !== "public"
    || target.rankingStatus !== "ranked"
    || target.profileKind !== "public"
    || target.profileState !== "running"
    || target.accelerationFactor !== 1
  ) {
    throw new AlphaInvitationWorldUnavailableError();
  }
}

export function createAlphaInvitationAdminHandlers(options: { readonly db: IdentityDatabase; readonly keycloak: KeycloakAdminClient; readonly redirectUri: string }): Readonly<Record<"alpha_invitation_create" | "alpha_invitation_resend", GameAdminCommandHandler>> {
  const invitation = (context: Parameters<GameAdminCommandHandler>[0]) => {
    if (!context.payload.invitation) throw new Error("Einladungsdaten fehlen.");
    return context.payload.invitation;
  };
  return {
    async alpha_invitation_create(context) {
      const input = invitation(context);
      return options.db.transaction(async (tx) => {
        await requireActiveInvitationWorld(tx, context.payload.worldId);
        const subject = await options.keycloak.invite({ email: input.email, displayName: input.displayName, redirectUri: options.redirectUri });
        await tx.insert(worldAccesses).values({ worldId: context.payload.worldId, keycloakSubject: subject }).onConflictDoNothing();
        const [account] = await tx.insert(accounts).values({ worldId: context.payload.worldId, keycloakSubject: subject, displayName: input.displayName }).onConflictDoUpdate({ target: [accounts.worldId, accounts.keycloakSubject], set: { displayName: input.displayName } }).returning({ id: accounts.id });
        if (!account) throw new Error("Weltkonto konnte nicht bereitgestellt werden.");
        await tx.insert(accountRoles).values({ worldId: context.payload.worldId, accountId: account.id, role: input.role }).onConflictDoNothing();
        const [created] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.worldId, context.payload.worldId), eq(accounts.keycloakSubject, subject))).limit(1);
        return { state: "completed", gameAuditEventId: `${input.requestReference}:${subject}`, result: { requestReference: input.requestReference, keycloakSubject: subject, gameAccountReference: created?.id } };
      });
    },
    async alpha_invitation_resend(context) {
      const input = invitation(context);
      return options.db.transaction(async (tx) => {
        await requireActiveInvitationWorld(tx, context.payload.worldId);
        await options.keycloak.resend(input.keycloakSubject!, options.redirectUri);
        return { state: "completed", gameAuditEventId: `${input.requestReference}:${input.keycloakSubject}` };
      });
    },
  };
}
