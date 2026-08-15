import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBrowserAccessToken } from "./index.js";

const values = new Map<string, string>();
const configuration = { keycloakUrl: "https://id.example", realm: "zugfolge", clientId: "game-web" };

beforeEach(() => {
  values.clear();
  vi.restoreAllMocks();
  vi.stubGlobal("sessionStorage", {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
    removeItem: (name: string) => values.delete(name),
  });
});

describe("Browser-OIDC", () => {
  it("erneuert ein abgelaufenes Zugriffstoken ohne sichtbare Neuanmeldung", async () => {
    values.set("zugfolge.oidc.game-web.accessToken", "alt");
    values.set("zugfolge.oidc.game-web.accessTokenExpiresAt", "1");
    values.set("zugfolge.oidc.game-web.refreshToken", "refresh");
    values.set("zugfolge.oidc.game-web.refreshTokenExpiresAt", String(Date.now() + 60_000));
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "neu", refresh_token: "refresh-2", expires_in: 20, refresh_expires_in: 120 }), { status: 200 }));
    vi.stubGlobal("fetch", request);

    await expect(ensureBrowserAccessToken(configuration)).resolves.toBe("neu");
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]?.[1]?.body)).toContain("grant_type=refresh_token");
  });

  it("verwendet auch bei sehr kurzer Laufzeit ein noch gueltiges Token", async () => {
    values.set("zugfolge.oidc.game-web.accessToken", "kurz");
    values.set("zugfolge.oidc.game-web.accessTokenExpiresAt", String(Date.now() + 8_000));
    vi.stubGlobal("fetch", vi.fn());
    await expect(ensureBrowserAccessToken(configuration)).resolves.toBe("kurz");
    expect(fetch).not.toHaveBeenCalled();
  });
});
