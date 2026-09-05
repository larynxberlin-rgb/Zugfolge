ALTER TABLE abuse_observations ADD COLUMN observation_key text;
--> statement-breakpoint
ALTER TABLE abuse_observations ADD COLUMN facts_hash text;
--> statement-breakpoint
DROP INDEX abuse_observations_world_correlation_idx;
--> statement-breakpoint
CREATE INDEX abuse_observations_world_correlation_idx ON abuse_observations (world_id, correlation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX abuse_observations_world_observation_key_idx ON abuse_observations (world_id, observation_key);
--> statement-breakpoint
ALTER TABLE mailbox_messages ADD COLUMN content_hash text;
--> statement-breakpoint
ALTER TABLE mailbox_messages ADD COLUMN purged_at timestamptz;
--> statement-breakpoint
CREATE INDEX mailbox_messages_world_retention_idx ON mailbox_messages (world_id, sent_at) WHERE purged_at IS NULL;
--> statement-breakpoint
-- Unbekannte Projektionsbelege koennen nach Restore weder Welt noch Outbox-FK besitzen.
CREATE TABLE odoo_projection_quarantine (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  message_id text NOT NULL,
  correlation_id text NOT NULL,
  observed_hash text,
  issue_kind text NOT NULL DEFAULT 'unknown',
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX odoo_projection_quarantine_world_message_issue_idx ON odoo_projection_quarantine (world_id, message_id, issue_kind);
--> statement-breakpoint
