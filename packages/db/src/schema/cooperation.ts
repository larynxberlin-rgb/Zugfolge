import { sql } from "drizzle-orm";
import {
  bigint,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";
import { operators } from "./operators.js";
import { worlds } from "./worlds.js";

export const operatorContracts = pgTable(
  "operator_contracts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    offerorOperatorId: uuid("offeror_operator_id").notNull(),
    offereeOperatorId: uuid("offeree_operator_id").notNull(),
    contractType: text("contract_type", {
      enum: ["traction", "vehicle-rental", "connection", "disruption-assistance"],
    }).notNull(),
    subject: jsonb("subject").notNull(),
    terms: jsonb("terms").notNull(),
    termsHash: text("terms_hash").notNull(),
    priceCents: bigint("price_cents", { mode: "bigint" }).notNull(),
    validFromS: bigint("valid_from_s", { mode: "number" }).notNull(),
    validUntilS: bigint("valid_until_s", { mode: "number" }).notNull(),
    responseDeadlineS: bigint("response_deadline_s", { mode: "number" }).notNull(),
    terminationNoticeS: bigint("termination_notice_s", { mode: "number" }).notNull(),
    status: text("status", {
      enum: [
        "offered",
        "accepted",
        "rejected",
        "active",
        "terminated",
        "non-performance",
        "completed",
        "expired",
      ],
    }).notNull(),
    offeredByAccountId: uuid("offered_by_account_id").notNull(),
    respondedByAccountId: uuid("responded_by_account_id"),
    offeredAtS: bigint("offered_at_s", { mode: "number" }).notNull(),
    respondedAtS: bigint("responded_at_s", { mode: "number" }),
    terminatedAtS: bigint("terminated_at_s", { mode: "number" }),
    endedAtS: bigint("ended_at_s", { mode: "number" }),
    endReason: text("end_reason"),
    revision: integer("revision").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull(),
  },
  (table) => [
    uniqueIndex("operator_contracts_world_id_idx").on(table.worldId, table.id),
    uniqueIndex("operator_contracts_world_offeror_idempotency_idx").on(
      table.worldId,
      table.offerorOperatorId,
      table.idempotencyKey,
    ),
    index("operator_contracts_world_offeree_status_idx").on(
      table.worldId,
      table.offereeOperatorId,
      table.status,
    ),
    index("operator_contracts_world_offeror_status_idx").on(
      table.worldId,
      table.offerorOperatorId,
      table.status,
    ),
    foreignKey({
      name: "operator_contracts_world_offeror_fk",
      columns: [table.worldId, table.offerorOperatorId],
      foreignColumns: [operators.worldId, operators.id],
    }),
    foreignKey({
      name: "operator_contracts_world_offeree_fk",
      columns: [table.worldId, table.offereeOperatorId],
      foreignColumns: [operators.worldId, operators.id],
    }),
    foreignKey({
      name: "operator_contracts_world_offered_by_fk",
      columns: [table.worldId, table.offeredByAccountId],
      foreignColumns: [accounts.worldId, accounts.id],
    }),
    foreignKey({
      name: "operator_contracts_world_responded_by_fk",
      columns: [table.worldId, table.respondedByAccountId],
      foreignColumns: [accounts.worldId, accounts.id],
    }),
  ],
);

