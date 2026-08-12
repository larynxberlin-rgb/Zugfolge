import type { OperatorContract, VehicleAsset, VehicleMarketListing } from "@zugfolge/db";

export type ContractType = "traction" | "vehicle-rental" | "connection" | "disruption-assistance";

export interface ContractOfferInput {
  readonly worldId: string;
  readonly offerorOperatorId: string;
  readonly offereeOperatorId: string;
  readonly offeredByAccountId: string;
  readonly contractType: ContractType;
  readonly subject: Readonly<Record<string, unknown>>;
  readonly terms: Readonly<Record<string, unknown>>;
  readonly priceCents: bigint;
  readonly validFromS: number;
  readonly validUntilS: number;
  readonly responseDeadlineS: number;
  readonly terminationNoticeS: number;
  readonly offeredAtS: number;
  readonly idempotencyKey: string;
}

export interface ContractAuthorityDecision {
  readonly permitted: boolean;
  readonly code: string;
  readonly explanation: string;
}

export interface CooperationAuthority {
  verifyContract(input: ContractOfferInput): Promise<ContractAuthorityDecision>;
  verifyVehicleListing(input: {
    readonly worldId: string;
    readonly vehicle: VehicleAsset;
    readonly listingType: "sale" | "rental";
    readonly atS: number;
  }): Promise<ContractAuthorityDecision>;
  verifyVehicleTransfer(input: {
    readonly worldId: string;
    readonly vehicle: VehicleAsset;
    readonly listing: VehicleMarketListing;
    readonly buyerOperatorId: string;
    readonly atS: number;
  }): Promise<ContractAuthorityDecision>;
  verifyVehicleReversal(input: {
    readonly worldId: string;
    readonly vehicle: VehicleAsset;
    readonly listing: VehicleMarketListing;
    readonly reasonCode: string;
    readonly atS: number;
  }): Promise<ContractAuthorityDecision>;
}

export interface RegisterVehicleInput {
  readonly worldId: string;
  readonly vehicleId: string;
  readonly authorityReleaseId: string;
  readonly classDesignation: string;
  readonly actualConfiguration: Readonly<Record<string, unknown>>;
  readonly ownerOperatorId: string;
  readonly odometerMetres: bigint;
  readonly conditionBasisPoints: number;
  readonly damages: readonly Readonly<Record<string, unknown>>[];
  readonly maintenanceDeadlines: readonly Readonly<Record<string, unknown>>[];
  readonly approvals: readonly string[];
  readonly operatingLimits: readonly string[];
  readonly valuationSpecId: string;
  readonly valueCents: bigint;
  readonly acquiredAtS: number;
}

export interface UpdateVehicleConditionInput {
  readonly worldId: string;
  readonly vehicleId: string;
  readonly actingOperatorId: string;
  readonly actingAccountId: string;
  readonly atS: number;
  readonly expectedRevision: number;
  readonly odometerMetres: bigint;
  readonly conditionBasisPoints: number;
  readonly damages: readonly Readonly<Record<string, unknown>>[];
  readonly maintenanceDeadlines: readonly Readonly<Record<string, unknown>>[];
  readonly bindings: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}

export interface CreateListingInput {
  readonly worldId: string;
  readonly vehicleId: string;
  readonly offeringOperatorId: string;
  readonly listingType: "sale" | "rental";
  readonly priceCents: bigint;
  readonly rentalValidUntilS?: number;
  readonly listedAtS: number;
  readonly expiresAtS: number;
  readonly idempotencyKey: string;
}

export interface ContractActionInput {
  readonly worldId: string;
  readonly contractId: string;
  readonly actingAccountId: string;
  readonly atS: number;
  readonly reason?: string;
}

export interface VehicleTransferResult {
  readonly listing: VehicleMarketListing;
  readonly vehicle: VehicleAsset;
  readonly contract?: OperatorContract;
  readonly transferId: string;
}
