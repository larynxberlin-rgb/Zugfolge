export class AlphaValidationError extends Error {
  readonly code = "alpha_validation";
}

export class AlphaConflictError extends Error {
  constructor(message: string, readonly code = "alpha_conflict") { super(message); }
}

export class AlphaAuthorizationError extends Error {
  readonly code = "alpha_forbidden";
}
