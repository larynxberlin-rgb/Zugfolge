import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";
import { operators } from "./operators.js";
import { worlds } from "./worlds.js";

/** Laufzeitprofil und unveraenderliche Release-Pins einer Alpha-Welt. */
export const alphaWorldProfiles = pgTable("alpha_world_profiles", {
  worldId: uuid("world_id").primaryKey().references(() => worlds.id),
  profileKind: text("profile_kind", { enum: ["public", "tutorial", "private", "test"] }).notNull(),
  regionId: text("region_id").notNull(),
  regionVariant: text("region_variant").notNull(),
  worldSeed: bigint("world_seed", { mode: "bigint" }).notNull(),
  accelerationFactor: integer("acceleration_factor").notNull().default(1),
  infraReleaseHash: text("infra_release_hash").notNull(),
  timetableReleaseHash: text("timetable_release_hash").notNull(),
  fleetReleaseHash: text("fleet_release_hash").notNull(),
  economyReleaseHash: text("economy_release_hash").notNull(),
  blueprint: jsonb("blueprint").notNull(),
  blueprintHash: text("blueprint_hash").notNull(),
  /** Ed25519-gepruefter Deployment-Hash; bei Altwelten bis zur ersten Bindung NULL. */
  deploymentHash: text("deployment_hash"),
  periodCount: integer("period_count"),
  currentPeriod: integer("current_period").notNull().default(0),
  state: text("state", { enum: ["draft", "running", "closing", "archived"] }).notNull().default("draft"),
  startedAtS: bigint("started_at_s", { mode: "number" }),
  closingAtS: bigint("closing_at_s", { mode: "number" }),
  archivedAtS: bigint("archived_at_s", { mode: "number" }),
  finalStateHash: text("final_state_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("alpha_world_profiles_world_state_idx").on(table.worldId, table.state),
]);

/**
 * Vollstaendige Ed25519-gepruefte Deployment-Huelle einer Alpha-Welt.
 *
 * Der Game-Prozess rekonstruiert daraus nach einem Neustart ausschliesslich
 * fuer bereits aktive Welten seine unveraenderlichen Fleet-/Planning-
 * Authorities und den regionalen Servicekatalog. Ein provisioning-Datensatz
 * bleibt dagegen bewusst inert, bis derselbe autorisierte Befehl den
 * Weltstart erfolgreich abschliesst.
 */
export const alphaWorldDeployments = pgTable("alpha_world_deployments", {
  worldId: uuid("world_id").primaryKey().references(() => worlds.id),
  deploymentHash: text("deployment_hash").notNull().unique(),
  signedDeployment: jsonb("signed_deployment").notNull(),
  planningAuthorityAccountId: uuid("planning_authority_account_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    name: "alpha_world_deployments_planning_authority_fk",
    columns: [table.worldId, table.planningAuthorityAccountId],
    foreignColumns: [accounts.worldId, accounts.id],
  }),
]);

/** Unterbrechbarer Fortschritt; Erfuellung wird nur aus autoritativen Belegen abgeleitet. */
export const tutorialProgress = pgTable("tutorial_progress", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  worldId: uuid("world_id").notNull().references(() => worlds.id),
  accountId: uuid("account_id").notNull(),
  chapter: integer("chapter").notNull().default(1),
  chapterState: text("chapter_state", { enum: ["ready", "in-progress", "blocked", "completed"] }).notNull().default("ready"),
  evidence: jsonb("evidence").notNull().default({}),
  explanationCode: text("explanation_code").notNull().default("tutorial.welcome"),
  checkpointHash: text("checkpoint_hash").notNull(),
  resetCount: integer("reset_count").notNull().default(0),
  completedAtS: bigint("completed_at_s", { mode: "number" }),
  updatedAtS: bigint("updated_at_s", { mode: "number" }).notNull(),
}, (table) => [
  uniqueIndex("tutorial_progress_world_account_idx").on(table.worldId, table.accountId),
  foreignKey({
    name: "tutorial_progress_world_account_fk",
    columns: [table.worldId, table.accountId],
    foreignColumns: [accounts.worldId, accounts.id],
  }),
]);

/**
 * Kurzlebige, genau einem oeffentlichen Weltkonto zugeordnete Tutorialinstanz.
 * Die interne Welt bleibt eine UUID; `reference` ist nur die erkennbare,
 * nicht erratbare Referenz an den HTTP-Grenzen.
 */
