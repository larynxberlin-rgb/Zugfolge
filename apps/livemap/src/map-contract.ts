import type {
  ExpressionSpecification,
  FilterSpecification,
  LayerSpecification,
  StyleSpecification,
  Map as MapLibreMap,
} from "maplibre-gl";
import type {
  LivemapConfigV2,
  LivemapObjectKind,
  PublicObjectState,
  PublicTrain,
} from "@zugfolge/livemap-stream";

export const INFRASTRUCTURE_SOURCE_ID = "germany-infrastructure";
export const TRAIN_SOURCE_ID = "live-trains";
export const PLAYABLE_AREA_SOURCE_ID = "playable-area";

export const SOURCE_LAYER_BY_KIND: Readonly<Record<LivemapObjectKind, string>> = Object.freeze({
  track: "tracks",
  station: "stations",
  platform: "platforms",
  switch: "switches",
  signal: "signals",
  block: "blocks",
  facility: "conflict_resources",
  "operating-point": "operating_points",
  "rail-context": "rail_context",
});

export const INTERACTION_LAYER_IDS = Object.freeze([
  "train-hit",
  "rail-corridors-hit",
  "stations",
]);

export const PLAYER_SIGNAL_ICON_ID = "zugfolge-player-signal";
export const PLAYER_STATION_ICON_ID = "zugfolge-player-station";

const INTERACTION_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  train: 0,
  signal: 1,
  switch: 2,
  station: 3,
  platform: 4,
  track: 5,
  block: 6,
  facility: 7,
  "operating-point": 4,
  "rail-context": 8,
});

const KIND_BY_SOURCE_LAYER: Readonly<Record<string, MapSelection["kind"]>> = Object.freeze({
  "rail-corridors": "track",
  rail_corridors: "track",
  tracks: "track",
  stations: "station",
  operating_points: "operating-point",
  platforms: "platform",
  switches: "switch",
  signals: "signal",
  blocks: "block",
  conflict_resources: "facility",
  rail_context: "rail-context",
});

export interface MapSelection {
  readonly kind: LivemapObjectKind | "train";
  readonly id: string;
  readonly label: string;
  /** Nur fuer Karten-Feature-State; gehoert bewusst nicht in URL oder Detail-API. */
  readonly sourceLayer?: string;
  /** Fasst am selben Klickpunkt fachlich identische Stations-/Streckentreffer zusammen. */
  readonly groupKey?: string;
}

export interface GeoJsonFeatureCollection {
  readonly type: "FeatureCollection";
  readonly features: readonly GeoJsonPointFeature[];
}

export interface GeoJsonPointFeature {
  readonly type: "Feature";
  readonly id: string;
  readonly geometry: { readonly type: "Point"; readonly coordinates: readonly [number, number] };
  readonly properties: Readonly<Record<string, string | number | boolean>>;
}

function sameOriginAsset(value: string, pageUrl: string): URL {
  if (value.trim() === "") throw new Error("Kartenartefakt-Adresse fehlt.");
  const resolved = new URL(value, pageUrl);
  const page = new URL(pageUrl);
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    throw new Error(`Kartenartefakt nutzt ein unzulässiges Protokoll: ${resolved.protocol}`);
  }
  if (resolved.origin !== page.origin) {
    throw new Error(`Kartenartefakt liegt nicht auf dem selbst gehosteten Ursprung ${page.origin}.`);
  }
  return resolved;
}

export function assertSelfHostedConfig(config: LivemapConfigV2, pageUrl: string): void {
  if (config.basemap.selfHosted !== true) {
    throw new Error("Die Basiskarte ist nicht als selbst gehostet ausgewiesen.");
  }
  sameOriginAsset(config.basemap.styleUrl, pageUrl);
  if (config.basemap.tilesUrl !== undefined) sameOriginAsset(config.basemap.tilesUrl, pageUrl);
  sameOriginAsset(config.infrastructure.pmtilesUrl, pageUrl);
  if (config.infrastructure.coverage !== "DE") {
    throw new Error("Der Infrastruktur-Layer deckt nicht Gesamtdeutschland ab.");
  }
}

