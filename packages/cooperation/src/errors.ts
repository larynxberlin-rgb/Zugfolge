export class CooperationValidationError extends Error {
  constructor(message: string, readonly code = "cooperation_invalid") {
    super(message);
    this.name = "CooperationValidationError";
  }
}

export class CooperationAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CooperationAuthorizationError";
  }
}

export class CooperationConflictError extends Error {
  constructor(message: string, readonly code = "cooperation_conflict") {
    super(message);
    this.name = "CooperationConflictError";
  }
}

export class CooperationNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CooperationNotFoundError";
  }
}