export const tutorialSessions = pgTable("tutorial_sessions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  reference: text("reference").notNull(),
  publicWorldId: uuid("public_world_id").notNull().references(() => worlds.id),
  publicAccountId: uuid("public_account_id").notNull(),
  tutorialWorldId: uuid("world_id").notNull().references(() => worlds.id),
  tutorialAccountId: uuid("tutorial_account_id").notNull(),
  tutorialOperatorId: uuid("tutorial_operator_id").notNull(),
  templateVersion: text("template_version").notNull(),
  templateHash: text("template_hash").notNull(),
  lifecycle: text("lifecycle", {
    enum: ["provisioning", "running", "summary", "closing", "archived", "failed"],
  }).notNull().default("provisioning"),
  provisioningStep: text("provisioning_step").notNull().default("world-created"),
  currentChapter: integer("current_chapter").notNull().default(1),
  scenarioState: jsonb("scenario_state").notNull().default({}),
  pendingAction: jsonb("pending_action"),
  actionRevision: integer("action_revision").notNull().default(0),
  correctionAttempts: jsonb("correction_attempts").notNull().default({}),
  hintsUsed: jsonb("hints_used").notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull(),
  idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
  maximumExpiresAt: timestamp("maximum_expires_at", { withTimezone: true }).notNull(),
  summaryAt: timestamp("summary_at", { withTimezone: true }),
  graceExpiresAt: timestamp("grace_expires_at", { withTimezone: true }),
  closingAt: timestamp("closing_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  closureReason: text("closure_reason"),
  finalStateHash: text("final_state_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => {
  const worldId = table.tutorialWorldId;
  const worldIdOfPublicAccount = table.publicWorldId;
  return [
    uniqueIndex("tutorial_sessions_reference_idx").on(worldId, table.reference),
    uniqueIndex("tutorial_sessions_tutorial_world_idx").on(worldId),
    uniqueIndex("tutorial_sessions_world_id_idx").on(worldId, table.id),
    uniqueIndex("tutorial_sessions_one_active_per_public_account_idx")
      .on(worldIdOfPublicAccount, table.publicAccountId)
      .where(sql`${table.lifecycle} in ('provisioning', 'running', 'summary', 'closing')`),
    index("tutorial_sessions_reaper_idx").on(table.lifecycle, table.idleExpiresAt, table.maximumExpiresAt, worldId),
    foreignKey({
      name: "tutorial_sessions_public_account_fk",
      columns: [table.publicWorldId, table.publicAccountId],
      foreignColumns: [accounts.worldId, accounts.id],
    }),
    foreignKey({
      name: "tutorial_sessions_tutorial_account_fk",
      columns: [table.tutorialWorldId, table.tutorialAccountId],
      foreignColumns: [accounts.worldId, accounts.id],
    }),
    foreignKey({
      name: "tutorial_sessions_tutorial_operator_fk",
      columns: [table.tutorialWorldId, table.tutorialOperatorId],
      foreignColumns: [operators.worldId, operators.id],
    }),
  ];
});

/** Reale, injizierbar datierte Tutorialtelemetrie ausserhalb des Simulationskerns. */
export const tutorialTelemetryEvents = pgTable("tutorial_telemetry_events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  worldId: uuid("world_id").notNull().references(() => worlds.id),
  sessionId: uuid("session_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  eventType: text("event_type", {
    enum: [
      "tutorial_session_started",
      "tutorial_chapter_started",
      "tutorial_chapter_completed",
      "tutorial_hint_opened",
      "tutorial_dialogue_dismissed",
      "tutorial_restarted",
      "tutorial_abandoned",
      "tutorial_completed",
      "tutorial_world_closed",
    ],
  }).notNull(),
  templateVersion: text("template_version").notNull(),
  chapter: integer("chapter"),
  elapsedMilliseconds: bigint("elapsed_milliseconds", { mode: "number" }).notNull(),
  correctionAttempts: integer("correction_attempts").notNull().default(0),
  hintUsed: boolean("hint_used").notNull().default(false),
  reason: text("reason"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("tutorial_telemetry_world_idempotency_idx").on(table.worldId, table.idempotencyKey),
  index("tutorial_telemetry_world_session_idx").on(table.worldId, table.sessionId, table.occurredAt),
  index("tutorial_telemetry_aggregate_idx").on(table.templateVersion, table.chapter, table.eventType, table.worldId),
  foreignKey({
    name: "tutorial_telemetry_world_session_fk",
    columns: [table.worldId, table.sessionId],
    foreignColumns: [tutorialSessions.tutorialWorldId, tutorialSessions.id],
  }),
]);

