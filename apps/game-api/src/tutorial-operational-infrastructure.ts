import {
  OPERATIONAL_INFRASTRUCTURE_BINDING_SCHEMA,
  OPERATIONAL_INFRASTRUCTURE_FILE,
  type OperationalInfrastructureBinding,
} from "@zugfolge/runtime-native";

export const TUTORIAL_OPERATIONAL_INFRASTRUCTURE_DESCRIPTOR_SCHEMA =
  "zugfolge-tutorial-operational-infrastructure-descriptor/v1" as const;

/**
 * Buildzeitlich gepruefter Descriptor des externen Tutorial-Artefakts.
 * Die statischen Betriebsdaten selbst werden nie durch Node materialisiert.
 */
export const TUTORIAL_OPERATIONAL_INFRASTRUCTURE_DESCRIPTOR = Object.freeze({
  schemaVersion: TUTORIAL_OPERATIONAL_INFRASTRUCTURE_DESCRIPTOR_SCHEMA,
  templateVersion: "tutorial-minimal-2026.1",
  templateHash: "edd9169375eef10536b6780515fc654f09f58f5a4f9ea0830dd83f4de07ecfa8",
  binding: Object.freeze({
    schemaVersion: OPERATIONAL_INFRASTRUCTURE_BINDING_SCHEMA,
    infraReleaseId: "tutorial-minimal-2026.1:operational-infra",
    file: OPERATIONAL_INFRASTRUCTURE_FILE,
    bytes: 4_256,
    sha256: "3eada8c2882489b109f9e8c6d373dd8ab5f6873b68032fc98ea6fab6dcdd60b3",
    stateHash: "37b9e412ead217c99b29907b305635e1e0f0985f9dee12d483c1de9c7bd12a21",
  }) satisfies OperationalInfrastructureBinding,
});
