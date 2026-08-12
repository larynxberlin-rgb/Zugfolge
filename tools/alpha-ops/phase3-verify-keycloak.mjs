const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Phase-3-Parameter ${name} fehlt.`);
  return value;
};

const baseUrl = required("KEYCLOAK_ADMIN_URL").replace(/\/$/, "");
const realm = required("KEYCLOAK_REALM");
const clientId = required("KEYCLOAK_ADMIN_CLIENT_ID");
const clientSecret = required("KEYCLOAK_ADMIN_CLIENT_SECRET");
const subject = required("PHASE3_KEYCLOAK_SUBJECT");
const tokenResponse = await fetch(`${baseUrl}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
});
if (!tokenResponse.ok) throw new Error(`Keycloak-Token antwortete mit HTTP ${tokenResponse.status}.`);
const tokenBody = await tokenResponse.json();
if (typeof tokenBody.access_token !== "string") throw new Error("Keycloak-Token fehlt.");
const userResponse = await fetch(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}/users/${encodeURIComponent(subject)}`, {
  headers: { authorization: `Bearer ${tokenBody.access_token}` },
});
if (!userResponse.ok) throw new Error(`Keycloak-Benutzerpruefung antwortete mit HTTP ${userResponse.status}.`);
const user = await userResponse.json();
if (user.id !== subject || user.enabled !== false) throw new Error("Keycloak-Identitaet ist nach dem Vier-Augen-Entzug noch aktiv.");
process.stdout.write(`${JSON.stringify({ schema: "zugfolge-keycloak-revocation-proof/v1", subject, enabled: false })}\n`);
