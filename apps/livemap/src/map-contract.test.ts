import { describe, expect, it, vi } from "vitest";
import type { LivemapConfigV2, PublicTrain } from "@zugfolge/livemap-stream";

import {
  assertSelfHostedConfig,
  assertSelfHostedStyle,
  infrastructureLayers,
  installMissingBasemapImageResolver,
  installPlayerMapIcons,
  INTERACTION_LAYER_IDS,
  loadSelfHostedStyle,
  parseFocusParameter,
  PLAYER_SIGNAL_ICON_ID,
  PLAYER_STATION_ICON_ID,
  selectionFromFeature,
  sortAndDeduplicateSelections,
  trainFeatureCollection,
  trainLayers,
} from "./map-contract.js";

const config: LivemapConfigV2 = {
  schemaVersion: "zugfolge-livemap-config/v2",
  worldId: "world-1",
  worldName: "Mitteldeutschland",
  infrastructureReleaseId: "infra-2026-de",
  basemap: {
    styleUrl: "/artifacts/world-basemap/style.json",
    attribution: "© OpenStreetMap-Mitwirkende",
    selfHosted: true,
  },
  infrastructure: {
    pmtilesUrl: "/artifacts/germany-infrastructure/germany.pmtiles",
    attribution: "© OpenStreetMap-Mitwirkende",
    coverage: "DE",
  },
  initialView: { latitudeE7: 510_000_000, longitudeE7: 105_000_000, zoomMilli: 6_000 },
};

describe("selbst gehosteter Kartenvertrag", () => {
  it("akzeptiert ausschließlich gleichursprüngliche Basiskarte und Deutschland-Infrastruktur", () => {
    expect(() => assertSelfHostedConfig(config, "https://spiel.example/maps")).not.toThrow();
    expect(() => assertSelfHostedConfig({
      ...config,
      basemap: { ...config.basemap, styleUrl: "https://tile.openstreetmap.org/style.json" },
    }, "https://spiel.example/maps")).toThrow(/nicht auf dem selbst gehosteten Ursprung/);
    expect(() => assertSelfHostedConfig({
      ...config,
      infrastructure: { ...config.infrastructure, coverage: "LHE" as "DE" },
    }, "https://spiel.example/maps")).toThrow(/Gesamtdeutschland/);
  });

  it("prüft auch Quellen, Schriften und Sprites innerhalb des Styles", () => {
    expect(() => assertSelfHostedStyle({
      version: 8,
      sources: { base: { type: "vector", url: "pmtiles:///artifacts/world-basemap/world.pmtiles" } },
      glyphs: "/artifacts/world-basemap/fonts/{fontstack}/{range}.pbf",
      sprite: "/artifacts/world-basemap/sprite",
      layers: [],
    }, "https://spiel.example/maps")).not.toThrow();
    expect(() => assertSelfHostedStyle({
      version: 8,
      sources: { base: { type: "vector", tiles: ["https://tiles.example.net/{z}/{x}/{y}.pbf"] } },
      layers: [],
    }, "https://spiel.example/maps")).toThrow(/nicht auf dem selbst gehosteten Ursprung/);
  });

  it("normalisiert freigegebene Root-Pfade für MapLibre zu absoluten gleichursprünglichen URLs", async () => {
    const fetchImplementation = (() => Promise.resolve(new Response(JSON.stringify({
      version: 8,
      sources: { base: { type: "vector", url: "pmtiles:///artifacts/world.pmtiles" } },
      glyphs: "/artifacts/fonts/{fontstack}/{range}.pbf",
      sprite: "/artifacts/sprites/dark",
      layers: [],
    }), { status: 200, headers: { "content-type": "application/json" } }))) as typeof fetch;

    const style = await loadSelfHostedStyle(
      "/artifacts/style.json",
      "https://spiel.example/live/",
      fetchImplementation,
    );

    expect(style.sprite).toBe("https://spiel.example/artifacts/sprites/dark");
    expect(style.glyphs).toBe("https://spiel.example/artifacts/fonts/{fontstack}/{range}.pbf");
    expect(style.sources["base"]).toMatchObject({
      url: "pmtiles://https://spiel.example/artifacts/world.pmtiles",
    });
  });

  it("ersetzt unbekannte Basiskartenpiktogramme durch das paketierte Gebäudesymbol", () => {
    const images = new Map<string, unknown>([["building", {
      data: { width: 1, height: 1, data: new Uint8Array(4) },
      pixelRatio: 1,
      sdf: false,
    }]]);
    let resolver: ((id: string) => void | Promise<void>) | undefined;
    const currentMap = {
      hasImage: (id: string) => images.has(id),
      getImage: (id: string) => images.get(id),
      addImage: (id: string, image: unknown) => { images.set(id, image); return currentMap; },
      setMissingStyleImageResolver: (next: typeof resolver) => { resolver = next; return currentMap; },
    };

    installMissingBasemapImageResolver(currentMap as never);
    resolver?.("townhall");

    expect(images.has("townhall")).toBe(true);
  });

  it("registriert das neutrale Signalpiktogramm genau einmal lokal", () => {
    const images = new Map<string, unknown>();
    const addImage = vi.fn((id: string, image: unknown) => { images.set(id, image); });
    const currentMap = { hasImage: (id: string) => images.has(id), addImage };
    installPlayerMapIcons(currentMap as never);
    installPlayerMapIcons(currentMap as never);
    expect(addImage).toHaveBeenCalledTimes(2);
    expect(addImage.mock.calls[0]?.[0]).toBe(PLAYER_SIGNAL_ICON_ID);
    expect(addImage.mock.calls[1]?.[0]).toBe(PLAYER_STATION_ICON_ID);
    expect(JSON.stringify(addImage.mock.calls[0]?.[1])).not.toContain("241,183,90");
  });
});

