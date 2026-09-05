import { readFileSync } from "node:fs";
import type { OperationalSimulationInitialization } from "@zugfolge/runtime-native";

export const TEST_INFRASTRUCTURE_BINDING = JSON.parse(readFileSync(new URL("../test-infrastructure/operations-v1/binding.json", import.meta.url), "utf8")) as OperationalSimulationInitialization["infraRelease"];
