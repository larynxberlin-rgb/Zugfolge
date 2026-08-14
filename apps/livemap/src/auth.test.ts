import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureAccessToken, loadRuntimeConfiguration } from "./auth.js";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();
  get length(): number { return this.#values.size; }
  clear(): void { this.#values.clear(); }
  getItem(key: string): string | null { return this.#values.get(key) ?? null; }
  key(index: number): string | null { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string): void { this.#values.delete(key); }
  setItem(key: string, value: string): void { this.#values.set(key, value); }
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete globalThis.__ZUGFOLGE_RUNTIME_CONFIG__;
});

describe("Livemap-OIDC-Laufzeitvertrag", () => {
  it("liest den injizierten Client und verwendet ihn beim Tokenaustausch", async () => {
    globalThis.__ZUGFOLGE_RUNTIME_CONFIG__ = {
      gameApiUrl: "/api",
      keycloakUrl: "https://identity.example/",
      keycloakRealm: "zugfolge",
      publicWorldId: "public",
      gameWebUrl: "https://game.example",
      livemapOidcClientId: "game-web",
    };
    vi.stubGlobal("document", { querySelector: vi.fn(() => null) });
    const configuration = loadRuntimeConfiguration();
    expect(configuration.oidcClientId).toBe("game-web");

    const storage = new MemoryStorage();
    storage.setItem("zugfolge.livemap.oidc.state", "expected");
    storage.setItem("zugfolge.livemap.oidc.verifier", "verifier");
    storage.setItem("zugfolge.livemap.oidc.redirectUri", "https://map.example/");
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("window", {
      location: { search: "?code=code-1&state=expected", href: "https://map.example/?code=code-1&state=expected" },
      history: { replaceState: vi.fn() },
    });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "token-1", expires_in: 300 }),
      requestBody: init.body,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureAccessToken(configuration)).resolves.toBe("token-1");
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.body).toBeInstanceOf(URLSearchParams);
    expect((request?.body as URLSearchParams).get("client_id")).toBe("game-web");
  });

  it("verwendet ohne explizite Injektion den eigenen Livemap-Client", () => {
    globalThis.__ZUGFOLGE_RUNTIME_CONFIG__ = {};
    vi.stubGlobal("document", { querySelector: vi.fn(() => null) });
    expect(loadRuntimeConfiguration().oidcClientId).toBe("livemap");
  });

  it("verwendet den injizierten Client auch im Authorization Request", async () => {
    globalThis.__ZUGFOLGE_RUNTIME_CONFIG__ = {
      keycloakUrl: "https://identity.example",
      keycloakRealm: "zugfolge",
      livemapOidcClientId: "game-web",
    };
    vi.stubGlobal("document", { querySelector: vi.fn(() => null) });
    const storage = new MemoryStorage();
    const assign = vi.fn();
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("window", {
      location: { search: "", href: "https://map.example/?world=public", assign },
      history: { replaceState: vi.fn() },
    });

    await expect(ensureAccessToken(loadRuntimeConfiguration())).resolves.toBe("");

    expect(assign).toHaveBeenCalledOnce();
    const authorization = assign.mock.calls[0]?.[0] as URL;
    expect(authorization.searchParams.get("client_id")).toBe("game-web");
  });
});
