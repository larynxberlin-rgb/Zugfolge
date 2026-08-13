ALTER TABLE "operator_contracts" DROP CONSTRAINT "operator_contracts_status_check";
--> statement-breakpoint
ALTER TABLE "operator_contracts" ADD COLUMN "termination_requested_by_operator_id" uuid;
--> statement-breakpoint
ALTER TABLE "operator_contracts" ADD COLUMN "termination_requested_at_s" bigint;
--> statement-breakpoint
ALTER TABLE "operator_contracts" ADD COLUMN "termination_effective_at_s" bigint;
--> statement-breakpoint
ALTER TABLE "operator_contracts" ADD COLUMN "termination_evidence_reference" text;
--> statement-breakpoint
ALTER TABLE "operator_contracts" ADD COLUMN "termination_rule_version" text;
--> statement-breakpoint
UPDATE "operator_contracts"
SET "status" = 'terminated',
	"end_reason" = concat('[legacy-unverified-non-performance] ', coalesce("end_reason", ''))
WHERE "status" = 'non-performance';
--> statement-breakpoint
ALTER TABLE "operator_contracts" ADD CONSTRAINT "operator_contracts_status_check" CHECK ("status" IN ('offered', 'accepted', 'termination-pending', 'rejected', 'active', 'terminated', 'non-performance', 'completed', 'expired'));
--> statement-breakpoint
ALTER TABLE "operator_contracts" ADD CONSTRAINT "operator_contracts_termination_time_check" CHECK (
	"termination_effective_at_s" IS NULL
	OR (
		"termination_requested_at_s" IS NOT NULL
		AND "termination_effective_at_s" >= "termination_requested_at_s"
	)
);
--> statement-breakpoint
ALTER TABLE "operator_contracts" ADD CONSTRAINT "operator_contracts_pending_termination_check" CHECK (
	"status" <> 'termination-pending'
	OR (
		"termination_requested_by_operator_id" IS NOT NULL
		AND "termination_requested_at_s" IS NOT NULL
		AND "termination_effective_at_s" IS NOT NULL
		AND "terminated_at_s" IS NULL
		AND "ended_at_s" IS NULL
		AND "termination_evidence_reference" IS NULL
		AND "termination_rule_version" IS NULL
	)
);
--> statement-breakpoint
ALTER TABLE "operator_contracts" ADD CONSTRAINT "operator_contracts_non_performance_evidence_check" CHECK (
	"status" <> 'non-performance'
	OR (
		"termination_requested_by_operator_id" IS NOT NULL
		AND "termination_requested_at_s" IS NOT NULL
		AND "termination_evidence_reference" IS NOT NULL
		AND "termination_rule_version" = 'zugfolge-contract-non-performance-rule/v1'
		AND "terminated_at_s" IS NOT NULL
		AND "termination_requested_at_s" = "terminated_at_s"
		AND "termination_effective_at_s" = "terminated_at_s"
		AND "ended_at_s" = "terminated_at_s"
	)
);
--> statement-breakpoint
ALTER TABLE "operator_contracts" ADD CONSTRAINT "operator_contracts_world_termination_requester_fk" FOREIGN KEY ("world_id", "termination_requested_by_operator_id") REFERENCES "public"."operators"("world_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "operator_contracts_world_termination_due_idx" ON "operator_contracts" ("world_id", "termination_effective_at_s") WHERE "status" = 'termination-pending';
