import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";

/** Ausschließlich synthetischer Browserlastfall, kein freigegebener Infrastruktur-Release. */
export interface DemandMapFixtureStation {
  readonly id: string;
  readonly label: string;
  readonly longitudeE7: number;
  readonly latitudeE7: number;
}

export interface DemandMapFixture {
  readonly archive: Buffer;
  readonly stations: readonly DemandMapFixtureStation[];
  readonly counts: {
    readonly germanyStations: number;
    readonly denseNodeStations: number;
    readonly stations: number;
    readonly trackSegments: number;
    readonly tiles: number;
    readonly archiveBytes: number;
  };
}

const requireLivemap = createRequire(new URL("../../livemap/package.json", import.meta.url));
const { zxyToTileId } = requireLivemap("pmtiles") as {
  zxyToTileId: (zoom: number, x: number, y: number) => number;
};
const EXTENT = 4096;
const HEADER_SIZE = 127;
const LAYERS = ["stations", "tracks", "rail_corridors", "platforms", "switches", "signals", "blocks", "conflict_resources", "operating_points", "rail_context"] as const;

function varint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Ungültiger synthetischer Protobuf-Wert.");
  const bytes: number[] = [];
  while (value >= 128) {
    bytes.push(value % 128 + 128);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function numberField(field: number, value: number): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

function bytesField(field: number, value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
}

function zigzag(value: number): number {
  return value < 0 ? -value * 2 - 1 : value * 2;
}

/** Nur Kartenprojektion: Gleitkommazahlen gelangen nicht in einen Simulationszustand. */
function mercator(longitudeE7: number, latitudeE7: number, zoom: number): readonly [number, number] {
  const latitude = latitudeE7 / 10_000_000 * Math.PI / 180;
  const scale = 2 ** zoom;
  return [(longitudeE7 / 10_000_000 + 180) / 360 * scale,
    (1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) / 2 * scale];
}

interface TileFeature {
  readonly station: DemandMapFixtureStation;
  readonly featureNumber: number;
  readonly point: readonly [number, number];
  readonly lineEnd: readonly [number, number];
}

interface Tile {
  readonly id: number;
  readonly zoom: number;
  readonly features: TileFeature[];
}

function encodeLayer(name: string, features: readonly TileFeature[]): Buffer {
  const keys = ["feature_id", "feature_type", "object_id", "quality_class", "name", "route_number", "route_name"];
  const values: string[] = [];
  const valueIndices = new Map<string, number>();
  const valueIndex = (value: string): number => {
    const existing = valueIndices.get(value);
    if (existing !== undefined) return existing;
    const index = values.length;
    values.push(value);
    valueIndices.set(value, index);
    return index;
  };
  const isStation = name === "stations";
  const parts = [bytesField(1, name)];
  for (const feature of features) {
    const id = isStation ? feature.station.id : `synthetic-track-${feature.featureNumber}`;
    const properties = [id, isStation ? "station" : "track", id, "B", feature.station.label,
      `S${Math.floor(feature.featureNumber / 100)}`, "Synthetischer Testkorridor"];
    const tags = properties.flatMap((value, index) => [index, valueIndex(value)]);
    const [x, y] = feature.point;
    const geometry = isStation ? [9, zigzag(x), zigzag(y)]
      : [9, zigzag(x), zigzag(y), 10, zigzag(feature.lineEnd[0] - x), zigzag(feature.lineEnd[1] - y)];
    parts.push(bytesField(2, Buffer.concat([
      numberField(1, feature.featureNumber + 1),
      bytesField(2, Buffer.concat(tags.map(varint))),
      numberField(3, isStation ? 1 : 2),
      bytesField(4, Buffer.concat(geometry.map(varint))),
    ])));
  }
  parts.push(...keys.map((key) => bytesField(3, key)));
  parts.push(...values.map((value) => bytesField(4, bytesField(1, value))));
  parts.push(numberField(5, EXTENT), numberField(15, 2));
  return bytesField(3, Buffer.concat(parts));
}

function encodeTile(tile: Tile): Buffer {
  return gzipSync(Buffer.concat(LAYERS.map((layer) => encodeLayer(layer,
    layer === "stations" || layer === "tracks" || layer === "rail_corridors" ? tile.features : [],
  ))), { level: 6 });
}

/** PMTiles-v3-Wurzelindex, Hilbert-sortiert und ohne Blattverzeichnisse. */
function encodeDirectory(tiles: readonly { readonly id: number; readonly bytes: Buffer }[]): Buffer {
  let previousId = 0;
  const ids = tiles.map((tile) => {
    const delta = tile.id - previousId;
    previousId = tile.id;
    return varint(delta);
  });
  return Buffer.concat([
    varint(tiles.length), ...ids,
    ...tiles.map(() => varint(1)),
    ...tiles.map((tile) => varint(tile.bytes.length)),
    ...tiles.map((_, index) => varint(index === 0 ? 1 : 0)),
  ]);
}

/**
 * 5.000 gleichmäßig verteilte Testpunkte in Deutschland und 400 weitere um Leipzig.
 * Deutschland ist auf Zoom 3–6 enthalten; Zoom 7–14 enthält gezielt den dichten Knoten.
 * Alle Fachobjekte und Gleise sind erfunden; das Archiv prüft Rendering/Interaktion,
 * weder die Produktionsgeographie noch die Vollständigkeit eines InfraRelease.
 */
export function createDemandMapFixture(): DemandMapFixture {
  const stations: DemandMapFixtureStation[] = [];
  for (let index = 0; index < 5000; index += 1) {
    stations.push({
      id: `synthetic-station-${String(index).padStart(5, "0")}`,
      label: `Synthetischer Bahnhof ${index + 1}`,
      longitudeE7: 62_000_000 + index % 100 * 860_000,
      latitudeE7: 474_000_000 + Math.floor(index / 100) * 1_530_000,
    });
  }
  for (let index = 0; index < 400; index += 1) {
    stations.push({
      id: `synthetic-leipzig-${String(index).padStart(3, "0")}`,
      label: `Synthetischer Knotenhalt ${index + 1}`,
      longitudeE7: 123_731_000 + (index % 20 - 10) * 20_000,
      latitudeE7: 513_397_000 + (Math.floor(index / 20) - 10) * 12_000,
    });
  }
  const tiles = new Map<number, Tile>();
  for (let zoom = 3; zoom <= 14; zoom += 1) {
    for (let index = 0; index < stations.length; index += 1) {
      if (zoom > 6 && index < 5000) continue;
      const station = stations[index]!;
      const [projectedX, projectedY] = mercator(station.longitudeE7, station.latitudeE7, zoom);
      const x = Math.floor(projectedX);
      const y = Math.floor(projectedY);
      const id = zxyToTileId(zoom, x, y);
      let tile = tiles.get(id);
      if (tile === undefined) {
        tile = { id, zoom, features: [] };
        tiles.set(id, tile);
      }
      const [endX, endY] = mercator(station.longitudeE7 + (index < 5000 ? 700_000 : 15_000), station.latitudeE7, zoom);
      tile.features.push({ station, featureNumber: index,
        point: [Math.round((projectedX - x) * EXTENT), Math.round((projectedY - y) * EXTENT)],
        lineEnd: [Math.round((endX - x) * EXTENT), Math.round((endY - y) * EXTENT)],
      });
    }
  }
  const entries = [...tiles.values()].sort((left, right) => left.id - right.id)
    .map((tile) => ({ id: tile.id, bytes: encodeTile(tile) }));
  const directory = encodeDirectory(entries);
  if (HEADER_SIZE + directory.length > 16_384) throw new Error("Synthetisches PMTiles-Wurzelverzeichnis überschreitet den ersten Leseblock.");
  const metadata = Buffer.from(JSON.stringify({
    name: "Explizit synthetischer M10-Kartenlastfall",
    description: "5.000 synthetische Deutschlandpunkte und 400 synthetische Knotenpunkte; keine Produktionsgeographie.",
    format: "pbf", minzoom: 3, maxzoom: 14,
    vector_layers: LAYERS.map((id) => ({ id, minzoom: 3, maxzoom: 14,
      fields: { feature_id: "String", feature_type: "String", object_id: "String", quality_class: "String", name: "String", route_number: "String", route_name: "String" },
    })),
  }), "utf8");
  const tileData = Buffer.concat(entries.map((entry) => entry.bytes));
  const header = Buffer.alloc(HEADER_SIZE);
  header.write("PMTiles", 0, "ascii");
  header[7] = 3;
  const metadataOffset = HEADER_SIZE + directory.length;
  const tileDataOffset = metadataOffset + metadata.length;
  for (const [offset, value] of [
    [8, HEADER_SIZE], [16, directory.length], [24, metadataOffset], [32, metadata.length],
    [40, tileDataOffset], [48, 0], [56, tileDataOffset], [64, tileData.length],
    [72, entries.length], [80, entries.length], [88, entries.length],
  ] as const) header.writeBigUInt64LE(BigInt(value), offset);
  header[96] = 1;
  header[97] = 1; // Unkomprimiertes Verzeichnis und Metadaten.
  header[98] = 2; // Gzip-komprimierte MVT-Kacheln.
  header[99] = 1; // MVT.
  header[100] = 3;
  header[101] = 14;
  header.writeInt32LE(60_000_000, 102);
  header.writeInt32LE(470_000_000, 106);
  header.writeInt32LE(150_000_000, 110);
  header.writeInt32LE(551_000_000, 114);
  header[118] = 5;
  header.writeInt32LE(105_000_000, 119);
  header.writeInt32LE(510_000_000, 123);
  const archive = Buffer.concat([header, directory, metadata, tileData]);
  return {
    archive, stations,
    counts: { germanyStations: 5000, denseNodeStations: 400, stations: stations.length,
      trackSegments: stations.length, tiles: entries.length, archiveBytes: archive.length },
  };
}
