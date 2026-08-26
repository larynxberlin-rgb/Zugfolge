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
    bytes: 2_793,
    sha256: "4fa3b6d829fc9a0ad102e038271901b880f7fd6b89926152ceefadcbb88bcc28",
    stateHash: "df104ba3bb4d553e75d4c6ac32cb13be070fcf6beb41f359d4b74be5d42306b1",
  }) satisfies OperationalInfrastructureBinding,
});
