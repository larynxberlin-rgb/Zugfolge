import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";
import { describe, expect, it } from "vitest";

import { TokenVerificationError, verifyIdentityToken } from "./keycloak.js";

const ISSUER = "https://auth.zugfolge.test/realms/lhe";
const AUDIENCE = "game-api";

async function testJwks() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const kid = "test-key";
  const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid, alg: "RS256" }] });

  async function sign(claims: Record<string, unknown>, options?: { readonly expiredMinutesAgo?: number }) {
    const iat = Math.floor(Date.now() / 1000) - (options?.expiredMinutesAgo ?? 0) * 60;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(String(claims["sub"] ?? "kc-subject-1"))
      .setIssuedAt(iat)
      .setExpirationTime(options?.expiredMinutesAgo !== undefined ? iat + 1 : iat + 3600)
      .sign(privateKey);
  }

  return { jwks, sign };
}

describe("verifyIdentityToken", () => {
  it("liest Subject und bevorzugten Anzeigenamen aus einem gültigen Token", async () => {
    const { jwks, sign } = await testJwks();
    const token = await sign({ sub: "kc-subject-1", preferred_username: "lok-fuehrerin" });

    const claims = await verifyIdentityToken(token, jwks, { issuer: ISSUER, audience: AUDIENCE });

    expect(claims).toEqual({ keycloakSubject: "kc-subject-1", displayName: "lok-fuehrerin" });
  });

  it("fällt auf 'name' zurück, wenn kein preferred_username gesetzt ist", async () => {
    const { jwks, sign } = await testJwks();
    const token = await sign({ sub: "kc-subject-2", name: "Ada Beispiel" });

    const claims = await verifyIdentityToken(token, jwks, { issuer: ISSUER, audience: AUDIENCE });

    expect(claims.displayName).toBe("Ada Beispiel");
  });

  it("fällt auf das Subject zurück, wenn kein Anzeigename vorhanden ist", async () => {
    const { jwks, sign } = await testJwks();
    const token = await sign({ sub: "kc-subject-3" });

    const claims = await verifyIdentityToken(token, jwks, { issuer: ISSUER, audience: AUDIENCE });

    expect(claims.displayName).toBe("kc-subject-3");
  });

  it("lehnt ein abgelaufenes Token ab", async () => {
    const { jwks, sign } = await testJwks();
    const token = await sign({ sub: "kc-subject-1" }, { expiredMinutesAgo: 120 });

    await expect(verifyIdentityToken(token, jwks, { issuer: ISSUER, audience: AUDIENCE })).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
  });

  it("lehnt ein Token mit falschem Aussteller ab", async () => {
    const { privateKey, jwks } = await (async () => {
      const pair = await generateKeyPair("RS256");
      const jwk = await exportJWK(pair.publicKey);
      return { privateKey: pair.privateKey, jwks: createLocalJWKSet({ keys: [{ ...jwk, kid: "k", alg: "RS256" }] }) };
    })();
    const token = await new SignJWT({ sub: "kc-subject-1" })
      .setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer("https://andere-welt.test")
      .setAudience(AUDIENCE)
      .setSubject("kc-subject-1")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

    await expect(verifyIdentityToken(token, jwks, { issuer: ISSUER, audience: AUDIENCE })).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
  });
});
