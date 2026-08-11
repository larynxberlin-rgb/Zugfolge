export const TRIGGERS = [
  "delay_threshold", "connection_risk", "vehicle_failure", "personnel_duty_exceeded",
  "route_closure", "platform_change", "turnaround_shortfall", "ad_hoc_path_conflict",
] as const;
export const ACTIONS = [
  "hold_connection", "break_connection", "skip_stop", "short_turn", "shorten_train", "strengthen_train",
  "cancel_run", "activate_reserve_rotation", "provide_replacement_vehicle", "request_reroute",
  "return_path", "trigger_rail_replacement",
] as const;
export const FACTS = [
  "delay_seconds", "connection_threatened", "vehicle_failed", "duty_excess_seconds", "route_closed",
  "platform_changed", "turnaround_shortfall_seconds", "ad_hoc_conflict", "affected_train_runs", "cost_cents",
] as const;
export const COMPARISONS = ["equal", "not_equal", "greater_or_equal", "less_or_equal"] as const;

