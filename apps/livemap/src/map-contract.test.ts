import { describe, expect, it } from "vitest";
import type { LivemapConfigV1, PublicTrain } from "@zugfolge/livemap-stream";

import {
  assertSelfHostedConfig,
  assertSelfHostedStyle,
  infrastructureLayers,
  installMissingBasemapImageResolver,
  loadSelfHostedStyle,
  parseFocusParameter,
  sortAndDeduplicateSelections,
  trainFeatureCollection,
  trainLayers,
} from "./map-contract.js";

const config: LivemapConfigV1 = {
  schemaVersion: "zugfolge-livemap-config/v1",
  worldId: "world-1",
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
});

describe("semantische Deutschland-Layer", () => {
  it("zeigt Korridore früh und Signale/Weichen erst im Detailzoom", () => {
    const layers = new Map(infrastructureLayers().map((layer) => [layer.id, layer]));
    expect(layers.get("rail-corridors")?.minzoom).toBe(5);
    expect(layers.get("tracks")?.minzoom).toBe(8);
    expect(layers.get("platforms")?.minzoom).toBe(11);
    expect(layers.get("signals")?.minzoom).toBe(13);
    expect(layers.get("switches")?.minzoom).toBe(13);
    expect(layers.get("rail-context")?.minzoom).toBe(12);
    expect(layers.get("rail-corridors-hit")?.type).toBe("line");
    expect(layers.get("tracks-hit")?.type).toBe("line");
    expect(layers.get("rail_context-hit")?.type).toBe("circle");
  });

  it("kodiert Störung, Sperrung, Bauarbeiten und Klasse C zusätzlich über Muster", () => {
    const layers = new Map(infrastructureLayers().map((layer) => [layer.id, layer]));
    for (const id of ["tracks-restriction", "tracks-closure", "tracks-construction-white", "tracks-construction-red"]) {
      const layer = layers.get(id);
      expect(layer).toBeDefined();
      const filter = layer !== undefined && "filter" in layer ? layer.filter : null;
      expect(JSON.stringify(filter)).not.toContain("feature-state");
      expect(JSON.stringify(layer?.paint)).toContain("feature-state");
    }
    expect(layers.get("tracks-quality-c")).toBeDefined();
  });

  it("bindet jeden eigenen Beschriftungslayer an den paketierten Offline-Fontstack", () => {
    const symbols = [...infrastructureLayers(), ...trainLayers].filter((layer) => layer.type === "symbol");
    expect(symbols.length).toBeGreaterThan(0);
    for (const layer of symbols) expect(layer.layout?.["text-font"]).toEqual(["Noto Sans Regular"]);
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
});
