CREATE TABLE conductor_owners (
  world_id uuid NOT NULL REFERENCES worlds(id), account_id uuid NOT NULL,
  owner_ref uuid NOT NULL, PRIMARY KEY(world_id, account_id),
  FOREIGN KEY(world_id, account_id) REFERENCES accounts(world_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX conductor_owners_world_ref_idx ON conductor_owners(world_id, owner_ref);
--> statement-breakpoint
CREATE TABLE conductor_train_states (
  world_id uuid NOT NULL REFERENCES worlds(id), train_run_id text NOT NULL,
  region_id text NOT NULL,
  state jsonb NOT NULL, state_hash text NOT NULL, revision bigint NOT NULL, at_ms bigint NOT NULL,
  PRIMARY KEY(world_id, train_run_id),
  CONSTRAINT conductor_train_states_values CHECK(revision >= 0 AND at_ms >= 0 AND state_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT conductor_train_states_world CHECK(coalesce(state->>'worldId' = world_id::text AND state->>'trainRunId' = train_run_id, false))
);
--> statement-breakpoint
CREATE TABLE conductor_leases (
  world_id uuid NOT NULL REFERENCES worlds(id), account_id uuid NOT NULL,
  owner_ref uuid NOT NULL, train_run_id text NOT NULL, session_id text NOT NULL, lease_until_ms bigint NOT NULL,
  PRIMARY KEY(world_id, account_id), FOREIGN KEY(world_id, account_id) REFERENCES accounts(world_id, id),
  CONSTRAINT conductor_leases_time CHECK(lease_until_ms >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX conductor_leases_world_train_idx ON conductor_leases(world_id, train_run_id);
--> statement-breakpoint
CREATE INDEX conductor_leases_world_expiry_idx ON conductor_leases(world_id, lease_until_ms);
--> statement-breakpoint
CREATE TABLE conductor_command_receipts (
  world_id uuid NOT NULL REFERENCES worlds(id), train_run_id text NOT NULL, command_id text NOT NULL,
  owner_ref uuid NOT NULL, request_hash text NOT NULL, receipt jsonb NOT NULL,
  PRIMARY KEY(world_id, train_run_id, command_id),
  FOREIGN KEY(world_id, owner_ref) REFERENCES conductor_owners(world_id, owner_ref),
  CONSTRAINT conductor_receipts_hash CHECK(request_hash ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE INDEX conductor_receipts_world_owner_idx ON conductor_command_receipts(world_id, owner_ref);
--> statement-breakpoint
CREATE TABLE conductor_snapshots (
  world_id uuid NOT NULL REFERENCES worlds(id), train_run_id text NOT NULL, session_id text NOT NULL,
  owner_ref uuid NOT NULL, sequence bigint NOT NULL, snapshot jsonb NOT NULL,
  PRIMARY KEY(world_id, train_run_id, sequence),
  FOREIGN KEY(world_id, owner_ref) REFERENCES conductor_owners(world_id, owner_ref),
  CONSTRAINT conductor_snapshots_sequence CHECK(sequence >= 0)
);
--> statement-breakpoint
CREATE INDEX conductor_snapshots_world_owner_idx ON conductor_snapshots(world_id, owner_ref);
--> statement-breakpoint
CREATE TRIGGER zugfolge_world_guard_conductor_command_receipts BEFORE INSERT OR UPDATE OR DELETE ON conductor_command_receipts FOR EACH ROW EXECUTE FUNCTION zugfolge_enforce_world_writer_guard('world_id');
--> statement-breakpoint
CREATE TRIGGER zugfolge_world_guard_conductor_leases BEFORE INSERT OR UPDATE OR DELETE ON conductor_leases FOR EACH ROW EXECUTE FUNCTION zugfolge_enforce_world_writer_guard('world_id');
--> statement-breakpoint
CREATE TRIGGER zugfolge_world_guard_conductor_owners BEFORE INSERT OR UPDATE OR DELETE ON conductor_owners FOR EACH ROW EXECUTE FUNCTION zugfolge_enforce_world_writer_guard('world_id');
--> statement-breakpoint
CREATE TRIGGER zugfolge_world_guard_conductor_snapshots BEFORE INSERT OR UPDATE OR DELETE ON conductor_snapshots FOR EACH ROW EXECUTE FUNCTION zugfolge_enforce_world_writer_guard('world_id');
--> statement-breakpoint
CREATE TRIGGER zugfolge_world_guard_conductor_train_states BEFORE INSERT OR UPDATE OR DELETE ON conductor_train_states FOR EACH ROW EXECUTE FUNCTION zugfolge_enforce_world_writer_guard('world_id');
--> statement-breakpoint
CREATE TABLE conductor_control_states (
  world_id uuid NOT NULL REFERENCES worlds(id), operator_id uuid NOT NULL,
  state jsonb NOT NULL, state_hash text NOT NULL, revision bigint NOT NULL, at_ms bigint NOT NULL,
  PRIMARY KEY(world_id, operator_id),
  FOREIGN KEY(world_id, operator_id) REFERENCES operators(world_id, id),
  CONSTRAINT conductor_control_states_values CHECK(revision >= 0 AND at_ms >= 0 AND state_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT conductor_control_states_binding CHECK(coalesce(jsonb_typeof(state) = 'object'
    AND state->>'schemaVersion' = 'fare-control-world-state/v1'
    AND state->>'worldId' = world_id::text AND state->>'operatorId' = operator_id::text
    AND state->>'stateHash' = state_hash AND state->>'revision' = revision::text AND state->>'nowMs' = at_ms::text, false))
);
--> statement-breakpoint
CREATE TRIGGER zugfolge_world_guard_conductor_control_states BEFORE INSERT OR UPDATE OR DELETE ON conductor_control_states FOR EACH ROW EXECUTE FUNCTION zugfolge_enforce_world_writer_guard('world_id');
