import type {
  LivemapObjectKind,
  PublicExternalTrain,
  PublicTrain,
} from "./stream.js";

export const LIVEMAP_CONFIG_SCHEMA = "zugfolge-livemap-config/v1" as const;
export const LIVEMAP_OBJECT_DETAIL_SCHEMA = "zugfolge-livemap-object-detail/v1" as const;
export const STATION_BOARD_SCHEMA = "zugfolge-station-board/v1" as const;
export const PASSENGER_INFORMATION_DISPLAY_SCHEMA = "zugfolge-passenger-information-display/v1" as const;
export const PUBLIC_TRAIN_DETAIL_SCHEMA = "zugfolge-public-train-detail/v1" as const;
export const OWNER_TRAIN_DETAIL_SCHEMA = "zugfolge-owner-train-detail/v1" as const;

export interface BoundsE7 {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/** Weltgebundene, produktiv ausschliesslich selbst gehostete Kartenquellen. */
export interface LivemapConfigV1 {
  readonly schemaVersion: typeof LIVEMAP_CONFIG_SCHEMA;
  readonly worldId: string;
  readonly infrastructureReleaseId: string;
  readonly basemap: {
    readonly styleUrl: string;
    readonly tilesUrl?: string;
    readonly attribution: string;
    readonly selfHosted: true;
  };
  readonly infrastructure: {
    readonly pmtilesUrl: string;
    readonly attribution: string;
    readonly coverage: "DE";
  };
  readonly initialView: {
    readonly latitudeE7: number;
    readonly longitudeE7: number;
    readonly zoomMilli: number;
  };
  readonly playableArea?: {
    readonly label: string;
    readonly boundsE7: BoundsE7;
  };
}

export interface LivemapObjectFact {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
}

export interface LivemapObjectDetailV1 {
  readonly schemaVersion: typeof LIVEMAP_OBJECT_DETAIL_SCHEMA;
  readonly worldId: string;
  readonly infrastructureReleaseId: string;
  readonly kind: LivemapObjectKind;
  readonly id: string;
  readonly name: string;
  readonly qualityClass: "A" | "B" | "C";
  readonly facts: readonly LivemapObjectFact[];
}

export type StationBoardStatus =
  | "scheduled"
  | "boarding"
  | "cancelled"
  | "departed"
  | "arrived";

export interface StationBoardCall {
  readonly trainId: string;
  readonly trainNumber: string;
  readonly category: string;
  readonly scheduledTimeS: number;
  readonly expectedTimeS: number;
  readonly platform?: string;
  readonly origin?: string;
  readonly destination?: string;
  readonly status: StationBoardStatus;
}

/** Abfahrten und Ankuenfte stammen aus derselben weltzeitgebundenen Projektion. */
export interface StationBoardV1 {
  readonly schemaVersion: typeof STATION_BOARD_SCHEMA;
  readonly worldId: string;
  readonly stationId: string;
  readonly stationName: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly atS: number;
  readonly departures: readonly StationBoardCall[];
  readonly arrivals: readonly StationBoardCall[];
}

/** Fahrplanfakten, die mit dem oeffentlichen Livezustand zum FIS kombiniert werden. */
export interface PassengerInformationPlan {
  readonly trainId: string;
  readonly destination?: string;
  readonly followingStops: readonly string[];
  readonly messages: readonly string[];
}

export interface PassengerInformationDisplayV1 {
  readonly schemaVersion: typeof PASSENGER_INFORMATION_DISPLAY_SCHEMA;
  readonly trainId: string;
  readonly operator: string;
  readonly trainNumber: string;
  readonly category: string;
  readonly destination?: string;
  readonly nextStop?: string;
  readonly followingStops: readonly string[];
  readonly delaySeconds: number;
  readonly status: string;
  readonly messages: readonly string[];
}

export interface PublicTrainDetailV1 {
  readonly schemaVersion: typeof PUBLIC_TRAIN_DETAIL_SCHEMA;
  readonly worldId: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly atS: number;
  readonly movement: "network" | "external";
  readonly train: PublicTrain | PublicExternalTrain;
  /** Nur gesetzt, wenn das anfragende Konto die EVU-Zusatzsicht nutzen darf. */
  readonly ownerOperatorId?: string;
  readonly fis: PassengerInformationDisplayV1;
}

/** Betriebsinterne Zusatzsicht; die API gibt sie nur dem gruendenden Konto. */
export interface OwnerTrainDetailV1 {
  readonly schemaVersion: typeof OWNER_TRAIN_DETAIL_SCHEMA;
  readonly worldId: string;
  readonly operatorId: string;
  readonly trainId: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly atS: number;
  readonly formationLabel?: string;
  readonly vehicleIds: readonly string[];
  readonly personnelDutyIds: readonly string[];
  readonly pathResourceIds: readonly string[];
  readonly fixedCostCents?: string;
}

export interface LivemapProjectionCursor {
  readonly streamId: string;
  readonly sequence: number;
  readonly atS: number;
}

/**
 * Read-only-Port der Game-API. Implementierungen lesen nur gepinnte Releases
 * und serverautoritative Projektionen; Browserwerte sind niemals Eingabe.
 */
export interface LivemapReadModel {
  getConfig(worldId: string): Promise<LivemapConfigV1 | undefined>;
  getObjectDetail(
    worldId: string,
    kind: LivemapObjectKind,
    objectId: string,
  ): Promise<LivemapObjectDetailV1 | undefined>;
  getStationBoard(
    worldId: string,
    stationId: string,
    cursor: LivemapProjectionCursor,
  ): Promise<StationBoardV1 | undefined>;
  getPassengerInformation(
    worldId: string,
    trainId: string,
  ): Promise<PassengerInformationPlan | undefined>;
  getOwnerTrainDetail(
    worldId: string,
    operatorId: string,
    trainId: string,
    cursor: LivemapProjectionCursor,
  ): Promise<OwnerTrainDetailV1 | undefined>;
}
