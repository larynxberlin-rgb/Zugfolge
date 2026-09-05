import { GameApiError } from "./api.js";

export type JourneyRecovery = "authenticate" | "retry";

export interface JourneyFailure {
  readonly message: string;
  readonly recovery: JourneyRecovery;
}

/** Ordnet nur echte HTTP-Authentifizierungsfehler dem neuen PKCE-Fluss zu. */
export function classifyJourneyFailure(error: unknown, fallback: string): JourneyFailure {
  if (error instanceof GameApiError && (error.status === 401 || error.status === 403)) {
    return {
      message: "Deine Anmeldung ist abgelaufen. Melde dich erneut an, um weiterzuspielen.",
      recovery: "authenticate",
    };
  }
  return {
    message: error instanceof Error ? error.message : fallback,
    recovery: "retry",
  };
}
