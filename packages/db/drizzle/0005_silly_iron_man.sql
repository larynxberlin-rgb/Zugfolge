CREATE TABLE "economy_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"effect_id" text NOT NULL,
	"effect_type" text NOT NULL,
	"processed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_roles" DROP CONSTRAINT "account_roles_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_operator_id_operators_id_fk";
--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk";
--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_ledger_account_id_ledger_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_operator_id_operators_id_fk";
--> statement-breakpoint
ALTER TABLE "mailbox_messages" DROP CONSTRAINT "mailbox_messages_recipient_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "operators" DROP CONSTRAINT "operators_founding_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_world_id_idx" ON "accounts" USING btree ("world_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "operators_world_id_idx" ON "operators" USING btree ("world_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_world_id_idx" ON "ledger_accounts" USING btree ("world_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_world_id_idx" ON "ledger_transactions" USING btree ("world_id","id");--> statement-breakpoint
ALTER TABLE "economy_effects" ADD CONSTRAINT "economy_effects_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "economy_effects_world_type_id_idx" ON "economy_effects" USING btree ("world_id","effect_type","effect_id");--> statement-breakpoint
ALTER TABLE "account_roles" ADD CONSTRAINT "account_roles_world_account_fk" FOREIGN KEY ("world_id","account_id") REFERENCES "public"."accounts"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_world_operator_fk" FOREIGN KEY ("world_id","operator_id") REFERENCES "public"."operators"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_world_transaction_fk" FOREIGN KEY ("world_id","transaction_id") REFERENCES "public"."ledger_transactions"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_world_account_fk" FOREIGN KEY ("world_id","ledger_account_id") REFERENCES "public"."ledger_accounts"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_world_operator_fk" FOREIGN KEY ("world_id","operator_id") REFERENCES "public"."operators"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD CONSTRAINT "mailbox_messages_world_recipient_fk" FOREIGN KEY ("world_id","recipient_account_id") REFERENCES "public"."accounts"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_world_account_fk" FOREIGN KEY ("world_id","founding_account_id") REFERENCES "public"."accounts"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_world_operator_idempotency_idx" ON "ledger_transactions" USING btree ("world_id","operator_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_messages_world_recipient_idempotency_idx" ON "mailbox_messages" USING btree ("world_id","recipient_account_id","idempotency_key");
