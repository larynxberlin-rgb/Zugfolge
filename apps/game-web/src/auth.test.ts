import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureAccessToken, loadRuntimeConfiguration, type BrowserRuntimeConfiguration } from "./auth.js";

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
  tutorialWorldId: "tutorial",
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
    expect(storage.getItem("zugfolge.oidc.state")).toBeNull();
    expect(storage.getItem("zugfolge.accessToken")).toBe("token-1");
    expect(replaceState).toHaveBeenCalledWith({}, "", "https://game.example/");
  });

  it("verwendet nur ein noch gueltiges Sitzungstoken erneut", async () => {
    const storage = new MemoryStorage();
    storage.setItem("zugfolge.accessToken", "cached-token");
    storage.setItem("zugfolge.accessTokenExpiresAt", String(Date.now() + 60_000));
    vi.stubGlobal("sessionStorage", storage);
    await expect(ensureAccessToken(configuration)).resolves.toBe("cached-token");
  });
});
