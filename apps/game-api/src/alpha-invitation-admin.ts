import type { GameAdminCommandHandler } from "@zugfolge/commerce";
import { accountRoles, accounts, worldAccesses } from "@zugfolge/db";
import { type IdentityDatabase, type KeycloakAdminClient } from "@zugfolge/identity";
import { and, eq } from "drizzle-orm";

export function createAlphaInvitationAdminHandlers(options: { readonly db: IdentityDatabase; readonly keycloak: KeycloakAdminClient; readonly redirectUri: string }): Readonly<Record<"alpha_invitation_create" | "alpha_invitation_resend", GameAdminCommandHandler>> {
  const invitation = (context: Parameters<GameAdminCommandHandler>[0]) => {
    if (!context.payload.invitation) throw new Error("Einladungsdaten fehlen.");
    return context.payload.invitation;
  };
  return {
    async alpha_invitation_create(context) {
      const input = invitation(context);
      const subject = await options.keycloak.invite({ email: input.email, displayName: input.displayName, redirectUri: options.redirectUri });
      await options.db.transaction(async (tx) => {
        await tx.insert(worldAccesses).values({ worldId: context.payload.worldId, keycloakSubject: subject }).onConflictDoNothing();
        const [account] = await tx.insert(accounts).values({ worldId: context.payload.worldId, keycloakSubject: subject, displayName: input.displayName }).onConflictDoUpdate({ target: [accounts.worldId, accounts.keycloakSubject], set: { displayName: input.displayName } }).returning({ id: accounts.id });
        if (!account) throw new Error("Weltkonto konnte nicht bereitgestellt werden.");
        await tx.insert(accountRoles).values({ worldId: context.payload.worldId, accountId: account.id, role: input.role }).onConflictDoNothing();
      });
      const [created] = await options.db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.worldId, context.payload.worldId), eq(accounts.keycloakSubject, subject))).limit(1);
      return { state: "completed", gameAuditEventId: `${input.requestReference}:${subject}`, result: { requestReference: input.requestReference, keycloakSubject: subject, gameAccountReference: created?.id } };
    },
    async alpha_invitation_resend(context) {
      const input = invitation(context);
      await options.keycloak.resend(input.keycloakSubject!, options.redirectUri);
      return { state: "completed", gameAuditEventId: `${input.requestReference}:${input.keycloakSubject}` };
    },
  };
}