describe("semantische Deutschland-Layer", () => {
  it("zeigt im Spielerprofil nur lebendige und verständliche Kartenobjekte", () => {
    const layers = new Map(infrastructureLayers().map((layer) => [layer.id, layer]));
    expect(layers.get("rail-corridors")?.minzoom).toBe(5);
    expect(layers.get("tracks")?.minzoom).toBe(8);
    const signals = layers.get("signals");
    expect(signals?.type).toBe("symbol");
    expect(signals?.minzoom).toBe(14);
    if (signals?.type !== "symbol") throw new Error("Signale muessen als Symbol gerendert werden.");
    expect(signals.layout?.["icon-image"]).toBe(PLAYER_SIGNAL_ICON_ID);
    const stations = layers.get("stations");
    expect(stations?.type).toBe("symbol");
    if (stations?.type !== "symbol") throw new Error("Bahnhoefe muessen als Symbol gerendert werden.");
    expect(stations.layout?.["icon-image"]).toBe(PLAYER_STATION_ICON_ID);
    expect(JSON.stringify(stations.layout?.["text-field"])).toContain("rl100");
    for (const hidden of ["platforms", "switches", "operating-points", "rail-context", "blocks", "facilities"]) {
      expect(layers.has(hidden), hidden).toBe(false);
    }
    expect(layers.get("rail-corridors-hit")?.type).toBe("line");
    expect(INTERACTION_LAYER_IDS).toEqual(["train-hit", "rail-corridors-hit", "stations"]);
  });

  it("blendet Klasse C aus, ohne betriebliche Störungsmuster zu verlieren", () => {
    const layers = new Map(infrastructureLayers().map((layer) => [layer.id, layer]));
    for (const id of ["rail-corridors", "tracks", "tracks-restriction", "tracks-closure", "tracks-construction-white", "tracks-construction-red", "signals", "rail-corridors-hit"]) {
      const layer = layers.get(id);
      expect(layer).toBeDefined();
      const filter = layer !== undefined && "filter" in layer ? layer.filter : null;
      expect(JSON.stringify(filter)).toContain("quality_class");
      expect(JSON.stringify(filter)).toContain("C");
    }
    for (const id of ["tracks-restriction", "tracks-closure", "tracks-construction-white", "tracks-construction-red"]) {
      expect(JSON.stringify(layers.get(id)?.paint)).toContain("feature-state");
    }
    expect(layers.has("tracks-quality-c")).toBe(false);
  });

  it("bindet jeden eigenen Beschriftungslayer an den paketierten Offline-Fontstack", () => {
    let symbols = 0;
    for (const layer of [...infrastructureLayers(), ...trainLayers]) {
      if (layer.type !== "symbol" || layer.layout?.["text-field"] === undefined) continue;
      symbols += 1;
      expect(layer.layout["text-font"]).toEqual(["Noto Sans Regular"]);
    }
    expect(symbols).toBeGreaterThan(0);
  });
});

