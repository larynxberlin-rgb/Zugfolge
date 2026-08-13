ALTER TABLE "world_accesses" ADD COLUMN "accepted_world_contract_hash" text;
--> statement-breakpoint
ALTER TABLE "world_accesses" ADD COLUMN "accepted_starting_capital_policy" jsonb;
--> statement-breakpoint
ALTER TABLE "world_accesses" ADD COLUMN "world_contract_accepted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "world_accesses" ADD CONSTRAINT "world_accesses_contract_hash_check" CHECK ("accepted_world_contract_hash" IS NULL OR "accepted_world_contract_hash" ~ '^[a-f0-9]{64}$');
--> statement-breakpoint
ALTER TABLE "world_accesses" ADD CONSTRAINT "world_accesses_contract_acceptance_check" CHECK (
	("accepted_world_contract_hash" IS NULL AND "accepted_starting_capital_policy" IS NULL AND "world_contract_accepted_at" IS NULL)
	OR ("accepted_world_contract_hash" IS NOT NULL AND "accepted_starting_capital_policy" IS NOT NULL AND "world_contract_accepted_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "world_accesses" ADD CONSTRAINT "world_accesses_starting_capital_policy_check" CHECK (
	"accepted_starting_capital_policy" IS NULL
	OR (
		jsonb_typeof("accepted_starting_capital_policy") = 'object'
		AND (
			(
				"accepted_starting_capital_policy" = '{"kind":"unlimited"}'::jsonb
			)
			OR (
				"accepted_starting_capital_policy" ? 'kind'
				AND "accepted_starting_capital_policy" ? 'amountCents'
				AND ("accepted_starting_capital_policy" - 'kind' - 'amountCents') = '{}'::jsonb
				AND "accepted_starting_capital_policy"->>'kind' = 'finite'
				AND "accepted_starting_capital_policy"->>'amountCents' ~ '^[0-9]+$'
				AND length("accepted_starting_capital_policy"->>'amountCents') <= 19
				AND (
					length("accepted_starting_capital_policy"->>'amountCents') < 19
					OR "accepted_starting_capital_policy"->>'amountCents' <= '9223372036854775807'
				)
			)
		)
	)
);
--> statement-breakpoint
CREATE TABLE "operator_starting_capital" (
	"world_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"operator_id" uuid,
	"blueprint_hash" text NOT NULL,
	"policy_kind" text NOT NULL,
	"finite_amount_cents" bigint,
	"ledger_transaction_id" uuid,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_starting_capital_pk" PRIMARY KEY("world_id", "account_id"),
	CONSTRAINT "operator_starting_capital_blueprint_hash_check" CHECK ("blueprint_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "operator_starting_capital_policy_check" CHECK (
		("policy_kind" = 'finite' AND "finite_amount_cents" IS NOT NULL AND "finite_amount_cents" >= 0)
		OR ("policy_kind" = 'unlimited' AND "finite_amount_cents" IS NULL AND "ledger_transaction_id" IS NULL)
	),
	CONSTRAINT "operator_starting_capital_completion_check" CHECK (
		("operator_id" IS NULL AND "ledger_transaction_id" IS NULL AND "applied_at" IS NULL)
		OR (
			"operator_id" IS NOT NULL
			AND "applied_at" IS NOT NULL
			AND (
				("policy_kind" = 'finite' AND "ledger_transaction_id" IS NOT NULL)
				OR ("policy_kind" = 'unlimited' AND "ledger_transaction_id" IS NULL)
			)
		)
	)
);
--> statement-breakpoint
ALTER TABLE "operator_starting_capital" ADD CONSTRAINT "operator_starting_capital_world_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operator_starting_capital" ADD CONSTRAINT "operator_starting_capital_world_account_fk" FOREIGN KEY ("world_id", "account_id") REFERENCES "public"."accounts"("world_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operator_starting_capital" ADD CONSTRAINT "operator_starting_capital_world_operator_fk" FOREIGN KEY ("world_id", "operator_id") REFERENCES "public"."operators"("world_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operator_starting_capital" ADD CONSTRAINT "operator_starting_capital_world_transaction_fk" FOREIGN KEY ("world_id", "ledger_transaction_id") REFERENCES "public"."ledger_transactions"("world_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "operator_starting_capital_world_operator_idx" ON "operator_starting_capital" ("world_id", "operator_id") WHERE "operator_id" IS NOT NULL;
