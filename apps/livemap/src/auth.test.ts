import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureAccessToken, loadRuntimeConfiguration, type LivemapRuntimeConfiguration } from "./auth.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const configuration: LivemapRuntimeConfiguration = {
  gameApiUrl: "/api",
  keycloakUrl: "https://identity.example",
  keycloakRealm: "zugfolge",
  oidcClientId: "same-origin-game-web",
  publicWorldId: "welt-1",
  gameWebUrl: "https://game.example/",
  basemapStyleUrl: "/artifacts/style.json",
  germanyPmtilesUrl: "/artifacts/infra.pmtiles",
  attribution: "Test",
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete globalThis.__ZUGFOLGE_RUNTIME_CONFIG__;
});

describe("Livemap-Anmeldung", () => {
  it("verwendet standardmaessig den eigenstaendigen Livemap-Client", () => {
    vi.stubGlobal("document", { querySelector: vi.fn(() => null) });
    expect(loadRuntimeConfiguration().oidcClientId).toBe("livemap");
  });

  it("loest PKCE-Codes mit der konfigurierten Same-Origin-Client-ID ein", async () => {
    const storage = new MemoryStorage();
    storage.setItem("zugfolge.livemap.oidc.state", "expected");
    storage.setItem("zugfolge.livemap.oidc.verifier", "verifier");
    storage.setItem("zugfolge.livemap.oidc.redirectUri", "https://game.example/live/");
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("window", {
      location: { search: "?code=code-1&state=expected", href: "https://game.example/live/?code=code-1&state=expected" },
      history: { replaceState: vi.fn() },
    });
    let submittedBody: URLSearchParams | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      submittedBody = init?.body as URLSearchParams | undefined;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "token-1", expires_in: 300 }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureAccessToken(configuration)).resolves.toBe("token-1");
    expect(submittedBody).toBeInstanceOf(URLSearchParams);
    expect(submittedBody?.get("client_id")).toBe("same-origin-game-web");
  });
});