/** Deterministische, erklaerbare Missbrauchsbeobachtung vor jeder Sanktion. */
export const abuseObservations = pgTable("abuse_observations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  worldId: uuid("world_id").notNull().references(() => worlds.id),
  identityHash: text("identity_hash").notNull(),
  endpointClass: text("endpoint_class").notNull(),
  actionClass: text("action_class").notNull(),
  bucketStartS: bigint("bucket_start_s", { mode: "number" }).notNull(),
  requestCount: integer("request_count").notNull(),
  distinctTargetCount: integer("distinct_target_count").notNull(),
  replayCount: integer("replay_count").notNull(),
  coordinatedIdentityCount: integer("coordinated_identity_count").notNull(),
  scoreBasisPoints: integer("score_basis_points").notNull(),
  ruleCodes: jsonb("rule_codes").notNull(),
  response: text("response", { enum: ["observe", "delay", "limit", "block", "manual-review"] }).notNull(),
  observationKey: text("observation_key"),
  factsHash: text("facts_hash"),
  correlationId: text("correlation_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("abuse_observations_world_id_idx").on(table.worldId, table.id),
  uniqueIndex("abuse_observations_world_observation_key_idx").on(table.worldId, table.observationKey),
  index("abuse_observations_world_correlation_idx").on(table.worldId, table.correlationId),
  index("abuse_observations_world_identity_bucket_idx").on(table.worldId, table.identityHash, table.bucketStartS),
]);

/** Atomare feste Fenster fuer Identitaet x Welt x Endpunkt x Fachaktion. */
export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  worldId: uuid("world_id").notNull().references(() => worlds.id),
  identityHash: text("identity_hash").notNull(),
  identityClass: text("identity_class", { enum: ["anonymous", "authenticated", "administrative"] }).notNull(),
  endpointClass: text("endpoint_class").notNull(),
  actionClass: text("action_class").notNull(),
  bucketStartS: bigint("bucket_start_s", { mode: "number" }).notNull(),
  requestCount: integer("request_count").notNull().default(1),
  actionCount: integer("action_count").notNull().default(1),
  targetHashes: jsonb("target_hashes").notNull().default({}),
  replayKeys: jsonb("replay_keys").notNull().default({}),
  replayCount: integer("replay_count").notNull().default(0),
}, (table) => [
  uniqueIndex("rate_limit_buckets_scope_idx").on(table.worldId, table.identityHash, table.endpointClass, table.actionClass, table.bucketStartS),
  index("rate_limit_buckets_world_action_bucket_idx").on(table.worldId, table.actionClass, table.bucketStartS),
]);

/** Sanktionen sind nie still, haben Einspruch und bei Schwere einen Odoo-Antrag. */
export const abuseSanctions = pgTable("abuse_sanctions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  worldId: uuid("world_id").notNull().references(() => worlds.id),
  observationId: uuid("observation_id").notNull(),
  identityHash: text("identity_hash").notNull(),
  sanction: text("sanction", { enum: ["delay", "limit", "temporary-block", "manual-review"] }).notNull(),
  status: text("status", { enum: ["proposed", "active", "appealed", "revoked", "expired"] }).notNull(),
  startsAtS: bigint("starts_at_s", { mode: "number" }).notNull(),
  endsAtS: bigint("ends_at_s", { mode: "number" }),
  explanation: jsonb("explanation").notNull(),
  odooAdminRequestId: uuid("odoo_admin_request_id"),
  appealReference: text("appeal_reference"),
}, (table) => [
  uniqueIndex("abuse_sanctions_world_id_idx").on(table.worldId, table.id),
  uniqueIndex("abuse_sanctions_world_observation_idx").on(table.worldId, table.observationId),
  index("abuse_sanctions_world_identity_status_idx").on(table.worldId, table.identityHash, table.status),
  foreignKey({ name: "abuse_sanctions_world_observation_fk", columns: [table.worldId, table.observationId], foreignColumns: [abuseObservations.worldId, abuseObservations.id] }),
]);

