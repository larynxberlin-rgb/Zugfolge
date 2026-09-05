import type { ArtDirection } from "./types.js";

export const ART_DIRECTIONS: readonly ArtDirection[] = ["north", "east", "south", "west"];
export const PASSENGER_APPEARANCES = ["passenger-01", "passenger-02", "passenger-03", "passenger-04"] as const;
export const CONDUCTOR_APPEARANCE = "conductor-01";
export const ART_BRAND_COLORS = ["#101419ff", "#181e25ff", "#202830ff", "#e5233dff"] as const;

/** Versionierter Pflichtkorpus; vorhanden heißt weder generiert noch freigegeben. */
export const REQUIRED_STATIC_ASSETS: readonly string[] = [
  ...["floor", "wall", "window", "door-closed", "door-open", "seat", "standing", "multipurpose", "wc", "cab", "gangway"].map((part) => `interior.${part}`),
  ...["body", "front", "roof"].map((part) => `vehicle.${part}`),
  ...["small", "medium", "large"].flatMap((stationClass) => ["platform", "roof", "hall", "stairs", "underpass"].map((part) => `station.${stationClass}.${part}`)),
  ...["rural", "suburban", "urban"].flatMap((environment) => ["vegetation", "road", "building"].map((part) => `environment.${environment}.${part}`)),
  "signal.stop", "signal.proceed",
  ...["wheelchair", "bicycle", "stroller"].flatMap((needs) => ART_DIRECTIONS.map((direction) => `accessory.${needs}.${direction}`)),
];
