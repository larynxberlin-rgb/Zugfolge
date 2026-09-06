import type { ArtCatalogVersion, ArtDirection } from "./types.js";

export const ART_DIRECTIONS: readonly ArtDirection[] = ["north", "east", "south", "west"];
export const PASSENGER_APPEARANCES = ["passenger-01", "passenger-02", "passenger-03", "passenger-04"] as const;
export const CONDUCTOR_APPEARANCE = "conductor-01";
export const ART_BRAND_COLORS = ["#101419ff", "#181e25ff", "#202830ff", "#e5233dff"] as const;
export const ART_CATALOG_VERSIONS = ["conductor-art-catalog/v1", "conductor-art-catalog/v2"] as const;

/** Generische Bildfamilien ohne Baureihen-, Konfigurations- oder Kapazitätsaussage. */
export const VEHICLE_VARIANTS = [
  { id: "regional-double", label: "Regionaler Doppelstockwagen", decks: ["lower", "upper"], parts: ["lower", "upper", "roof"] },
  { id: "intercity-single", label: "Einstöckiger Fernverkehrswagen", decks: ["body"], parts: ["body", "roof"] },
  { id: "regional-single", label: "Einstöckiger Regionalwagen", decks: ["body"], parts: ["body", "roof"] },
  { id: "intercity-double", label: "Fernverkehrs-Doppelstockwagen", decks: ["lower", "upper"], parts: ["lower", "upper", "roof"] },
  { id: "dining", label: "Speisewagen", decks: ["body"], parts: ["body", "roof"] },
  { id: "sleeper", label: "Schlafwagen", decks: ["body"], parts: ["body", "roof"] },
] as const;
export const VEHICLE_VARIANT_ASSETS: readonly string[] = VEHICLE_VARIANTS.flatMap((variant) => variant.parts.map((part) => `vehicle.${variant.id}.${part}`));

/** Versionierter Pflichtkorpus; vorhanden heißt weder generiert noch freigegeben. */
export const REQUIRED_STATIC_ASSETS: readonly string[] = [
  ...["floor", "wall", "window", "door-closed", "door-open", "seat", "standing", "multipurpose", "wc", "cab", "gangway"].map((part) => `interior.${part}`),
  ...["body", "front", "roof"].map((part) => `vehicle.${part}`),
  ...["small", "medium", "large"].flatMap((stationClass) => ["platform", "roof", "hall", "stairs", "underpass"].map((part) => `station.${stationClass}.${part}`)),
  ...["rural", "suburban", "urban"].flatMap((environment) => ["vegetation", "road", "building"].map((part) => `environment.${environment}.${part}`)),
  "signal.stop", "signal.proceed",
  ...["wheelchair", "bicycle", "stroller"].flatMap((needs) => ART_DIRECTIONS.map((direction) => `accessory.${needs}.${direction}`)),
];

export const REQUIRED_STATIC_ASSETS_V2: readonly string[] = [...REQUIRED_STATIC_ASSETS, ...VEHICLE_VARIANT_ASSETS];

/** v1 bleibt unverändert; unbekannte Katalogversionen erhalten keinen Ersatzumfang. */
export function requiredStaticAssets(catalogVersion: ArtCatalogVersion): readonly string[] {
  switch (catalogVersion) {
    case "conductor-art-catalog/v1": return REQUIRED_STATIC_ASSETS;
    case "conductor-art-catalog/v2": return REQUIRED_STATIC_ASSETS_V2;
    default: throw new Error("art_catalog_version_unknown");
  }
}
