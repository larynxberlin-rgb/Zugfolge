CREATE TABLE "operator_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"offeror_operator_id" uuid NOT NULL,
	"offeree_operator_id" uuid NOT NULL,
	"contract_type" text NOT NULL,
	"subject" jsonb NOT NULL,
	"terms" jsonb NOT NULL,
	"terms_hash" text NOT NULL,
	"price_cents" bigint NOT NULL,
	"valid_from_s" bigint NOT NULL,
	"valid_until_s" bigint NOT NULL,
	"response_deadline_s" bigint NOT NULL,
	"termination_notice_s" bigint NOT NULL,
	"status" text NOT NULL,
	"offered_by_account_id" uuid NOT NULL,
	"responded_by_account_id" uuid,
	"offered_at_s" bigint NOT NULL,
	"responded_at_s" bigint,
	"terminated_at_s" bigint,
	"ended_at_s" bigint,
	"end_reason" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "operator_contracts_world_id_unique" UNIQUE("world_id", "id"),
	CONSTRAINT "operator_contracts_distinct_parties_check" CHECK ("offeror_operator_id" <> "offeree_operator_id"),
	CONSTRAINT "operator_contracts_price_check" CHECK ("price_cents" >= 0),
	CONSTRAINT "operator_contracts_window_check" CHECK ("valid_until_s" > "valid_from_s"),
	CONSTRAINT "operator_contracts_deadline_check" CHECK ("response_deadline_s" >= "offered_at_s" AND "response_deadline_s" <= "valid_from_s"),
	CONSTRAINT "operator_contracts_notice_check" CHECK ("termination_notice_s" >= 0),
	CONSTRAINT "operator_contracts_revision_check" CHECK ("revision" > 0),
	CONSTRAINT "operator_contracts_type_check" CHECK ("contract_type" IN ('traction', 'vehicle-rental', 'connection', 'disruption-assistance')),
	CONSTRAINT "operator_contracts_status_check" CHECK ("status" IN ('offered', 'accepted', 'rejected', 'active', 'terminated', 'non-performance', 'completed', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "vehicle_assets" (
	"world_id" uuid NOT NULL,
	"vehicle_id" text NOT NULL,
	"authority_release_id" text NOT NULL,
	"class_designation" text NOT NULL,
	"actual_configuration" jsonb NOT NULL,
	"owner_operator_id" uuid NOT NULL,
	"holder_operator_id" uuid NOT NULL,
	"lessor_operator_id" uuid,
	"odometer_metres" bigint NOT NULL,
	"condition_basis_points" integer NOT NULL,
	"damages" jsonb NOT NULL,
	"maintenance_deadlines" jsonb NOT NULL,
	"approvals" jsonb NOT NULL,
	"operating_limits" jsonb NOT NULL,
	"bindings" jsonb NOT NULL,
	"valuation_spec_id" text NOT NULL,
	"value_cents" bigint NOT NULL,
	"acquired_at_s" bigint NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"history_hash" text NOT NULL,
	CONSTRAINT "vehicle_assets_world_vehicle_pk" PRIMARY KEY("world_id", "vehicle_id"),
	CONSTRAINT "vehicle_assets_odometer_check" CHECK ("odometer_metres" >= 0),
	CONSTRAINT "vehicle_assets_condition_check" CHECK ("condition_basis_points" BETWEEN 0 AND 10000),
	CONSTRAINT "vehicle_assets_value_check" CHECK ("value_cents" >= 0),
	CONSTRAINT "vehicle_assets_revision_check" CHECK ("revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "vehicle_market_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"vehicle_id" text NOT NULL,
	"offering_operator_id" uuid NOT NULL,
	"listing_type" text NOT NULL,
	"price_cents" bigint NOT NULL,
	"rental_valid_until_s" bigint,
	"disclosure" jsonb NOT NULL,
	"disclosure_hash" text NOT NULL,
	"listed_at_s" bigint NOT NULL,
	"expires_at_s" bigint NOT NULL,
	"status" text NOT NULL,
	"reserved_by_operator_id" uuid,
	"reserved_until_s" bigint,
	"contract_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "vehicle_market_listings_world_id_unique" UNIQUE("world_id", "id"),
	CONSTRAINT "vehicle_market_listings_price_check" CHECK ("price_cents" > 0),
	CONSTRAINT "vehicle_market_listings_window_check" CHECK ("expires_at_s" > "listed_at_s"),
	CONSTRAINT "vehicle_market_listings_rental_check" CHECK (("listing_type" = 'rental' AND "rental_valid_until_s" > "expires_at_s") OR ("listing_type" = 'sale' AND "rental_valid_until_s" IS NULL)),
	CONSTRAINT "vehicle_market_listings_type_check" CHECK ("listing_type" IN ('sale', 'rental')),
	CONSTRAINT "vehicle_market_listings_status_check" CHECK ("status" IN ('open', 'reserved', 'transferred', 'cancelled', 'expired', 'reversed')),
	CONSTRAINT "vehicle_market_listings_revision_check" CHECK ("revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "vehicle_market_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"vehicle_id" text NOT NULL,
	"transfer_type" text NOT NULL,
	"from_owner_operator_id" uuid NOT NULL,
	"to_owner_operator_id" uuid NOT NULL,
	"from_holder_operator_id" uuid NOT NULL,
	"to_holder_operator_id" uuid NOT NULL,
	"contract_id" uuid,
	"price_cents" bigint NOT NULL,
	"transferred_at_s" bigint NOT NULL,
	"asset_before_hash" text NOT NULL,
	"asset_after_hash" text NOT NULL,
	"reversal_of_transfer_id" uuid,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "vehicle_market_transfers_world_id_unique" UNIQUE("world_id", "id"),
	CONSTRAINT "vehicle_market_transfers_price_check" CHECK ("price_cents" >= 0),
	CONSTRAINT "vehicle_market_transfers_type_check" CHECK ("transfer_type" IN ('sale', 'rental-start', 'rental-return', 'reversal'))
);
--> statement-breakpoint
CREATE TABLE "vehicle_asset_history_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"vehicle_id" text NOT NULL,
	"event_type" text NOT NULL,
	"listing_id" uuid,
	"contract_id" uuid,
	"at_s" bigint NOT NULL,
	"prior_history_hash" text,
	"resulting_history_hash" text NOT NULL,
	"details" jsonb NOT NULL,
	"idempotency_key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operator_contracts" ADD CONSTRAINT "operator_contracts_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operator_contracts" ADD CONSTRAINT "operator_contracts_world_offeror_fk" FOREIGN KEY ("world_id","offeror_operator_id") REFERENCES "public"."operators"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operator_contracts" ADD CONSTRAINT "operator_contracts_world_offeree_fk" FOREIGN KEY ("world_id","offeree_operator_id") REFERENCES "public"."operators"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operator_contracts" ADD CONSTRAINT "operator_contracts_world_offered_by_fk" FOREIGN KEY ("world_id","offered_by_account_id") REFERENCES "public"."accounts"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operator_contracts" ADD CONSTRAINT "operator_contracts_world_responded_by_fk" FOREIGN KEY ("world_id","responded_by_account_id") REFERENCES "public"."accounts"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_assets" ADD CONSTRAINT "vehicle_assets_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_assets" ADD CONSTRAINT "vehicle_assets_world_owner_fk" FOREIGN KEY ("world_id","owner_operator_id") REFERENCES "public"."operators"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_assets" ADD CONSTRAINT "vehicle_assets_world_holder_fk" FOREIGN KEY ("world_id","holder_operator_id") REFERENCES "public"."operators"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_assets" ADD CONSTRAINT "vehicle_assets_world_lessor_fk" FOREIGN KEY ("world_id","lessor_operator_id") REFERENCES "public"."operators"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_market_listings" ADD CONSTRAINT "vehicle_market_listings_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_market_listings" ADD CONSTRAINT "vehicle_market_listings_world_vehicle_fk" FOREIGN KEY ("world_id","vehicle_id") REFERENCES "public"."vehicle_assets"("world_id","vehicle_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_market_listings" ADD CONSTRAINT "vehicle_market_listings_world_offeror_fk" FOREIGN KEY ("world_id","offering_operator_id") REFERENCES "public"."operators"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_market_listings" ADD CONSTRAINT "vehicle_market_listings_world_reserver_fk" FOREIGN KEY ("world_id","reserved_by_operator_id") REFERENCES "public"."operators"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_market_listings" ADD CONSTRAINT "vehicle_market_listings_world_contract_fk" FOREIGN KEY ("world_id","contract_id") REFERENCES "public"."operator_contracts"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_market_transfers" ADD CONSTRAINT "vehicle_market_transfers_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_market_transfers" ADD CONSTRAINT "vehicle_market_transfers_world_listing_fk" FOREIGN KEY ("world_id","listing_id") REFERENCES "public"."vehicle_market_listings"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_market_transfers" ADD CONSTRAINT "vehicle_market_transfers_world_vehicle_fk" FOREIGN KEY ("world_id","vehicle_id") REFERENCES "public"."vehicle_assets"("world_id","vehicle_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_market_transfers" ADD CONSTRAINT "vehicle_market_transfers_world_contract_fk" FOREIGN KEY ("world_id","contract_id") REFERENCES "public"."operator_contracts"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_market_transfers" ADD CONSTRAINT "vehicle_market_transfers_world_reversal_fk" FOREIGN KEY ("world_id","reversal_of_transfer_id") REFERENCES "public"."vehicle_market_transfers"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_asset_history_events" ADD CONSTRAINT "vehicle_asset_history_events_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_asset_history_events" ADD CONSTRAINT "vehicle_asset_history_events_world_vehicle_fk" FOREIGN KEY ("world_id","vehicle_id") REFERENCES "public"."vehicle_assets"("world_id","vehicle_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_asset_history_events" ADD CONSTRAINT "vehicle_asset_history_events_world_listing_fk" FOREIGN KEY ("world_id","listing_id") REFERENCES "public"."vehicle_market_listings"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vehicle_asset_history_events" ADD CONSTRAINT "vehicle_asset_history_events_world_contract_fk" FOREIGN KEY ("world_id","contract_id") REFERENCES "public"."operator_contracts"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "operator_contracts_world_id_idx" ON "operator_contracts" USING btree ("world_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "operator_contracts_world_offeror_idempotency_idx" ON "operator_contracts" USING btree ("world_id","offeror_operator_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "operator_contracts_world_offeree_status_idx" ON "operator_contracts" USING btree ("world_id","offeree_operator_id","status");
--> statement-breakpoint
CREATE INDEX "operator_contracts_world_offeror_status_idx" ON "operator_contracts" USING btree ("world_id","offeror_operator_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_assets_world_vehicle_idx" ON "vehicle_assets" USING btree ("world_id","vehicle_id");
--> statement-breakpoint
CREATE INDEX "vehicle_assets_world_owner_idx" ON "vehicle_assets" USING btree ("world_id","owner_operator_id");
--> statement-breakpoint
CREATE INDEX "vehicle_assets_world_holder_idx" ON "vehicle_assets" USING btree ("world_id","holder_operator_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_market_listings_world_id_idx" ON "vehicle_market_listings" USING btree ("world_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_market_listings_world_offeror_idempotency_idx" ON "vehicle_market_listings" USING btree ("world_id","offering_operator_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_market_listings_world_vehicle_open_idx" ON "vehicle_market_listings" USING btree ("world_id","vehicle_id") WHERE "status" in ('open', 'reserved');
--> statement-breakpoint
CREATE INDEX "vehicle_market_listings_world_status_idx" ON "vehicle_market_listings" USING btree ("world_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_market_transfers_world_id_idx" ON "vehicle_market_transfers" USING btree ("world_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_market_transfers_world_idempotency_idx" ON "vehicle_market_transfers" USING btree ("world_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "vehicle_market_transfers_world_vehicle_idx" ON "vehicle_market_transfers" USING btree ("world_id","vehicle_id","transferred_at_s");
--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_asset_history_events_world_id_idx" ON "vehicle_asset_history_events" USING btree ("world_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_asset_history_events_world_idempotency_idx" ON "vehicle_asset_history_events" USING btree ("world_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "vehicle_asset_history_events_world_vehicle_idx" ON "vehicle_asset_history_events" USING btree ("world_id","vehicle_id","at_s","id");
