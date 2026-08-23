import { alphaHash } from "@zugfolge/alpha";
import {
  OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
  type OperationalSimulationInitialization,
} from "@zugfolge/runtime-native";

/**
 * Domaenentrennung fuer die dauerhafte Bindung eines operativen Zustands an
 * genau den vollstaendigen, signierten Initialisierungsvertrag. Der aeussere
 * Deployment-Hash ist absichtlich kein Bestandteil, damit keine zirkulaere
 * Signaturabhaengigkeit entsteht.
 */
export const OPERATIONAL_SIMULATION_INITIALIZATION_HASH_SCHEMA =
  "zugfolge-operational-simulation-initialization/v2" as const;

export function operationalSimulationInitializationHash(
  initialization: OperationalSimulationInitialization,
): string {
  if (initialization.schemaVersion !== OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA) {
    throw new Error("OperationalSimulationInitialization besitzt ein unbekanntes Schema.");
  }
  return alphaHash(
    OPERATIONAL_SIMULATION_INITIALIZATION_HASH_SCHEMA,
    initialization,
  );
}