describe("Live-Objekte", () => {
  const baseTrain: PublicTrain = {
    id: "train-1",
    operator: "EVU Beispiel",
    trainNumber: "RV 20001",
    category: "RV",
    positionMm: 100,
    speedMmPerSecond: 10,
    delaySeconds: 0,
    nextOperatingPoint: "Leipzig Hbf",
    status: "running",
  };

  it("setzt einen Zug ohne release-gepinnte Kartenposition nicht auf die Karte", () => {
    expect(trainFeatureCollection([baseTrain], config.infrastructureReleaseId).features).toHaveLength(0);
  });

  it("verwendet ausschließlich bestätigte E7-Koordinaten", () => {
    const positioned: PublicTrain = {
      ...baseTrain,
      mapPosition: {
        infrastructureReleaseId: "infra-de-2026",
        resourceId: "block-track-7",
        trackId: "track-7",
        offsetMm: 25_000,
        latitudeE7: 510_000_000,
        longitudeE7: 123_000_000,
        bearingMilliDegrees: 90_000,
      },
    };
    const feature = trainFeatureCollection([positioned], "infra-de-2026").features[0];
    expect(feature?.geometry.coordinates).toEqual([12.3, 51]);
    expect(feature?.properties).toMatchObject({ positionKind: "exact", trackId: "track-7" });
    expect(trainFeatureCollection([positioned], "anderer-release").features).toHaveLength(0);
  });

  it("hält dieselbe anklickbare Zug-ID mit klar markierter Kartenschätzung sichtbar", () => {
    const estimated: PublicTrain = {
      ...baseTrain,
      mapEstimate: {
        infrastructureReleaseId: "infra-de-2026",
        resourceId: "block-track-7",
        method: "route-corridor",
        displayPathId: "corridor-rv-20001",
        displayOffsetMm: 25_000,
        latitudeE7: 510_000_000,
        longitudeE7: 123_000_000,
        bearingMilliDegrees: 90_000,
        uncertaintyMm: 750_000,
      },
    };
    const feature = trainFeatureCollection([estimated], "infra-de-2026").features[0];
    expect(feature).toMatchObject({
      id: "train-1",
      geometry: { coordinates: [12.3, 51] },
      properties: {
        positionKind: "estimated",
        estimateMethod: "route-corridor",
        displayPathId: "corridor-rv-20001",
        uncertaintyMm: 750_000,
      },
    });
    expect(feature?.properties).not.toHaveProperty("trackId");
    expect(trainFeatureCollection([estimated], "anderer-release").features).toHaveLength(0);

    const exact = {
      ...baseTrain,
      mapPosition: {
        infrastructureReleaseId: "infra-de-2026",
        resourceId: "block-track-7",
        trackId: "track-7",
        offsetMm: 25_000,
        latitudeE7: 510_000_000,
        longitudeE7: 123_000_000,
      },
    } satisfies PublicTrain;
    expect(trainFeatureCollection([exact], "infra-de-2026").features[0]?.id).toBe(feature?.id);
  });

  it("stellt Schätzungen neutral statt als Betriebswarnung dar", () => {
    const layers = new Map(trainLayers.map((layer) => [layer.id, layer]));
    const estimateLayer = layers.get("train-estimates");
    expect(estimateLayer?.type).toBe("circle");
    expect(JSON.stringify(estimateLayer !== undefined && "filter" in estimateLayer ? estimateLayer.filter : undefined)).toContain("estimated");
    expect(estimateLayer?.paint).toMatchObject({
      "circle-color": "#aeb6c3",
      "circle-opacity": 0.08,
      "circle-stroke-color": "#aeb6c3",
      "circle-stroke-width": 2,
    });
    expect(JSON.stringify(estimateLayer?.paint)).not.toMatch(/#ff715f|#f0b75a/);
    expect(trainLayers.findIndex((layer) => layer.id === "train-estimates"))
      .toBeLessThan(trainLayers.findIndex((layer) => layer.id === "trains"));
    expect(layers.get("trains")).not.toHaveProperty("filter");
    expect(JSON.stringify(layers.get("trains")?.paint)).toContain("delaySeconds");
    const glyph = layers.get("train-estimate-glyphs");
    expect(glyph?.type).toBe("symbol");
    expect(JSON.stringify(glyph?.layout)).toContain("anchor-hold");
    expect(JSON.stringify(glyph?.layout)).toContain("≈");
    expect(JSON.stringify(glyph?.layout)).toContain("?");
  });

  it("priorisiert Züge und dedupliziert überlagerte Treffer", () => {
    expect(sortAndDeduplicateSelections([
      { kind: "track", id: "t-1", label: "Gleis 1" },
      { kind: "train", id: "z-1", label: "RV 1" },
      { kind: "track", id: "t-1", label: "Gleis 1" },
    ])).toEqual([
      { kind: "train", id: "z-1", label: "RV 1" },
      { kind: "track", id: "t-1", label: "Gleis 1" },
    ]);
    expect(parseFocusParameter("signal:sig-22")).toEqual({ kind: "signal", id: "sig-22", label: "sig-22" });
    expect(parseFocusParameter("unknown:x")).toBeUndefined();
  });

  it("übersetzt einen Streckenklick in eine verständliche amtliche Korridorwahl", () => {
    expect(selectionFromFeature({
      layer: { id: "rail-corridors-hit" },
      properties: {
        feature_id: "rail-corridor:6340:1",
        feature_type: "rail-corridor",
        quality_class: "B",
        route_number: 6340,
        route_name: "Leipzig–Halle",
      },
    })).toEqual({
      kind: "track",
      id: "rail-corridor:6340:1",
      label: "Strecke 6340 · Leipzig–Halle",
      sourceLayer: "rail_corridors",
      groupKey: "track:6340:Leipzig–Halle",
    });
    expect(selectionFromFeature({
      layer: { id: "rail-corridors-hit" },
      properties: { feature_id: "rail-corridor:9999", feature_type: "rail-corridor", quality_class: "C", route_number: 9999 },
    })).toBeUndefined();
    expect(sortAndDeduplicateSelections([
      { kind: "track", id: "direction-b", label: "Strecke 6340 · Leipzig–Halle", groupKey: "track:6340:Leipzig–Halle" },
      { kind: "track", id: "direction-a", label: "Strecke 6340 · Leipzig–Halle", groupKey: "track:6340:Leipzig–Halle" },
    ])).toEqual([{ kind: "track", id: "direction-a", label: "Strecke 6340 · Leipzig–Halle", groupKey: "track:6340:Leipzig–Halle" }]);
  });

  it("öffnet einen markierten Bahnhof mit RIL-100-Bezeichnung und korrektem Source-Layer", () => {
    expect(selectionFromFeature({
      layer: { id: "stations" },
      properties: { feature_id: "station:8010205", feature_type: "station", name: "Leipzig Hbf", rl100: "LL" },
    })).toEqual({
      kind: "station",
      id: "station:8010205",
      label: "Leipzig Hbf · RIL 100 LL",
      sourceLayer: "stations",
      groupKey: "station:LL",
    });
  });
});