export const alphaFeedback = pgTable("alpha_feedback", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  worldId: uuid("world_id").notNull().references(() => worlds.id),
  participantPseudonym: text("participant_pseudonym").notNull(),
  releaseHash: text("release_hash").notNull(),
  fromS: bigint("from_s", { mode: "number" }).notNull(),
  untilS: bigint("until_s", { mode: "number" }).notNull(),
  eventReference: text("event_reference"),
  reportReference: text("report_reference"),
  category: text("category").notNull(),
  message: text("message").notNull(),
  contactAllowed: boolean("contact_allowed").notNull().default(false),
  status: text("status", { enum: ["new", "triaged", "resolved", "rejected"] }).notNull().default("new"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("alpha_feedback_world_status_idx").on(table.worldId, table.status, table.submittedAt),
]);

export const worldFinalRankings = pgTable("world_final_rankings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  worldId: uuid("world_id").notNull().references(() => worlds.id),
  rankingType: text("ranking_type", { enum: ["reliability", "passenger-service", "economy", "resilience", "cooperation"] }).notNull(),
  operatorId: uuid("operator_id").notNull(),
  rank: integer("rank").notNull(),
  score: bigint("score", { mode: "bigint" }).notNull(),
  evidenceHash: text("evidence_hash").notNull(),
}, (table) => [
  uniqueIndex("world_final_rankings_world_type_operator_idx").on(table.worldId, table.rankingType, table.operatorId),
  index("world_final_rankings_world_type_rank_idx").on(table.worldId, table.rankingType, table.rank),
  foreignKey({ name: "world_final_rankings_world_operator_fk", columns: [table.worldId, table.operatorId], foreignColumns: [operators.worldId, operators.id] }),
]);

export const worldArchives = pgTable("world_archives", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  worldId: uuid("world_id").notNull().references(() => worlds.id),
  archiveSchema: text("archive_schema").notNull(),
  eventFromSequence: integer("event_from_sequence").notNull(),
  eventUntilSequence: integer("event_until_sequence").notNull(),
  stateHash: text("state_hash").notNull(),
  replayHash: text("replay_hash").notNull(),
  archiveHash: text("archive_hash").notNull(),
  retentionClass: text("retention_class", { enum: ["public-history", "participant-data", "audit"] }).notNull(),
  retainUntil: timestamp("retain_until", { withTimezone: true }),
  authorizedRoles: jsonb("authorized_roles").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("world_archives_world_class_idx").on(table.worldId, table.retentionClass),
]);

export const infraReleaseChanges = pgTable("infra_release_changes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  worldId: uuid("world_id").notNull().references(() => worlds.id),
  releaseId: text("release_id").notNull(),
  releaseHash: text("release_hash").notNull(),
  predecessorHash: text("predecessor_hash").notNull(),
  timetableYear: integer("timetable_year").notNull(),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
  validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
  coverageReport: jsonb("coverage_report").notNull(),
  rightsReport: jsonb("rights_report").notNull(),
  deviationReport: jsonb("deviation_report").notNull(),
  signature: jsonb("signature").notNull(),
  impactPreview: jsonb("impact_preview").notNull(),
  requestedByAdminRequestId: uuid("requested_by_admin_request_id"),
  activateAtPeriod: integer("activate_at_period").notNull(),
  status: text("status", { enum: ["proposed", "validated", "scheduled", "activated", "aborted", "rolled-back"] }).notNull(),
  previousActivationId: uuid("previous_activation_id"),
  activatedAtS: bigint("activated_at_s", { mode: "number" }),
  activationEventId: text("activation_event_id"),
}, (table) => [
  uniqueIndex("infra_release_changes_world_release_idx").on(table.worldId, table.releaseId),
  uniqueIndex("infra_release_changes_world_hash_idx").on(table.worldId, table.releaseHash),
  index("infra_release_changes_world_period_status_idx").on(table.worldId, table.activateAtPeriod, table.status),
]);

export type AlphaWorldProfile = typeof alphaWorldProfiles.$inferSelect;
export type AlphaWorldDeployment = typeof alphaWorldDeployments.$inferSelect;
export type TutorialProgress = typeof tutorialProgress.$inferSelect;
export type TutorialSession = typeof tutorialSessions.$inferSelect;
export type TutorialTelemetryEvent = typeof tutorialTelemetryEvents.$inferSelect;
export type AbuseObservation = typeof abuseObservations.$inferSelect;
export type AlphaFeedback = typeof alphaFeedback.$inferSelect;
export type WorldArchive = typeof worldArchives.$inferSelect;
export type InfraReleaseChange = typeof infraReleaseChanges.$inferSelect;
