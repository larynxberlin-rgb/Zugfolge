import type {
  AlphaDatabase,
  CapacityCell,
  OnboardingPort,
  StartPackageProof,
  StartPackageSpec,
  TutorialResetPort,
} from "@zugfolge/alpha";

export const ALPHA_TUTORIAL_RESET_COMMAND_SCHEMA = "zugfolge-alpha-tutorial-reset-command/v1" as const;
export const ALPHA_START_PACKAGE_COMMAND_SCHEMA = "zugfolge-alpha-start-package-command/v1" as const;

export interface TutorialResetCommand {
  readonly schemaVersion: typeof ALPHA_TUTORIAL_RESET_COMMAND_SCHEMA;
  readonly commandId: string;
  readonly worldId: string;
  readonly accountId: string;
  readonly resetNumber: number;
}

export interface StartPackageCommand {
  readonly schemaVersion: typeof ALPHA_START_PACKAGE_COMMAND_SCHEMA;
  readonly commandId: string;
  readonly tx: AlphaDatabase;
  readonly worldId: string;
  readonly accountId: string;
  readonly keycloakSubject: string;
  readonly atS: number;
  readonly spec: StartPackageSpec;
}

/**
 * Einziger mutierender Einstieg fuer die Phase-2-Reise. HTTP- und Alpha-
 * Services duerfen damit weder Flottenzustand noch Wirtschaft oder
 * Betriebsprogramme selbst persistieren.
 */
export interface AlphaJourneyCommandWriter {
  resetTutorial(command: TutorialResetCommand): Promise<void>;
  grantStartPackage(command: StartPackageCommand): Promise<StartPackageProof>;
  capacityCells(worldId: string, fromS: number, untilS: number): Promise<readonly CapacityCell[]>;
  projectCommittedGrant?(worldId: string, commandId: string): Promise<void>;
}

export class AuthoritativeTutorialResetPort implements TutorialResetPort {
  constructor(private readonly writer: AlphaJourneyCommandWriter) {}

  async resetAndSeedAccount(worldId: string, accountId: string, resetNumber: number): Promise<void> {
    return this.writer.resetTutorial({
      schemaVersion: ALPHA_TUTORIAL_RESET_COMMAND_SCHEMA,
      commandId: `tutorial-reset:${worldId}:${accountId}:${resetNumber}`,
      worldId,
      accountId,
      resetNumber,
    });
  }
}

export class AuthoritativeOnboardingPort implements OnboardingPort {
  constructor(private readonly writer: AlphaJourneyCommandWriter) {}

  async grantThroughAuthoritativePaths(input: {
    readonly tx: AlphaDatabase;
    readonly worldId: string;
    readonly accountId: string;
    readonly keycloakSubject: string;
    readonly atS: number;
    readonly idempotencyKey: string;
    readonly spec: StartPackageSpec;
  }): Promise<StartPackageProof> {
    return this.writer.grantStartPackage({
      schemaVersion: ALPHA_START_PACKAGE_COMMAND_SCHEMA,
      commandId: input.idempotencyKey,
      tx: input.tx,
      worldId: input.worldId,
      accountId: input.accountId,
      keycloakSubject: input.keycloakSubject,
      atS: input.atS,
      spec: input.spec,
    });
  }

  async capacityCells(worldId: string, fromS: number, untilS: number): Promise<readonly CapacityCell[]> {
    return this.writer.capacityCells(worldId, fromS, untilS);
  }

  async afterGrantCommitted(worldId: string, idempotencyKey: string): Promise<void> {
    await this.writer.projectCommittedGrant?.(worldId, idempotencyKey);
  }
}