export const vehicleAssets = pgTable(
  "vehicle_assets",
  {
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    vehicleId: text("vehicle_id").notNull(),
    authorityReleaseId: text("authority_release_id").notNull(),
    classDesignation: text("class_designation").notNull(),
    actualConfiguration: jsonb("actual_configuration").notNull(),
    ownerOperatorId: uuid("owner_operator_id").notNull(),
    holderOperatorId: uuid("holder_operator_id").notNull(),
    lessorOperatorId: uuid("lessor_operator_id"),
    odometerMetres: bigint("odometer_metres", { mode: "bigint" }).notNull(),
    conditionBasisPoints: integer("condition_basis_points").notNull(),
    damages: jsonb("damages").notNull(),
    maintenanceDeadlines: jsonb("maintenance_deadlines").notNull(),
    approvals: jsonb("approvals").notNull(),
    operatingLimits: jsonb("operating_limits").notNull(),
    bindings: jsonb("bindings").notNull(),
    valuationSpecId: text("valuation_spec_id").notNull(),
    valueCents: bigint("value_cents", { mode: "bigint" }).notNull(),
    acquiredAtS: bigint("acquired_at_s", { mode: "number" }).notNull(),
    revision: integer("revision").notNull().default(1),
    historyHash: text("history_hash").notNull(),
  },
  (table) => [
    uniqueIndex("vehicle_assets_world_vehicle_idx").on(table.worldId, table.vehicleId),
    index("vehicle_assets_world_owner_idx").on(table.worldId, table.ownerOperatorId),
    index("vehicle_assets_world_holder_idx").on(table.worldId, table.holderOperatorId),
    foreignKey({
      name: "vehicle_assets_world_owner_fk",
      columns: [table.worldId, table.ownerOperatorId],
      foreignColumns: [operators.worldId, operators.id],
    }),
    foreignKey({
      name: "vehicle_assets_world_holder_fk",
      columns: [table.worldId, table.holderOperatorId],
      foreignColumns: [operators.worldId, operators.id],
    }),
    foreignKey({
      name: "vehicle_assets_world_lessor_fk",
      columns: [table.worldId, table.lessorOperatorId],
      foreignColumns: [operators.worldId, operators.id],
    }),
  ],
);

export const vehicleMarketListings = pgTable(
  "vehicle_market_listings",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    vehicleId: text("vehicle_id").notNull(),
    offeringOperatorId: uuid("offering_operator_id").notNull(),
    listingType: text("listing_type", { enum: ["sale", "rental"] }).notNull(),
    priceCents: bigint("price_cents", { mode: "bigint" }).notNull(),
    rentalValidUntilS: bigint("rental_valid_until_s", { mode: "number" }),
    disclosure: jsonb("disclosure").notNull(),
    disclosureHash: text("disclosure_hash").notNull(),
    listedAtS: bigint("listed_at_s", { mode: "number" }).notNull(),
    expiresAtS: bigint("expires_at_s", { mode: "number" }).notNull(),
    status: text("status", {
      enum: ["open", "reserved", "transferred", "cancelled", "expired", "reversed"],
    }).notNull(),
    reservedByOperatorId: uuid("reserved_by_operator_id"),
    reservedUntilS: bigint("reserved_until_s", { mode: "number" }),
    contractId: uuid("contract_id"),
    revision: integer("revision").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull(),
  },
  (table) => [
    uniqueIndex("vehicle_market_listings_world_id_idx").on(table.worldId, table.id),
    uniqueIndex("vehicle_market_listings_world_offeror_idempotency_idx").on(
      table.worldId,
      table.offeringOperatorId,
      table.idempotencyKey,
    ),
    uniqueIndex("vehicle_market_listings_world_vehicle_open_idx")
      .on(table.worldId, table.vehicleId)
      .where(sql`${table.status} in ('open', 'reserved')`),
    index("vehicle_market_listings_world_status_idx").on(table.worldId, table.status),
    foreignKey({
      name: "vehicle_market_listings_world_vehicle_fk",
      columns: [table.worldId, table.vehicleId],
      foreignColumns: [vehicleAssets.worldId, vehicleAssets.vehicleId],
    }),
    foreignKey({
      name: "vehicle_market_listings_world_offeror_fk",
      columns: [table.worldId, table.offeringOperatorId],
      foreignColumns: [operators.worldId, operators.id],
    }),
    foreignKey({
      name: "vehicle_market_listings_world_reserver_fk",
      columns: [table.worldId, table.reservedByOperatorId],
      foreignColumns: [operators.worldId, operators.id],
    }),
    foreignKey({
      name: "vehicle_market_listings_world_contract_fk",
      columns: [table.worldId, table.contractId],
      foreignColumns: [operatorContracts.worldId, operatorContracts.id],
    }),
  ],
);

