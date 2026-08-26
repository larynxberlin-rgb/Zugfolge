import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

  it("erneuert ein Offline-Token mit refresh_expires_in 0 auch nach mehr als 24 Stunden", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    values.set("zugfolge.oidc.game-web.accessToken", "alt");
    values.set("zugfolge.oidc.game-web.accessTokenExpiresAt", "1");
    values.set("zugfolge.oidc.game-web.refreshToken", "offline-1");
    values.set("zugfolge.oidc.game-web.refreshTokenExpiresAt", String(Date.now() + 60_000));
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "tag-1",
        refresh_token: "offline-2",
        expires_in: 86_400,
        refresh_expires_in: 0,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "tag-2",
        refresh_token: "offline-3",
        expires_in: 86_400,
        refresh_expires_in: 0,
      }), { status: 200 }));
    vi.stubGlobal("fetch", request);

    await expect(ensureBrowserAccessToken(configuration)).resolves.toBe("tag-1");
    expect(values.get("zugfolge.oidc.game-web.refreshTokenExpiresAt")).toBe("0");

    vi.advanceTimersByTime(25 * 60 * 60 * 1_000);
    await expect(ensureBrowserAccessToken(configuration)).resolves.toBe("tag-2");
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[1]?.[1]?.body)).toContain("grant_type=refresh_token");
  });

  it("begrenzt eine positive Refresh-Laufzeit und startet danach eine neue Anmeldung", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    values.set("zugfolge.oidc.game-web.accessToken", "alt");
    values.set("zugfolge.oidc.game-web.accessTokenExpiresAt", "1");
    values.set("zugfolge.oidc.game-web.refreshToken", "refresh-1");
    values.set("zugfolge.oidc.game-web.refreshTokenExpiresAt", String(Date.now() + 60_000));
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "kurzlebig",
      refresh_token: "refresh-2",
      expires_in: 60,
      refresh_expires_in: 120,
    }), { status: 200 }));
    const assign = vi.fn();
    vi.stubGlobal("fetch", request);
    vi.stubGlobal("window", { location: { href: "https://game.example/", search: "", assign } });

    await expect(ensureBrowserAccessToken(configuration)).resolves.toBe("kurzlebig");
    expect(values.get("zugfolge.oidc.game-web.refreshTokenExpiresAt")).toBe(String(Date.now() + 120_000));

    vi.advanceTimersByTime(121_000);
    await expect(ensureBrowserAccessToken(configuration)).resolves.toBe("");

    expect(request).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledOnce();
    expect(new URL(assign.mock.calls[0]?.[0]).searchParams.get("scope")).toBe("openid offline_access");
  });

  it("verwendet auch bei sehr kurzer Laufzeit ein noch gueltiges Token", async () => {
    values.set("zugfolge.oidc.game-web.accessToken", "kurz");
    values.set("zugfolge.oidc.game-web.accessTokenExpiresAt", String(Date.now() + 8_000));
    vi.stubGlobal("fetch", vi.fn());
    await expect(ensureBrowserAccessToken(configuration)).resolves.toBe("kurz");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("startet ohne Refresh-Token aus einem Hintergrundabruf keine Navigation", async () => {
    values.set("zugfolge.oidc.game-web.accessToken", "abgelehnt");
    values.set("zugfolge.oidc.game-web.accessTokenExpiresAt", String(Date.now() + 60_000));
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { href: "https://game.example/", search: "", assign } });
    vi.stubGlobal("fetch", vi.fn());

    await expect(ensureBrowserAccessToken(configuration, true)).resolves.toBe("abgelehnt");
    expect(assign).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
