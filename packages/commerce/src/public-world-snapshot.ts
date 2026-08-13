import type { SerializedStartingCapitalPolicy } from "@zugfolge/economy";

export const PUBLIC_WORLD_SNAPSHOT_VERSION = "zugfolge-public-world-snapshot/v1" as const;

export interface PublicWorldSnapshotV1 {
  readonly projectionVersion: typeof PUBLIC_WORLD_SNAPSHOT_VERSION;
  readonly worldId: string;
  readonly worldName: string;
  readonly shortDescription: string;
  readonly phase: "planned" | "registration_open" | "active" | "ended" | "archived";
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly authoritativeAsOf: string;
  readonly remainingRuntimeSeconds: number | null;
  readonly startingCapitalPolicy: SerializedStartingCapitalPolicy;
  readonly totalOperators: number;
  readonly stronglyActiveOperators: number | null;
  readonly activityPolicyStatus: "configured" | "unconfigured";
  readonly activityExplanation: string;
  readonly capacity: number;
  readonly freePlaces: number;
  readonly admissionStatus: "planned" | "open" | "waitlist" | "closed" | "full";
  readonly region: string;
  readonly ruleRelease: string;
  readonly releases: {
    readonly infra: string;
    readonly timetable: string;
    readonly fleet: string;
    readonly economy: string;
  };
  readonly banner: {
    readonly altText: string;
    readonly source: string;
    readonly author: string;
    readonly license: string;
    readonly attribution: string | null;
    readonly focalPointXPermille: number;
    readonly focalPointYPermille: number;
    readonly rightsApproved: boolean;
  };
  readonly generatedAt: string;
}

const FORBIDDEN_PUBLIC_KEYS = new Set([
  "keycloakSubject", "email", "partnerId", "partnerReference", "accountId", "playerId",
  "operatorId", "operatorIds", "activityHistory", "loginAt", "paymentReference", "orderReference",
]);

export class PublicWorldSnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicWorldSnapshotValidationError";
  }
}

function assertNoPersonalKeys(value: unknown, path = "snapshot"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPersonalKeys(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PUBLIC_KEYS.has(key)) throw new PublicWorldSnapshotValidationError(`Personenbezug '${path}.${key}' ist oeffentlich verboten.`);
    assertNoPersonalKeys(entry, `${path}.${key}`);
  }
}

export function validatePublicWorldSnapshot(snapshot: PublicWorldSnapshotV1): void {
  assertNoPersonalKeys(snapshot);
  if (snapshot.projectionVersion !== PUBLIC_WORLD_SNAPSHOT_VERSION || snapshot.worldId.trim() === "" || snapshot.worldName.trim() === "") {
    throw new PublicWorldSnapshotValidationError("Oeffentlicher Weltsnapshot verletzt Schema oder Weltbindung.");
  }
  for (const [name, value] of [["totalOperators", snapshot.totalOperators], ["capacity", snapshot.capacity], ["freePlaces", snapshot.freePlaces]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new PublicWorldSnapshotValidationError(`${name} ist ungueltig.`);
  }
  if (snapshot.stronglyActiveOperators !== null && (!Number.isSafeInteger(snapshot.stronglyActiveOperators) || snapshot.stronglyActiveOperators < 0 || snapshot.stronglyActiveOperators > snapshot.totalOperators)) {
    throw new PublicWorldSnapshotValidationError("Stark-aktive EVU sind ungueltig.");
  }
  if (snapshot.activityPolicyStatus === "unconfigured" && snapshot.stronglyActiveOperators !== null) {
    throw new PublicWorldSnapshotValidationError("Ohne freigegebene ActivityPolicy darf keine Aktivitaetszahl erscheinen.");
  }
  if (snapshot.freePlaces > snapshot.capacity) {
    throw new PublicWorldSnapshotValidationError("Kapazitaetsangaben widersprechen einander.");
  }
  for (const value of [snapshot.startsAt, snapshot.authoritativeAsOf, snapshot.generatedAt]) {
    if (Number.isNaN(new Date(value).getTime())) throw new PublicWorldSnapshotValidationError("Snapshot-Zeitstempel ist ungueltig.");
  }
  if (snapshot.endsAt !== null && Number.isNaN(new Date(snapshot.endsAt).getTime())) {
    throw new PublicWorldSnapshotValidationError("Weltende ist ungueltig.");
  }
}