function collectStyleUrls(style: StyleSpecification): readonly string[] {
  const urls: string[] = [];
  if (typeof style.sprite === "string") urls.push(style.sprite);
  else if (Array.isArray(style.sprite)) style.sprite.forEach((item) => urls.push(item.url));
  if (style.glyphs !== undefined) urls.push(style.glyphs);
  Object.values(style.sources).forEach((source) => {
    if ("url" in source && typeof source.url === "string") urls.push(source.url.replace(/^pmtiles:\/\//, ""));
    if ("tiles" in source && Array.isArray(source.tiles)) urls.push(...source.tiles);
  });
  return urls;
}

export function assertSelfHostedStyle(style: StyleSpecification, pageUrl: string): void {
  for (const value of collectStyleUrls(style)) sameOriginAsset(value, pageUrl);
}

function absoluteStyleAsset(value: string, pageUrl: string): string {
  return sameOriginAsset(value, pageUrl).href
    .replaceAll("%7B", "{")
    .replaceAll("%7D", "}");
}

function normalizedSelfHostedStyle(style: StyleSpecification, pageUrl: string): StyleSpecification {
  const normalized = structuredClone(style);
  if (typeof normalized.sprite === "string") {
    normalized.sprite = absoluteStyleAsset(normalized.sprite, pageUrl);
  } else if (Array.isArray(normalized.sprite)) {
    normalized.sprite = normalized.sprite.map((item) => ({
      ...item,
      url: absoluteStyleAsset(item.url, pageUrl),
    }));
  }
  if (normalized.glyphs !== undefined) normalized.glyphs = absoluteStyleAsset(normalized.glyphs, pageUrl);
  Object.values(normalized.sources).forEach((source) => {
    if ("url" in source && typeof source.url === "string") {
      const pmtiles = source.url.startsWith("pmtiles://");
      const value = pmtiles ? source.url.slice("pmtiles://".length) : source.url;
      source.url = `${pmtiles ? "pmtiles://" : ""}${absoluteStyleAsset(value, pageUrl)}`;
    }
    if ("tiles" in source && Array.isArray(source.tiles)) {
      source.tiles = source.tiles.map((value) => absoluteStyleAsset(value, pageUrl));
    }
  });
  return normalized;
}

export async function loadSelfHostedStyle(
  styleUrl: string,
  pageUrl: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<StyleSpecification> {
  const url = sameOriginAsset(styleUrl, pageUrl);
  const response = await fetchImplementation.call(globalThis, url, { cache: "no-cache", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Selbst gehosteter Kartenstil ist nicht verfügbar (HTTP ${response.status}).`);
  const style = await response.json() as StyleSpecification;
  if (style.version !== 8 || typeof style.sources !== "object" || !Array.isArray(style.layers)) {
    throw new Error("Selbst gehosteter Kartenstil verletzt den MapLibre-v8-Vertrag.");
  }
  assertSelfHostedStyle(style, pageUrl);
  return normalizedSelfHostedStyle(style, pageUrl);
}

type MissingImageMap = Pick<MapLibreMap, "addImage" | "getImage" | "hasImage" | "setMissingStyleImageResolver">;

export function installMissingBasemapImageResolver(currentMap: MissingImageMap, fallbackId = "building"): void {
  currentMap.setMissingStyleImageResolver((id) => {
    if (id === "" || currentMap.hasImage(id) || !currentMap.hasImage(fallbackId)) return;
    const fallback = currentMap.getImage(fallbackId);
    currentMap.addImage(id, fallback.data, {
      pixelRatio: fallback.pixelRatio,
      sdf: fallback.sdf,
      ...(fallback.stretchX === undefined ? {} : { stretchX: fallback.stretchX }),
      ...(fallback.stretchY === undefined ? {} : { stretchY: fallback.stretchY }),
      ...(fallback.content === undefined ? {} : { content: fallback.content }),
    });
  });
}

const qualityNotCFilter: FilterSpecification = ["!=", ["coalesce", ["get", "qualityClass"], ["get", "quality_class"]], "C"];
const stateExpression = ["feature-state", "operationalState"] as ExpressionSpecification;

type PlayerIconMap = Pick<MapLibreMap, "addImage" | "hasImage">;

/** Selbst gehostete, achromatische Spielerpiktogramme statt technischer Rohpunkte. */
export function installPlayerMapIcons(currentMap: PlayerIconMap): void {
  if (!currentMap.hasImage(PLAYER_SIGNAL_ICON_ID)) {
    const width = 12;
    const height = 18;
    const data = new Uint8Array(width * height * 4);
    const pixel = (x: number, y: number, red: number, green: number, blue: number, alpha = 255): void => {
      const offset = (y * width + x) * 4;
      data[offset] = red;
      data[offset + 1] = green;
      data[offset + 2] = blue;
      data[offset + 3] = alpha;
    };
    for (let x = 2; x <= 9; x += 1) {
      pixel(x, 0, 241, 243, 247);
      pixel(x, 9, 241, 243, 247);
    }
    for (let y = 1; y <= 8; y += 1) {
      pixel(2, y, 241, 243, 247);
      pixel(9, y, 241, 243, 247);
    }
    for (const [x, y] of [[5, 3], [6, 3], [5, 6], [6, 6]] as const) pixel(x, y, 113, 121, 135);
    for (let y = 10; y <= 17; y += 1) {
      pixel(5, y, 241, 243, 247);
      pixel(6, y, 241, 243, 247);
    }
    currentMap.addImage(PLAYER_SIGNAL_ICON_ID, { width, height, data }, { pixelRatio: 1 });
  }
  if (!currentMap.hasImage(PLAYER_STATION_ICON_ID)) {
    const width = 18;
    const height = 18;
    const data = new Uint8Array(width * height * 4);
    const pixel = (x: number, y: number, shade = 241): void => {
      const offset = (y * width + x) * 4;
      data[offset] = shade;
      data[offset + 1] = shade + (shade === 241 ? 2 : 0);
      data[offset + 2] = shade + (shade === 241 ? 6 : 0);
      data[offset + 3] = 255;
    };
    for (let step = 0; step <= 7; step += 1) {
      pixel(8 - step, 1 + step);
      pixel(9 + step, 1 + step);
    }
    for (let x = 2; x <= 15; x += 1) pixel(x, 8);
    for (const x of [3, 7, 10, 14]) for (let y = 9; y <= 14; y += 1) pixel(x, y);
    for (let x = 1; x <= 16; x += 1) pixel(x, 15);
    for (let x = 3; x <= 14; x += 1) pixel(x, 17, 113);
    currentMap.addImage(PLAYER_STATION_ICON_ID, { width, height, data }, { pixelRatio: 1 });
  }
}

function lineLayers(): LayerSpecification[] {
  return [
    {
      id: "rail-corridors",
      type: "line",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "rail_corridors",
      minzoom: 5,
      maxzoom: 8,
      filter: qualityNotCFilter,
      paint: {
        "line-color": "#717987",
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.7, 10, 2.2],
        "line-opacity": 0.88,
      },
    },
    {
      id: "tracks",
      type: "line",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "tracks",
      minzoom: 8,
      filter: qualityNotCFilter,
      paint: {
        "line-color": [
          "match",
          stateExpression,
          "restriction", "#f0b75a",
          "closure", "#ff715f",
          "construction", "#f1f3f7",
          "#c3cad4",
        ],
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 14, 2.8, 18, 4.5],
        "line-opacity": 0.94,
      },
    },
    {
      id: "tracks-restriction",
      type: "line",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "tracks",
      minzoom: 8,
      filter: qualityNotCFilter,
      paint: { "line-color": "#f0b75a", "line-width": 4.5, "line-dasharray": [2, 1.4], "line-opacity": ["case", ["==", stateExpression, "restriction"], 1, 0] },
    },
    {
      id: "tracks-closure",
      type: "line",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "tracks",
      minzoom: 8,
      filter: qualityNotCFilter,
      paint: { "line-color": "#ff715f", "line-width": 5.5, "line-dasharray": [0.5, 0.7], "line-opacity": ["case", ["==", stateExpression, "closure"], 1, 0] },
    },
    {
      id: "tracks-construction-white",
      type: "line",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "tracks",
      minzoom: 8,
      filter: qualityNotCFilter,
      paint: { "line-color": "#f1f3f7", "line-width": 6.5, "line-opacity": ["case", ["==", stateExpression, "construction"], 1, 0] },
    },
    {
      id: "tracks-construction-red",
      type: "line",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "tracks",
      minzoom: 8,
      filter: qualityNotCFilter,
      paint: { "line-color": "#ff715f", "line-width": 6.5, "line-dasharray": [1.4, 1.4], "line-opacity": ["case", ["==", stateExpression, "construction"], 1, 0] },
    },
  ];
}

function semanticLayers(): LayerSpecification[] {
  return [
    {
      id: "signals",
      type: "symbol",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "signals",
      minzoom: 14,
      filter: qualityNotCFilter,
      layout: {
        "icon-image": PLAYER_SIGNAL_ICON_ID,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 14, 1.05, 18, 1.35],
        "icon-allow-overlap": false,
        "icon-ignore-placement": false,
      },
    },
    {
      id: "stations",
      type: "symbol",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "stations",
      minzoom: 5,
      layout: {
        "icon-image": PLAYER_STATION_ICON_ID,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 5, 0.82, 14, 1.08],
        "icon-allow-overlap": false,
        "icon-ignore-placement": false,
        "text-field": [
          "case",
          ["!=", ["coalesce", ["get", "rl100"], ""], ""],
          ["concat", ["coalesce", ["get", "name"], "Bahnhof"], " · ", ["get", "rl100"]],
          ["coalesce", ["get", "name"], "Bahnhof"],
        ],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 5, 9, 14, 13],
        "text-offset": [0, 1.35],
        "text-anchor": "top",
        "text-optional": false,
      },
      paint: { "text-color": "#d8dde4", "text-halo-color": "#090b10", "text-halo-width": 1.5 },
    },
  ];
}

function hitLayers(): LayerSpecification[] {
  const corridor: LayerSpecification = {
    id: "rail-corridors-hit",
    type: "line",
    source: INFRASTRUCTURE_SOURCE_ID,
    "source-layer": "rail_corridors",
    minzoom: 5,
    filter: qualityNotCFilter,
    paint: { "line-color": "#000000", "line-width": 18, "line-opacity": 0 },
  };
  return [corridor];
}

export function infrastructureLayers(): readonly LayerSpecification[] {
  return Object.freeze([...lineLayers(), ...semanticLayers(), ...hitLayers()]);
}

export const trainLayers: readonly LayerSpecification[] = Object.freeze([
  {
    id: "train-halo",
    type: "circle",
    source: TRAIN_SOURCE_ID,
    minzoom: 3,
    paint: { "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 12, 0], "circle-color": "#ed3b55", "circle-opacity": 0.34 },
  },
  {
    id: "trains",
    type: "circle",
    source: TRAIN_SOURCE_ID,
    minzoom: 3,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 2.5, 5, 3.5, 12, 6.5],
      "circle-color": ["match", ["get", "status"], "cancelled", "#ff715f", "waiting", "#f0b75a", ["case", [">", ["coalesce", ["get", "delaySeconds"], 0], 900], "#ff715f", [">=", ["coalesce", ["get", "delaySeconds"], 0], 60], "#f0b75a", ["has", "delaySeconds"], "#7cddba", "#e4e8ed"]],
      "circle-stroke-color": "#090b10",
      "circle-stroke-width": 2,
    },
  },
  {
    id: "train-labels",
    type: "symbol",
    source: TRAIN_SOURCE_ID,
    minzoom: 4,
    layout: { "text-field": ["get", "markerLabel"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0.9, 0], "text-anchor": "left", "text-optional": true },
    paint: { "text-color": "#f1f3f7", "text-halo-color": "#090b10", "text-halo-width": 2.8 },
  },
  {
    id: "train-hit",
    type: "circle",
    source: TRAIN_SOURCE_ID,
    minzoom: 3,
    paint: { "circle-radius": 18, "circle-opacity": 0 },
  },
]);

export function trainFeatureCollection(
  trains: Iterable<PublicTrain & { readonly positionFrozen?: boolean }>,
  infrastructureReleaseId: string,
  frozen = false,
): GeoJsonFeatureCollection {
  const features: GeoJsonPointFeature[] = [];
  for (const train of trains) {
    const projection = train.mapPosition;
    if (projection === undefined || projection.infrastructureReleaseId !== infrastructureReleaseId) continue;
    const positionFrozen = frozen || train.positionFrozen === true;
    const markerLabel = [
      train.trainNumber,
      train.status === "cancelled" ? "Ausfall" : train.status === "waiting" ? "wartet" : undefined,
      train.status !== "cancelled" && train.delaySeconds !== undefined && train.delaySeconds >= 60
        ? `+${Math.floor(train.delaySeconds / 60)} min` : undefined,
      positionFrozen ? "Lage eingefroren" : undefined,
    ].filter((part) => part !== undefined).join(" · ");
    features.push(Object.freeze({
      type: "Feature",
      id: train.id,
      geometry: Object.freeze({
        type: "Point",
        coordinates: Object.freeze([
          projection.longitudeE7 / 10_000_000,
          projection.latitudeE7 / 10_000_000,
        ]) as readonly [number, number],
      }),
      properties: Object.freeze({
        objectKind: "train",
        objectId: train.id,
        label: train.trainNumber,
        trainNumber: train.trainNumber,
        markerLabel,
        positionFrozen,
        operator: train.operator,
        category: train.category,
        status: train.status,
        ...(train.delaySeconds === undefined ? {} : { delaySeconds: train.delaySeconds }),
        resourceId: projection.resourceId,
        positionKind: "exact",
        bearing: (projection.bearingMilliDegrees ?? 0) / 1_000,
        trackId: projection.trackId,
        offsetMm: projection.offsetMm,
      }),
    }));
  }
  return Object.freeze({ type: "FeatureCollection", features: Object.freeze(features) });
}

export function stateByObject(states: Iterable<PublicObjectState>): ReadonlyMap<string, PublicObjectState> {
  const result = new Map<string, PublicObjectState>();
  for (const state of states) result.set(`${state.objectKind}:${state.objectId}`, state);
  return result;
}

export function selectionFromFeature(feature: { readonly properties: Readonly<Record<string, unknown>>; readonly layer: { readonly id: string } }): MapSelection | undefined {
  const properties = feature.properties;
  const featureType = properties["feature_type"];
  const fallbackLayer = feature.layer.id.replace(/-hit$/, "");
  const fallbackKind = feature.layer.id === "train-hit"
    ? "train"
    : KIND_BY_SOURCE_LAYER[fallbackLayer];
  const kind = typeof properties["objectKind"] === "string"
    ? properties["objectKind"]
    : typeof featureType === "string" && featureType in INTERACTION_PRIORITY
      ? featureType
      : fallbackKind;
  const idValue = properties["objectId"] ?? properties["feature_id"];
  const id = typeof idValue === "string" ? idValue : undefined;
  if (id === undefined || kind === undefined || !(kind in INTERACTION_PRIORITY)) return undefined;
  const qualityClass = properties["qualityClass"] ?? properties["quality_class"];
  if (qualityClass === "C" && (kind === "track" || kind === "signal")) return undefined;
  const text = (key: string): string | undefined => {
    const value = properties[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim()
      : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
  };
  const routeNumber = text("route_number") ?? text("official_route_number");
  const routeName = text("route_name");
  const ril100 = text("rl100");
  const genericLabel = text("label") ?? text("display_name") ?? text("name") ?? text("trainNumber");
  const label = kind === "track"
    ? [routeNumber === undefined ? undefined : `Strecke ${routeNumber}`, routeName].filter((value): value is string => value !== undefined).join(" · ") || "Strecke"
    : kind === "station" || kind === "operating-point"
      ? [genericLabel ?? (kind === "station" ? "Bahnhof" : "Betriebsstelle"), ril100 === undefined ? undefined : `RIL 100 ${ril100}`].filter((value): value is string => value !== undefined).join(" · ")
      : genericLabel ?? (kind === "train" ? "Zug" : kind === "signal" ? "Signal" : "Kartenobjekt");
  const sourceLayer = feature.layer.id === "train-hit" ? undefined
    : feature.layer.id === "rail-corridors-hit" ? "rail_corridors"
      : feature.layer.id === "stations" ? "stations"
        : fallbackLayer.replaceAll("-", "_");
  const groupKey = kind === "track" && (routeNumber !== undefined || routeName !== undefined)
    ? `track:${routeNumber ?? ""}:${routeName ?? ""}`
    : (kind === "station" || kind === "operating-point") && ril100 !== undefined
      ? `station:${ril100}` : undefined;
  return Object.freeze({
    kind: kind as MapSelection["kind"],
    id,
    label,
    ...(sourceLayer === undefined ? {} : { sourceLayer }),
    ...(groupKey === undefined ? {} : { groupKey }),
  });
}

export function sortAndDeduplicateSelections(selections: readonly MapSelection[]): readonly MapSelection[] {
  const sorted = [...selections].sort((left, right) =>
    (INTERACTION_PRIORITY[left.kind] ?? 99) - (INTERACTION_PRIORITY[right.kind] ?? 99)
    || left.label.localeCompare(right.label, "de")
    || left.id.localeCompare(right.id),
  );
  const unique = new Map<string, MapSelection>();
  sorted.forEach((selection) => {
    const key = selection.groupKey ?? `${selection.kind}:${selection.id}`;
    if (!unique.has(key)) unique.set(key, selection);
  });
  return Object.freeze([...unique.values()]);
}

export function focusParameter(selection: Pick<MapSelection, "kind" | "id">): string {
  return `${selection.kind}:${selection.id}`;
}

export function parseFocusParameter(value: string | null): MapSelection | undefined {
  if (value === null) return undefined;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const kind = value.slice(0, separator);
  if (!(kind in INTERACTION_PRIORITY)) return undefined;
  const id = value.slice(separator + 1);
  return Object.freeze({ kind: kind as MapSelection["kind"], id, label: id });
}

export function emptyDarkStyle(): StyleSpecification {
  return {
    version: 8,
    name: "Zugfolge sichere Leerkarte",
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#090b10" } }],
  };
}
