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
  "signals-hit",
  "switches-hit",
  "stations-hit",
  "operating_points-hit",
  "platforms-hit",
  "tracks-hit",
  "blocks-hit",
  "conflict_resources-hit",
  "rail_context-hit",
]);

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
const activeExpression = ["!=", ["coalesce", ["get", "qualityClass"], ["get", "quality_class"]], "C"] as ExpressionSpecification;

function lineLayers(): LayerSpecification[] {
  return [
    {
      id: "rail-corridors",
      type: "line",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "rail_corridors",
      minzoom: 5,
      maxzoom: 11,
      paint: {
        "line-color": ["case", activeExpression, "#717987", "#3a3f49"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.7, 10, 2.2],
        "line-opacity": ["case", activeExpression, 0.88, 0.45],
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
          ["case", activeExpression, "#c3cad4", "#515762"],
        ],
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 14, 2.8, 18, 4.5],
        "line-opacity": ["case", activeExpression, 0.94, 0.44],
      },
    },
    {
      id: "tracks-quality-c",
      type: "line",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "tracks",
      minzoom: 8,
      filter: ["==", ["coalesce", ["get", "qualityClass"], ["get", "quality_class"]], "C"],
      paint: {
        "line-color": "#737b88",
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 18, 3],
        "line-dasharray": [1.4, 1.6],
        "line-opacity": 0.58,
      },
    },
    {
      id: "tracks-restriction",
      type: "line",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "tracks",
      minzoom: 8,
      paint: { "line-color": "#f0b75a", "line-width": 4.5, "line-dasharray": [2, 1.4], "line-opacity": ["case", ["==", stateExpression, "restriction"], 1, 0] },
    },
    {
      id: "tracks-closure",
      type: "line",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "tracks",
      minzoom: 8,
      paint: { "line-color": "#ff715f", "line-width": 5.5, "line-dasharray": [0.5, 0.7], "line-opacity": ["case", ["==", stateExpression, "closure"], 1, 0] },
    },
    {
      id: "tracks-construction-white",
      type: "line",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "tracks",
      minzoom: 8,
      paint: { "line-color": "#f1f3f7", "line-width": 6.5, "line-opacity": ["case", ["==", stateExpression, "construction"], 1, 0] },
    },
    {
      id: "tracks-construction-red",
      type: "line",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "tracks",
      minzoom: 8,
      paint: { "line-color": "#ff715f", "line-width": 6.5, "line-dasharray": [1.4, 1.4], "line-opacity": ["case", ["==", stateExpression, "construction"], 1, 0] },
    },
  ];
}

function semanticLayers(): LayerSpecification[] {
  return [
    {
      id: "blocks",
      type: "line",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "blocks",
      minzoom: 12,
      paint: { "line-color": "#69d5c1", "line-width": 7, "line-opacity": 0.13 },
    },
    {
      id: "platforms",
      type: "circle",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "platforms",
      minzoom: 11,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2, 18, 6],
        "circle-color": "#959ca7",
        "circle-opacity": 0.72,
        "circle-stroke-color": "#c5cbd4",
        "circle-stroke-width": 1,
      },
    },
    {
      id: "facilities",
      type: "line",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "conflict_resources",
      minzoom: 13,
      paint: { "line-color": "#8e98a7", "line-opacity": 0.28, "line-width": 8 },
    },
    {
      id: "switches",
      type: "circle",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "switches",
      minzoom: 13,
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2, 18, 5], "circle-color": "#d8dde4", "circle-stroke-color": "#090b10", "circle-stroke-width": 1 },
    },
    {
      id: "signals",
      type: "circle",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "signals",
      minzoom: 13,
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 18, 5.5], "circle-color": "#090b10", "circle-stroke-color": "#f1f3f7", "circle-stroke-width": 1.5 },
    },
    {
      id: "stations",
      type: "circle",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "stations",
      minzoom: 5,
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 2, 12, 5], "circle-color": "#f1f3f7", "circle-stroke-color": "#11141b", "circle-stroke-width": 2 },
    },
    {
      id: "operating-points",
      type: "circle",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "operating_points",
      minzoom: 9,
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.5, 15, 4], "circle-color": "#aeb7c4", "circle-stroke-color": "#090b10", "circle-stroke-width": 1 },
    },
    {
      id: "rail-context",
      type: "circle",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "rail_context",
      minzoom: 12,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 1.5, 18, 4],
        "circle-color": "#68707c",
        "circle-opacity": 0.55,
        "circle-stroke-color": "#090b10",
        "circle-stroke-width": 1,
      },
    },
    {
      id: "station-labels",
      type: "symbol",
      source: INFRASTRUCTURE_SOURCE_ID,
      "source-layer": "stations",
      minzoom: 7,
      layout: { "text-field": ["coalesce", ["get", "label"], ["get", "name"], ""], "text-font": ["Noto Sans Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 7, 10, 14, 13], "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
      paint: { "text-color": "#d8dde4", "text-halo-color": "#090b10", "text-halo-width": 1.5 },
    },
  ];
}

