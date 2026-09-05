/** Herkunft und Freigabe sind explizite Belege, keine aus Bildnamen abgeleiteten Behauptungen. */
export type ArtReviewStatus = "pending" | "approved" | "rejected";
export type ArtDirection = "north" | "east" | "south" | "west";
export type ArtCategory = "actor" | "interior" | "vehicle" | "station" | "environment" | "signal" | "accessory";

export interface ArtReviewV1 {
  status: ArtReviewStatus;
  reviewerId: string | null;
  evidenceId: string | null;
}

export interface ArtEvidenceV1 {
  id: string;
  path: string;
  sha256: string;
  mediaType: "application/json" | "text/plain" | "text/markdown" | "image/png";
}

export interface ArtReferenceV1 {
  id: string;
  description: string;
  source: string;
  sha256: string;
  rightsStatus: "approved" | "unverified" | "rejected";
  evidenceId: string | null;
}

export interface ArtGenerationV1 {
  prompt: string;
  referenceIds: string[];
  model: {
    provider: string;
    name: string | null;
    revision: string | null;
    /** Providerdeklaration im Herkunftsbeleg; keine Aussage über dessen C2PA-Signatur. */
    verification: "provider_declared" | "provider_undisclosed";
    evidenceId: string | null;
  };
  evidenceId: string | null;
}

export interface ArtAtlasFileV1 {
  id: string;
  path: string;
  sha256: string;
  widthPx: number;
  heightPx: number;
  /** Ganzzahlige verlustfreie Vervielfachung des logischen 32-Pixel/Meter-Rasters. */
  sourceScale: 1 | 2 | 3 | 4;
}

export interface ArtAtlasAssetV1 {
  id: string;
  fileId: string;
  rect: { x: number; y: number; width: number; height: number };
  worldWidthMm: number;
  worldHeightMm: number;
  /** Quellpixel relativ zum Ausschnitt; liegt exakt auf dessen logischem Raster. */
  pivot: { x: number; y: number };
  category: ArtCategory;
  generation: ArtGenerationV1;
  review: {
    visual: ArtReviewV1;
    logoAndText: ArtReviewV1;
    contrast: ArtReviewV1;
    provenance: ArtReviewV1;
  };
}

export interface ArtAnimationV1 {
  id: string;
  role: "passenger" | "conductor";
  appearanceId: string;
  direction: ArtDirection;
  state: "idle" | "walk" | "sitting";
  frames: { assetId: string; durationMs: number }[];
}

export interface ArtAccessoryBindingV1 {
  spaceNeeds: "wheelchair" | "bicycle" | "stroller";
  direction: ArtDirection;
  assetId: string;
  appearanceIds: string[];
}

export interface ArtAtlasManifestV1 {
  schemaVersion: "art-atlas-manifest/v1";
  releaseId: string;
  status: "candidate" | "approved" | "rejected";
  catalogVersion: "conductor-art-catalog/v1";
  pixelsPerMetre: 32;
  rendering: {
    projection: "orthogonal_top_down";
    zoomSteps: number[];
    sampling: "nearest_neighbor";
  };
  palette: { id: string; colors: string[] };
  files: ArtAtlasFileV1[];
  references: ArtReferenceV1[];
  evidence: ArtEvidenceV1[];
  assets: ArtAtlasAssetV1[];
  animations: ArtAnimationV1[];
  appearanceVariants: { variant: number; appearanceId: string }[];
  accessoryBindings: ArtAccessoryBindingV1[];
  /** Die visuelle Regression muss den vollständigen Korpus und drei Bahnhofsklassen zeigen. */
  releaseReview: ArtReviewV1;
}

/** Der autorisierte Weltserver liefert diesen Pin unabhängig vom eingelesenen Manifest. */
export interface ArtAtlasWorldPinV1 {
  schemaVersion: "art-atlas-world-pin/v1";
  worldId: string;
  releaseId: string;
  manifestSha256: string;
}

/** Bestehende Alpha-Releasekonvention: Ed25519 über den UTF-8-Hashstring. */
export interface ArtAtlasSignatureV1 {
  algorithm: "ed25519";
  keyId: string;
  signedHash: string;
  valueBase64: string;
}

export interface ArtAtlasIssueV1 { code: string; path: string }

export interface ArtAtlasReportV1 {
  schemaVersion: "art-atlas-report/v1";
  releaseId: string;
  manifestSha256: string;
  activationEligible: boolean;
  issues: ArtAtlasIssueV1[];
  statistics: { files: number; assets: number; animations: number; decodedPixels: number };
}

/** Bereits lokal geladene Bytes; keine Netzanfrage und kein alternativer Assetpfad. */
export interface ArtAtlasResources {
  files: ReadonlyMap<string, Uint8Array>;
  evidence: ReadonlyMap<string, Uint8Array>;
}

/** Unveränderte dekodierte RGBA-Werte; die Prüfung erzeugt und verändert keine Bilder. */
export interface DecodedArtImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}
