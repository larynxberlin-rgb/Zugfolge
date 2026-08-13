export const ACTIVITY_POLICY_SCHEMA = "zugfolge-activity-policy/v1" as const;

/** Nur autoritativ protokollierte Spielwirkungen; Login/Browser/Online sind bewusst ausgeschlossen. */
export const ACTIVITY_EVENT_TYPES = [
  "operations.train-outcome",
  "economy.settlement",
] as const;
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

export interface ActivityPolicyV1 {
  readonly schemaVersion: typeof ACTIVITY_POLICY_SCHEMA;
  readonly windowSeconds: number;
  readonly minimumScore: number;
  readonly weights: Readonly<Partial<Record<ActivityEventType, number>>>;
}

export type WorldActivityPolicy = ActivityPolicyV1 | null;

export interface ActivityOperator {
  readonly operatorId: string;
  readonly kind: "player" | "system" | "bot";
  readonly lifecycle: "active" | "exited" | "deleted";
}

export interface ActivityEvent {
  readonly eventType: string;
  readonly operatorId: string | null;
  readonly occurredAtS: number;
}

export interface StrongActivityResult {
  readonly status: "configured" | "unconfigured";
  readonly stronglyActiveOperatorIds: readonly string[];
  readonly scores: Readonly<Record<string, number>>;
  readonly windowStartsAtS?: number;
  readonly asOfS: number;
}

export class ActivityPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityPolicyValidationError";
  }
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ActivityPolicyValidationError(`${name} muss eine positive Ganzzahl sein.`);
  }
  return value as number;
}

export function validateActivityPolicy(value: unknown): ActivityPolicyV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ActivityPolicyValidationError("ActivityPolicy ist kein Objekt.");
  }
  const policy = value as Record<string, unknown>;
  if (policy["schemaVersion"] !== ACTIVITY_POLICY_SCHEMA) {
    throw new ActivityPolicyValidationError("Unbekannte ActivityPolicy-Version.");
  }
  const windowSeconds = positiveSafeInteger(policy["windowSeconds"], "windowSeconds");
  const minimumScore = positiveSafeInteger(policy["minimumScore"], "minimumScore");
  const weightsValue = policy["weights"];
  if (typeof weightsValue !== "object" || weightsValue === null || Array.isArray(weightsValue)) {
    throw new ActivityPolicyValidationError("ActivityPolicy braucht Ereignisgewichte.");
  }
  const weights = weightsValue as Record<string, unknown>;
  const entries = Object.entries(weights);
  if (entries.length === 0) throw new ActivityPolicyValidationError("ActivityPolicy braucht mindestens ein Ereignisgewicht.");
  for (const [eventType, weight] of entries) {
    if (!(ACTIVITY_EVENT_TYPES as readonly string[]).includes(eventType)) {
      throw new ActivityPolicyValidationError(`Nicht autoritativer oder unbekannter Aktivitaetsbeleg '${eventType}'.`);
    }
    positiveSafeInteger(weight, `Gewicht ${eventType}`);
  }
  return Object.freeze({
    schemaVersion: ACTIVITY_POLICY_SCHEMA,
    windowSeconds,
    minimumScore,
    weights: Object.freeze({ ...weights }) as ActivityPolicyV1["weights"],
  });
}

/** Deterministische Auswertung gegen die autoritative Weltzeit des Aufrufers. */
export function calculateStrongActivity(
  policy: WorldActivityPolicy,
  operators: readonly ActivityOperator[],
  events: readonly ActivityEvent[],
  asOfS: number,
): StrongActivityResult {
  if (!Number.isSafeInteger(asOfS) || asOfS < 0) throw new ActivityPolicyValidationError("Autoritative Bezugszeit ist ungueltig.");
  if (policy === null) return Object.freeze({ status: "unconfigured", stronglyActiveOperatorIds: [], scores: {}, asOfS });
  const checked = validateActivityPolicy(policy);
  const windowStartsAtS = Math.max(0, asOfS - checked.windowSeconds);
  const eligible = new Set(operators
    .filter((operator) => operator.kind === "player" && operator.lifecycle === "active")
    .map((operator) => operator.operatorId));
  const scores: Record<string, number> = {};
  for (const operatorId of [...eligible].sort()) scores[operatorId] = 0;
  for (const event of events) {
    if (event.operatorId === null || !eligible.has(event.operatorId)) continue;
    if (!Number.isSafeInteger(event.occurredAtS) || event.occurredAtS <= windowStartsAtS || event.occurredAtS > asOfS) continue;
    const weight = checked.weights[event.eventType as ActivityEventType];
    if (weight !== undefined) scores[event.operatorId] = (scores[event.operatorId] ?? 0) + weight;
  }
  const stronglyActiveOperatorIds = Object.keys(scores).filter((operatorId) => scores[operatorId]! >= checked.minimumScore).sort();
  return Object.freeze({ status: "configured", stronglyActiveOperatorIds, scores: Object.freeze(scores), windowStartsAtS, asOfS });
}
