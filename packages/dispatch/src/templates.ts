import type { OperatingProgram } from "./program.js";
import { OPERATING_PROGRAM_SCHEMA } from "./program.js";

const predicate = (fact: string, type: "integer" | "boolean", value: number | boolean) => ({
  type: "predicate" as const,
  fact,
  comparison: type === "boolean" ? "equal" as const : "greater_or_equal" as const,
  value: { type, value },
});

export function operatingProgramTemplates(worldId: string, operatorId: string, version: number): readonly OperatingProgram[] {
  const make = (rules: OperatingProgram["rules"]): OperatingProgram => ({ schema: OPERATING_PROGRAM_SCHEMA, world_id: worldId, operator_id: operatorId, version, enabled: true, rules });
  return [
    make([
      { id: "closure-short-turn", priority: 300, enabled: true, trigger: { type: "route_closure" }, condition: predicate("route_closed", "boolean", true) as OperatingProgram["rules"][number]["condition"], action: "short_turn" },
      { id: "delay-break-connection", priority: 200, enabled: true, trigger: { type: "delay_threshold", at_least_seconds: 300 }, condition: predicate("delay_seconds", "integer", 300) as OperatingProgram["rules"][number]["condition"], action: "break_connection" },
      { id: "turnaround-cancel", priority: 100, enabled: true, trigger: { type: "turnaround_shortfall" }, condition: predicate("turnaround_shortfall_seconds", "integer", 1) as OperatingProgram["rules"][number]["condition"], action: "cancel_run" },
    ]),
    make([
      { id: "connection-hold", priority: 300, enabled: true, trigger: { type: "connection_risk" }, condition: predicate("connection_threatened", "boolean", true) as OperatingProgram["rules"][number]["condition"], action: "hold_connection" },
      { id: "closure-reroute", priority: 200, enabled: true, trigger: { type: "route_closure" }, condition: predicate("route_closed", "boolean", true) as OperatingProgram["rules"][number]["condition"], action: "request_reroute" },
    ]),
    make([
      { id: "turnaround-short-turn", priority: 300, enabled: true, trigger: { type: "turnaround_shortfall" }, condition: predicate("turnaround_shortfall_seconds", "integer", 1) as OperatingProgram["rules"][number]["condition"], action: "short_turn" },
      { id: "delay-skip-stop", priority: 200, enabled: true, trigger: { type: "delay_threshold", at_least_seconds: 600 }, condition: predicate("delay_seconds", "integer", 600) as OperatingProgram["rules"][number]["condition"], action: "skip_stop" },
      { id: "vehicle-reserve", priority: 100, enabled: true, trigger: { type: "vehicle_failure" }, condition: predicate("vehicle_failed", "boolean", true) as OperatingProgram["rules"][number]["condition"], action: "activate_reserve_rotation" },
    ]),
  ];
}
