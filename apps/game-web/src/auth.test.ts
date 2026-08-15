import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureAccessToken,
  loadRuntimeConfiguration,
  resetAuthenticationAttempt,
  RuntimeConfigurationError,
  type BrowserRuntimeConfiguration,
  validateRuntimeConfiguration,
} from "./auth.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const configuration: BrowserRuntimeConfiguration = {
  gameApiUrl: "/api",
  keycloakUrl: "https://identity.example",
  keycloakRealm: "zugfolge",
  publicWorldId: "public",
  livemapUrl: "",
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete globalThis.__ZUGFOLGE_RUNTIME_CONFIG__;
});

describe("Browser-Anmeldung und Laufzeitkonfiguration", () => {
  it("liest die zur Laufzeit eingespritzten Welt- und Dienstgrenzen", () => {
    globalThis.__ZUGFOLGE_RUNTIME_CONFIG__ = { ...configuration, keycloakUrl: "https://identity.example/" };
    vi.stubGlobal("document", { querySelector: vi.fn(() => null) });
    expect(loadRuntimeConfiguration()).toEqual(configuration);
  });

  it("loest den PKCE-Code ohne Client-Geheimnis ein und entfernt den Einmalzustand", async () => {
    const storage = new MemoryStorage();
    storage.setItem("zugfolge.oidc.state", "expected");
    storage.setItem("zugfolge.oidc.verifier", "verifier");
    storage.setItem("zugfolge.oidc.redirectUri", "https://game.example/");
    const replaceState = vi.fn();
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("window", {
      location: { search: "?code=code-1&state=expected", href: "https://game.example/?code=code-1&state=expected" },
      history: { replaceState },
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ access_token: "token-1", expires_in: 300 }) }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureAccessToken(configuration)).resolves.toBe("token-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://identity.example/realms/zugfolge/protocol/openid-connect/token",
      expect.objectContaining({ method: "POST", body: expect.any(URLSearchParams) }),
    );
    expect(storage.getItem("zugfolge.oidc.game-web.state")).toBeNull();
    expect(storage.getItem("zugfolge.oidc.game-web.accessToken")).toBe("token-1");
    expect(replaceState).toHaveBeenCalledWith({}, "", "https://game.example/");
  });

  it("verwendet nur ein noch gueltiges Sitzungstoken erneut", async () => {
    const storage = new MemoryStorage();
    storage.setItem("zugfolge.accessToken", "cached-token");
    storage.setItem("zugfolge.accessTokenExpiresAt", String(Date.now() + 60_000));
    vi.stubGlobal("sessionStorage", storage);
    await expect(ensureAccessToken(configuration)).resolves.toBe("cached-token");
  });

  it("unterscheidet eine unvollstaendige Laufzeitkonfiguration von einem Anmeldefehler", () => {
    expect(() => validateRuntimeConfiguration({ ...configuration, gameApiUrl: "", keycloakUrl: "" }))
      .toThrow(RuntimeConfigurationError);
    expect(() => validateRuntimeConfiguration(configuration)).not.toThrow();
  });

  it("verwirft einen beschaedigten Anmeldeversuch vollstaendig und behaelt den Weltkontext", () => {
    const storage = new MemoryStorage();
    for (const key of [
      "zugfolge.accessToken",
      "zugfolge.accessTokenExpiresAt",
      "zugfolge.oidc.state",
      "zugfolge.oidc.verifier",
      "zugfolge.oidc.redirectUri",
    ]) storage.setItem(key, `wert-${key}`);
    const replaceState = vi.fn();
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("window", {
      location: { href: "https://game.example/?world=w-2&code=alt&state=falsch&session_state=s&iss=i" },
      history: { replaceState },
    });

    resetAuthenticationAttempt();

    expect(storage.length).toBe(0);
    const cleanUrl = replaceState.mock.calls[0]?.[2] as URL;
    expect(cleanUrl.searchParams.get("world")).toBe("w-2");
    expect(cleanUrl.searchParams.has("code")).toBe(false);
    expect(cleanUrl.searchParams.has("state")).toBe(false);
  });

  it("startet nach dem Zuruecksetzen ohne Reload einen neuen PKCE-Fluss", async () => {
    const storage = new MemoryStorage();
    storage.setItem("zugfolge.accessToken", "abgelaufen");
    storage.setItem("zugfolge.accessTokenExpiresAt", "1");
    storage.setItem("zugfolge.oidc.state", "alter-state");
    storage.setItem("zugfolge.oidc.verifier", "alter-verifier");
    const assign = vi.fn();
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("window", {
      location: { href: "https://game.example/?view=journey&world=w-2", search: "?view=journey&world=w-2", assign },
      history: { replaceState: vi.fn() },
    });

    resetAuthenticationAttempt();
    await expect(ensureAccessToken(configuration)).resolves.toBe("");

    expect(storage.getItem("zugfolge.accessToken")).toBeNull();
    expect(storage.getItem("zugfolge.oidc.game-web.state")).not.toBe("alter-state");
    expect(storage.getItem("zugfolge.oidc.game-web.verifier")).not.toBe("alter-verifier");
    expect(assign).toHaveBeenCalledOnce();
    const authorization = assign.mock.calls[0]?.[0] as URL;
    expect(authorization.pathname).toContain("/protocol/openid-connect/auth");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