export const vehicleMarketTransfers = pgTable(
  "vehicle_market_transfers",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    listingId: uuid("listing_id").notNull(),
    vehicleId: text("vehicle_id").notNull(),
    transferType: text("transfer_type", {
      enum: ["sale", "rental-start", "rental-return", "reversal"],
    }).notNull(),
    fromOwnerOperatorId: uuid("from_owner_operator_id").notNull(),
    toOwnerOperatorId: uuid("to_owner_operator_id").notNull(),
    fromHolderOperatorId: uuid("from_holder_operator_id").notNull(),
    toHolderOperatorId: uuid("to_holder_operator_id").notNull(),
    contractId: uuid("contract_id"),
    priceCents: bigint("price_cents", { mode: "bigint" }).notNull(),
    transferredAtS: bigint("transferred_at_s", { mode: "number" }).notNull(),
    assetBeforeHash: text("asset_before_hash").notNull(),
    assetAfterHash: text("asset_after_hash").notNull(),
    reversalOfTransferId: uuid("reversal_of_transfer_id"),
    idempotencyKey: text("idempotency_key").notNull(),
  },
  (table) => [
    uniqueIndex("vehicle_market_transfers_world_id_idx").on(table.worldId, table.id),
    uniqueIndex("vehicle_market_transfers_world_idempotency_idx").on(
      table.worldId,
      table.idempotencyKey,
    ),
    index("vehicle_market_transfers_world_vehicle_idx").on(
      table.worldId,
      table.vehicleId,
      table.transferredAtS,
    ),
    foreignKey({
      name: "vehicle_market_transfers_world_listing_fk",
      columns: [table.worldId, table.listingId],
      foreignColumns: [vehicleMarketListings.worldId, vehicleMarketListings.id],
    }),
    foreignKey({
      name: "vehicle_market_transfers_world_vehicle_fk",
      columns: [table.worldId, table.vehicleId],
      foreignColumns: [vehicleAssets.worldId, vehicleAssets.vehicleId],
    }),
    foreignKey({
      name: "vehicle_market_transfers_world_contract_fk",
      columns: [table.worldId, table.contractId],
      foreignColumns: [operatorContracts.worldId, operatorContracts.id],
    }),
    foreignKey({
      name: "vehicle_market_transfers_world_reversal_fk",
      columns: [table.worldId, table.reversalOfTransferId],
      foreignColumns: [table.worldId, table.id],
    }),
  ],
);

/**
 * Unveraenderliche, hashverkettete Lebenslaufspur eines Fahrzeugs. Sie ist
 * absichtlich breiter als der Markttransfer: auch Erstaufnahme,
 * Zustandsfortschreibung und bilateral vereinbarte Mieten muessen spaeter
 * offengelegt und auditiert werden koennen.
 */
export const vehicleAssetHistoryEvents = pgTable(
  "vehicle_asset_history_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    vehicleId: text("vehicle_id").notNull(),
    eventType: text("event_type", {
      enum: ["registered", "condition-updated", "sale", "rental-start", "rental-return", "reversal"],
    }).notNull(),
    listingId: uuid("listing_id"),
    contractId: uuid("contract_id"),
    atS: bigint("at_s", { mode: "number" }).notNull(),
    priorHistoryHash: text("prior_history_hash"),
    resultingHistoryHash: text("resulting_history_hash").notNull(),
    details: jsonb("details").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
  },
  (table) => [
    uniqueIndex("vehicle_asset_history_events_world_id_idx").on(table.worldId, table.id),
    uniqueIndex("vehicle_asset_history_events_world_idempotency_idx").on(table.worldId, table.idempotencyKey),
    index("vehicle_asset_history_events_world_vehicle_idx").on(table.worldId, table.vehicleId, table.atS, table.id),
    foreignKey({
      name: "vehicle_asset_history_events_world_vehicle_fk",
      columns: [table.worldId, table.vehicleId],
      foreignColumns: [vehicleAssets.worldId, vehicleAssets.vehicleId],
    }),
    foreignKey({
      name: "vehicle_asset_history_events_world_listing_fk",
      columns: [table.worldId, table.listingId],
      foreignColumns: [vehicleMarketListings.worldId, vehicleMarketListings.id],
    }),
    foreignKey({
      name: "vehicle_asset_history_events_world_contract_fk",
      columns: [table.worldId, table.contractId],
      foreignColumns: [operatorContracts.worldId, operatorContracts.id],
    }),
  ],
);

export type OperatorContract = typeof operatorContracts.$inferSelect;
export type VehicleAsset = typeof vehicleAssets.$inferSelect;
export type VehicleMarketListing = typeof vehicleMarketListings.$inferSelect;
export type VehicleMarketTransfer = typeof vehicleMarketTransfers.$inferSelect;
export type VehicleAssetHistoryEvent = typeof vehicleAssetHistoryEvents.$inferSelect;
