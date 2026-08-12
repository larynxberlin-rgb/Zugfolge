export interface KeycloakAdminConfig { readonly baseUrl: string; readonly realm: string; readonly clientId: string; readonly clientSecret: string }
export interface KeycloakInvitation { readonly email: string; readonly displayName: string; readonly redirectUri: string }
export interface KeycloakAdminClient { invite(invitation: KeycloakInvitation): Promise<string>; resend(subject: string, redirectUri: string): Promise<void>; disable(subject: string): Promise<void> }

export function createKeycloakAdminClient(config: KeycloakAdminConfig, fetchImplementation: typeof fetch = fetch): KeycloakAdminClient {
  const base = config.baseUrl.replace(/\/$/, "");
  const realm = encodeURIComponent(config.realm);
  const realmBase = `${base}/admin/realms/${realm}`;
  async function token(): Promise<string> {
    const response = await fetchImplementation(`${base}/realms/${realm}/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: config.clientId, client_secret: config.clientSecret }) });
    if (!response.ok) throw new Error(`Keycloak-Admin-Token antwortet mit HTTP ${response.status}.`);
    const payload = await response.json() as { readonly access_token?: unknown };
    if (typeof payload.access_token !== "string") throw new Error("Keycloak-Admin-Token fehlt.");
    return payload.access_token;
  }
  async function executeActions(subject: string, redirectUri: string, bearer: string): Promise<void> {
    const response = await fetchImplementation(`${realmBase}/users/${encodeURIComponent(subject)}/execute-actions-email?client_id=game-web&redirect_uri=${encodeURIComponent(redirectUri)}`, { method: "PUT", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(["VERIFY_EMAIL", "UPDATE_PASSWORD"]) });
    if (!response.ok) throw new Error(`Keycloak-Einladungsmail antwortet mit HTTP ${response.status}.`);
  }
  return {
    async invite(invitation) {
      const bearer = await token();
      const response = await fetchImplementation(`${realmBase}/users`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ username: invitation.email, email: invitation.email, firstName: invitation.displayName, enabled: true, emailVerified: false, requiredActions: ["VERIFY_EMAIL", "UPDATE_PASSWORD"] }) });
      let subject = response.headers.get("location")?.split("/").pop();
      if (response.status === 409) {
        const existing = await fetchImplementation(`${realmBase}/users?exact=true&email=${encodeURIComponent(invitation.email)}`, { headers: { authorization: `Bearer ${bearer}` } });
        const matches = existing.ok ? await existing.json() as readonly { readonly id?: unknown }[] : [];
        subject = typeof matches[0]?.id === "string" ? matches[0].id : undefined;
      } else if (response.status !== 201) {
        throw new Error(`Keycloak-Bereitstellung antwortet mit HTTP ${response.status}.`);
      }
      if (!subject) throw new Error("Keycloak-Bereitstellung lieferte kein Subject.");
      await executeActions(subject, invitation.redirectUri, bearer);
      return subject;
    },
    async resend(subject, redirectUri) { await executeActions(subject, redirectUri, await token()); },
    async disable(subject) {
      const response = await fetchImplementation(`${realmBase}/users/${encodeURIComponent(subject)}`, { method: "PUT", headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
      if (!response.ok) throw new Error(`Keycloak-Sperre antwortet mit HTTP ${response.status}.`);
    },
  };
}

export function loadKeycloakAdminConfigFromEnv(env: NodeJS.ProcessEnv = process.env): KeycloakAdminConfig {
  const required = (name: string): string => { const value = env[name]; if (!value) throw new Error(`${name} muss gesetzt sein.`); return value; };
  return { baseUrl: required("KEYCLOAK_ADMIN_URL"), realm: required("KEYCLOAK_REALM"), clientId: required("KEYCLOAK_ADMIN_CLIENT_ID"), clientSecret: required("KEYCLOAK_ADMIN_CLIENT_SECRET") };
}
