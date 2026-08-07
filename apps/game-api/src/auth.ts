/** Authentifizierung gegen Keycloak-Zugriffstoken (M2.1). */

import type { IdentityClaims } from "@zugfolge/identity";
import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    identity?: IdentityClaims;
  }
}

export type TokenVerifier = (token: string) => Promise<IdentityClaims>;

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return undefined;
  }
  return header.slice("Bearer ".length).trim();
}

/** Verifiziert das Zugriffstoken und trägt die Identität in die Anfrage ein. */
export function createAuthenticator(verifyToken: TokenVerifier) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = bearerToken(request);
    if (token === undefined) {
      await reply.code(401).send({ error: "Kein Zugriffstoken übermittelt." });
      return;
    }
    try {
      request.identity = await verifyToken(token);
    } catch {
      await reply.code(401).send({ error: "Zugriffstoken ungültig oder abgelaufen." });
    }
  };
}
