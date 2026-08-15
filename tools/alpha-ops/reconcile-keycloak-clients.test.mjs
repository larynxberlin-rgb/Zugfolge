import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fetchKeycloak, requestKeycloakAdminToken } from "./reconcile-keycloak-clients.mjs";

test("der produktive Start gleicht alle drei Browser-Clients idempotent ab", async () => {
  const compose = await readFile(new URL("../../compose.alpha.yml", import.meta.url), "utf8");
  const script = await readFile(new URL("./reconcile-keycloak-clients.mjs", import.meta.url), "utf8");
  assert.match(compose, /keycloak-reconcile:/);
  assert.match(compose, /reconcile-keycloak-clients\.mjs/);
  assert.match(script, /\["operations-center", process\.env\.OPERATIONS_CENTER_URL\]/);
  assert.match(script, /method: "PUT"/);
  assert.match(script, /accessTokenLifespan: 86_400/);
  assert.match(script, /ssoSessionIdleTimeout: 2_592_000/);
});

test("der produktive Abgleich verwendet bevorzugt das Realm-Servicekonto", async () => {
  const requests = [];
  const token = await requestKeycloakAdminToken({
    baseUrl: "http://keycloak:8080",
    realm: "zugfolge",
    clientId: "provisioner",
    clientSecret: "secret",
    username: "bootstrap",
    password: "bootstrap-secret",
  }, async (url, init) => {
    requests.push({ url, body: init?.body?.toString() });
    return Response.json({ access_token: "service-token" });
  });

  assert.equal(token, "service-token");
  assert.deepEqual(requests, [{
    url: "http://keycloak:8080/realms/zugfolge/protocol/openid-connect/token",
    body: "grant_type=client_credentials&client_id=provisioner&client_secret=secret",
  }]);
});

test("eine frische Installation kann auf das Bootstrapkonto zurueckfallen", async () => {
  let request;
  const token = await requestKeycloakAdminToken({
    baseUrl: "http://keycloak:8080",
    realm: "zugfolge",
    clientId: "",
    clientSecret: "",
    username: "bootstrap",
    password: "bootstrap-secret",
  }, async (url, init) => {
    request = { url, body: init?.body?.toString() };
    return Response.json({ access_token: "bootstrap-token" });
  });

  assert.equal(token, "bootstrap-token");
  assert.deepEqual(request, {
    url: "http://keycloak:8080/realms/master/protocol/openid-connect/token",
    body: "grant_type=password&client_id=admin-cli&username=bootstrap&password=bootstrap-secret",
  });
});

test("ein unvollstaendiges Servicekonto bricht fail-closed ab", async () => {
  await assert.rejects(
    requestKeycloakAdminToken({
      baseUrl: "http://keycloak:8080",
      realm: "zugfolge",
      clientId: "provisioner",
      clientSecret: "",
      username: "bootstrap",
      password: "bootstrap-secret",
    }, async () => {
      throw new Error("HTTP darf nicht aufgerufen werden");
    }),
    /Servicekonto.*unvollstaendig/u,
  );
});

test("voruebergehende Keycloak-Antworten werden begrenzt wiederholt", async () => {
  const statuses = [503, 503, 200];
  const delays = [];
  const response = await fetchKeycloak(
    "http://keycloak:8080/realms/zugfolge",
    {},
    "Keycloak lesen",
    async () => new Response(null, { status: statuses.shift() }),
    { attempts: 5, delayMs: 10, sleep: async (duration) => delays.push(duration) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(delays, [10, 20]);
});

test("dauerhafte Berechtigungsfehler werden nicht wiederholt", async () => {
  let requests = 0;
  await assert.rejects(
    fetchKeycloak(
      "http://keycloak:8080/admin/realms/zugfolge",
      {},
      "Realm aktualisieren",
      async () => {
        requests += 1;
        return new Response(null, { status: 403 });
      },
      { attempts: 5, delayMs: 0, sleep: async () => {} },
    ),
    /HTTP 403/u,
  );
  assert.equal(requests, 1);
});

test("das Provisionierungs-Servicekonto darf Realm und Browser-Clients abgleichen", async () => {
  const realm = JSON.parse(await readFile(new URL("../../ops/alpha/keycloak/zugfolge-realm.json", import.meta.url), "utf8"));
  const provisioner = realm.users.find((user) => user.serviceAccountClientId === "provisioner");
  assert.ok(provisioner);
  assert.deepEqual(
    new Set(provisioner.clientRoles["realm-management"]),
    new Set(["manage-users", "view-users", "query-users", "manage-realm", "manage-clients"]),
  );
});