function hitLayers(): LayerSpecification[] {
  const line = (kind: LivemapObjectKind, minzoom: number): LayerSpecification => ({
    id: `${SOURCE_LAYER_BY_KIND[kind]}-hit`,
    type: "line",
    source: INFRASTRUCTURE_SOURCE_ID,
    "source-layer": SOURCE_LAYER_BY_KIND[kind],
    minzoom,
    paint: { "line-color": "#000000", "line-width": 18, "line-opacity": 0 },
  });
  const circle = (kind: LivemapObjectKind, minzoom: number): LayerSpecification => ({
    id: `${SOURCE_LAYER_BY_KIND[kind]}-hit`,
    type: "circle",
    source: INFRASTRUCTURE_SOURCE_ID,
    "source-layer": SOURCE_LAYER_BY_KIND[kind],
    minzoom,
    paint: { "circle-radius": 18, "circle-opacity": 0 },
  });
  const corridor: LayerSpecification = {
    id: "rail-corridors-hit",
    type: "line",
    source: INFRASTRUCTURE_SOURCE_ID,
    "source-layer": "rail_corridors",
    minzoom: 5,
    maxzoom: 11,
    paint: { "line-color": "#000000", "line-width": 18, "line-opacity": 0 },
  };
  return [corridor, line("track", 8), line("block", 12), line("facility", 13), circle("station", 5), circle("operating-point", 9), circle("platform", 11), circle("switch", 13), circle("signal", 13), circle("rail-context", 12)];
}

export function infrastructureLayers(): readonly LayerSpecification[] {
  return Object.freeze([...lineLayers(), ...semanticLayers(), ...hitLayers()]);
}

export const trainLayers: readonly LayerSpecification[] = Object.freeze([
  {
    id: "train-halo",
    type: "circle",
    source: TRAIN_SOURCE_ID,
    minzoom: 5,
    paint: { "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 12, 0], "circle-color": "#9fb8e8", "circle-opacity": 0.34 },
  },
  {
    id: "train-estimates",
    type: "circle",
    source: TRAIN_SOURCE_ID,
    minzoom: 5,
    filter: ["==", ["get", "positionKind"], "estimated"],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 6.5, 12, 10],
      "circle-color": "#aeb6c3",
      "circle-opacity": 0.08,
      "circle-stroke-color": "#aeb6c3",
      "circle-stroke-opacity": 0.92,
      "circle-stroke-width": 2,
    },
  },
  {
    id: "trains",
    type: "circle",
    source: TRAIN_SOURCE_ID,
    minzoom: 5,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 3.5, 12, 6.5],
      "circle-color": ["match", ["get", "status"], "cancelled", "#ff715f", "waiting", "#f0b75a", ["case", [">", ["get", "delaySeconds"], 900], "#ff715f", [">", ["get", "delaySeconds"], 60], "#f0b75a", "#e4e8ed"]],
      "circle-stroke-color": "#090b10",
      "circle-stroke-width": 2,
    },
  },
  {
    id: "train-estimate-glyphs",
    type: "symbol",
    source: TRAIN_SOURCE_ID,
    minzoom: 5,
    filter: ["==", ["get", "positionKind"], "estimated"],
    layout: {
      "text-field": ["case", ["==", ["get", "estimateMethod"], "anchor-hold"], "?", "\u2248"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 5, 8, 12, 12],
      "text-offset": [0.75, -0.75],
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "#e1e5eb",
      "text-halo-color": "#090b10",
      "text-halo-width": 1,
    },
  },
  {
    id: "train-labels",
    type: "symbol",
    source: TRAIN_SOURCE_ID,
    minzoom: 8,
    layout: { "text-field": ["get", "trainNumber"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0.9, 0], "text-anchor": "left", "text-optional": true },
    paint: { "text-color": "#f1f3f7", "text-halo-color": "#090b10", "text-halo-width": 1.6 },
  },
  {
    id: "train-hit",
    type: "circle",
    source: TRAIN_SOURCE_ID,
    minzoom: 5,
    paint: { "circle-radius": 18, "circle-opacity": 0 },
  },
]);

export function trainFeatureCollection(
  trains: Iterable<PublicTrain>,
  infrastructureReleaseId: string,
): GeoJsonFeatureCollection {
  const features: GeoJsonPointFeature[] = [];
  for (const train of trains) {
    if (train.mapPosition !== undefined && train.mapEstimate !== undefined) continue;
    const projection = train.mapPosition ?? train.mapEstimate;
    if (projection === undefined || projection.infrastructureReleaseId !== infrastructureReleaseId) continue;
    const exact = train.mapPosition;
    const estimate = train.mapEstimate;
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
        operator: train.operator,
        category: train.category,
        status: train.status,
        delaySeconds: train.delaySeconds,
        resourceId: projection.resourceId,
        positionKind: exact === undefined ? "estimated" : "exact",
        bearing: (projection.bearingMilliDegrees ?? 0) / 1_000,
        ...(exact === undefined ? {} : {
          trackId: exact.trackId,
          offsetMm: exact.offsetMm,
        }),
        ...(estimate === undefined ? {} : {
          estimateMethod: estimate.method,
          displayPathId: estimate.displayPathId,
          displayOffsetMm: estimate.displayOffsetMm,
          uncertaintyMm: estimate.uncertaintyMm,
        }),
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
  const labelValue = properties["label"] ?? properties["display_name"] ?? properties["name"] ?? properties["trainNumber"] ?? id;
  return Object.freeze({ kind: kind as MapSelection["kind"], id, label: String(labelValue) });
}

export function sortAndDeduplicateSelections(selections: readonly MapSelection[]): readonly MapSelection[] {
  const unique = new Map<string, MapSelection>();
  selections.forEach((selection) => unique.set(`${selection.kind}:${selection.id}`, selection));
  return Object.freeze([...unique.values()].sort((left, right) =>
    (INTERACTION_PRIORITY[left.kind] ?? 99) - (INTERACTION_PRIORITY[right.kind] ?? 99)
    || left.label.localeCompare(right.label, "de")
    || left.id.localeCompare(right.id),
  ));
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
