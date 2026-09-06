/** Verlustfreier M5-Transport; Fachprüfung und Ableitung bleiben in Rust. */
export interface M5VehicleConfigurationV1 {
  readonly schemaVersion: "m5-vehicle-configuration/v1";
  readonly structural: {
    readonly doorCountPerSide: number;
    readonly doorWidthMm: number;
    readonly bodyLengthMm: number;
  };
  readonly interior: {
    readonly firstClassSeats: number;
    readonly secondClassSeats: number;
    readonly density: "dense" | "standard" | "spacious";
    readonly seatType: "row" | "face_to_face" | "folding";
    readonly multipurpose: {
      readonly bicycles: number;
      readonly pushchairs: number;
      readonly wheelchairs: number;
      readonly standing: number;
    };
    readonly toilets: number;
    readonly accessibleToilets: number;
    readonly amenities: readonly ("air_conditioning" | "wifi" | "power_sockets" | "passenger_information")[];
  };
}

const invalid = () => new TypeError("M5-Fahrzeugkonfiguration verletzt den versionierten Transportvertrag.");
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) throw invalid();
  return row;
}
function integer(value: unknown, maximum: number, positive = false): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > maximum) throw invalid();
}
function choice(value: unknown, choices: readonly string[]): void {
  if (typeof value !== "string" || !choices.includes(value)) throw invalid();
}

/** Prüft nur vollständige JSON-Struktur und Datentypen, erzeugt keine Ersatzwerte. */
export function validateM5VehicleConfiguration(value: unknown): asserts value is M5VehicleConfigurationV1 {
  const row = object(value, ["schemaVersion", "structural", "interior"]);
  if (row["schemaVersion"] !== "m5-vehicle-configuration/v1") throw invalid();
  const structure = object(row["structural"], ["doorCountPerSide", "doorWidthMm", "bodyLengthMm"]);
  integer(structure["doorCountPerSide"], 255, true);
  integer(structure["doorWidthMm"], 65_535, true);
  integer(structure["bodyLengthMm"], 4_294_967_295, true);
  const interior = object(row["interior"], ["firstClassSeats", "secondClassSeats", "density", "seatType", "multipurpose", "toilets", "accessibleToilets", "amenities"]);
  for (const key of ["firstClassSeats", "secondClassSeats"] as const) integer(interior[key], 65_535);
  for (const key of ["toilets", "accessibleToilets"] as const) integer(interior[key], 255);
  choice(interior["density"], ["dense", "standard", "spacious"]);
  choice(interior["seatType"], ["row", "face_to_face", "folding"]);
  const special = object(interior["multipurpose"], ["bicycles", "pushchairs", "wheelchairs", "standing"]);
  for (const key of ["bicycles", "pushchairs", "wheelchairs", "standing"] as const) integer(special[key], 65_535);
  const amenities = interior["amenities"];
  if (!Array.isArray(amenities) || amenities.length > 4 || new Set(amenities).size !== amenities.length) throw invalid();
  for (const item of amenities) choice(item, ["air_conditioning", "wifi", "power_sockets", "passenger_information"]);
}
