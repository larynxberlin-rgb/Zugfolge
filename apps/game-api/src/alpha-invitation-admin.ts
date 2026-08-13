import type { GameAdminCommandHandler } from "@zugfolge/commerce";
import { accountRoles, accounts, alphaWorldProfiles, worldAccesses, worlds } from "@zugfolge/db";
import { type IdentityDatabase, type KeycloakAdminClient } from "@zugfolge/identity";
import { and, eq, inArray, sql } from "drizzle-orm";

class AlphaInvitationWorldUnavailableError extends Error {
  constructor() {
    super("Alpha-Einladungen sind nur fuer eine aktive oeffentliche Zielwelt mit aktiver Tutorialwelt erlaubt.");
    this.name = "AlphaInvitationWorldUnavailableError";
  }
}

async function requireActiveInvitationWorlds(
  db: IdentityDatabase,
  targetWorldId: string,
  tutorialWorldId: string | undefined,
): Promise<string> {
  if (tutorialWorldId === undefined || tutorialWorldId === targetWorldId) {
    throw new AlphaInvitationWorldUnavailableError();
  }

  // Beide Welt- und Profilzeilen bleiben bis nach dem externen Keycloak-Aufruf
  // gesperrt. Ein paralleler Archivierungs- oder Profilwechsel kann damit nicht
  // zwischen Gate und Side-Effect rutschen.
  await db.execute(sql`
    select ${worlds.id}
    from ${worlds}
    where ${worlds.id} in (${targetWorldId}, ${tutorialWorldId})
    order by ${worlds.id}
    for update
  `);
  await db.execute(sql`
    select ${alphaWorldProfiles.worldId}
    from ${alphaWorldProfiles}
    where ${alphaWorldProfiles.worldId} in (${targetWorldId}, ${tutorialWorldId})
    order by ${alphaWorldProfiles.worldId}
    for update
  `);

  const rows = await db
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
    .where(inArray(worlds.id, [targetWorldId, tutorialWorldId]));
  const target = rows.find((row) => row.worldId === targetWorldId);
  const tutorial = rows.find((row) => row.worldId === tutorialWorldId);

  if (
    target?.lifecycleStatus !== "active"
    || target.worldKind !== "public"
    || target.rankingStatus !== "ranked"
    || target.profileKind !== "public"
    || target.profileState !== "running"
    || target.accelerationFactor !== 1
    || tutorial?.lifecycleStatus !== "active"
    || tutorial.worldKind !== "private"
    || tutorial.rankingStatus !== "unranked"
    || tutorial.profileKind !== "tutorial"
    || tutorial.profileState !== "running"
    || tutorial.accelerationFactor <= 1
  ) {
    throw new AlphaInvitationWorldUnavailableError();
  }
  return tutorialWorldId;
}

export function createAlphaInvitationAdminHandlers(options: { readonly db: IdentityDatabase; readonly keycloak: KeycloakAdminClient; readonly redirectUri: string; readonly tutorialWorldId?: string }): Readonly<Record<"alpha_invitation_create" | "alpha_invitation_resend", GameAdminCommandHandler>> {
  const invitation = (context: Parameters<GameAdminCommandHandler>[0]) => {
    if (!context.payload.invitation) throw new Error("Einladungsdaten fehlen.");
    return context.payload.invitation;
  };
  return {
    async alpha_invitation_create(context) {
      const input = invitation(context);
      return options.db.transaction(async (tx) => {
        const tutorialWorldId = await requireActiveInvitationWorlds(
          tx,
          context.payload.worldId,
          options.tutorialWorldId,
        );
        const subject = await options.keycloak.invite({ email: input.email, displayName: input.displayName, redirectUri: options.redirectUri });
        let tutorialAccountId: string | undefined;
        const worldIds = [context.payload.worldId, tutorialWorldId];
        for (const worldId of worldIds) {
          await tx.insert(worldAccesses).values({ worldId, keycloakSubject: subject }).onConflictDoNothing();
          const [account] = await tx.insert(accounts).values({ worldId, keycloakSubject: subject, displayName: input.displayName }).onConflictDoUpdate({ target: [accounts.worldId, accounts.keycloakSubject], set: { displayName: input.displayName } }).returning({ id: accounts.id });
          if (!account) throw new Error("Weltkonto konnte nicht bereitgestellt werden.");
          await tx.insert(accountRoles).values({ worldId, accountId: account.id, role: worldId === context.payload.worldId ? input.role : "player" }).onConflictDoNothing();
          if (worldId !== context.payload.worldId) tutorialAccountId = account.id;
        }
        const [created] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.worldId, context.payload.worldId), eq(accounts.keycloakSubject, subject))).limit(1);
        return { state: "completed", gameAuditEventId: `${input.requestReference}:${subject}`, result: { requestReference: input.requestReference, keycloakSubject: subject, gameAccountReference: created?.id, ...(tutorialAccountId === undefined ? {} : { tutorialAccountReference: tutorialAccountId }) } };
      });
    },
    async alpha_invitation_resend(context) {
      const input = invitation(context);
      return options.db.transaction(async (tx) => {
        await requireActiveInvitationWorlds(tx, context.payload.worldId, options.tutorialWorldId);
        await options.keycloak.resend(input.keycloakSubject!, options.redirectUri);
        return { state: "completed", gameAuditEventId: `${input.requestReference}:${input.keycloakSubject}` };
      });
    },
  };
}
