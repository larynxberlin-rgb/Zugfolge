import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const MUTABLE_TOKEN = /(?:^|[./_:@-])(latest|unversioned|main|master|head)(?:$|[./_:@-])/iu;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertLocalUrl(value, label, prefix) {
  invariant(
    typeof value === "string"
      && value.trim() === value
      && !/[\\\u0000-\u001f\u007f]/u.test(value),
    `${label} besitzt keinen portablen lokalen Laufzeitpfad.`,
  );
  if (prefix === "pmtiles:///") {
    invariant(/^pmtiles:\/\/\/(?!\/)[^?#\s]+$/iu.test(value), `${label} muss unter ${prefix} selbst gehostet werden.`);
  } else {
    invariant(/^\/(?!\/)[^?#\s]+$/u.test(value), `${label} muss unter ${prefix} selbst gehostet werden.`);
  }
  invariant(!MUTABLE_TOKEN.test(value), `${label} darf keinen veränderlichen latest-, main-, master- oder HEAD-Pfad verwenden.`);
}

function isExternalRuntimeUrl(value) {
  if (/^pmtiles:\/\/\/(?!\/)/iu.test(value) || /^\/(?!\/)/u.test(value)) return false;
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(value);
}

function externalUrls(value, path = "$") {
  if (typeof value === "string") return isExternalRuntimeUrl(value) ? [{ path, value }] : [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => externalUrls(entry, `${path}[${index}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => externalUrls(entry, `${path}.${key}`));
  }
  return [];
}

export function buildOfflineBasemapStyle(upstream, options) {
  invariant(upstream?.version === 8, "Die Basemap-Vorlage muss ein MapLibre-Style-v8-Dokument sein.");
  invariant(upstream.sources !== null && typeof upstream.sources === "object", "Die Basemap-Vorlage enthält keine Quellen.");
  const sourceIds = Object.keys(upstream.sources);
  invariant(sourceIds.length === 1, "Die Basemap-Vorlage muss genau eine Vektorquelle besitzen.");
  const upstreamSourceId = sourceIds[0];
  invariant(upstream.sources[upstreamSourceId]?.type === "vector", "Die Basemap-Vorlage verwendet keine Vektorquelle.");
  invariant(Array.isArray(upstream.layers) && upstream.layers.length > 0, "Die Basemap-Vorlage enthält keine Layer.");

  invariant(
    typeof options?.releaseId === "string"
      && /^[a-z0-9][a-z0-9.-]+$/u.test(options.releaseId)
      && !MUTABLE_TOKEN.test(options.releaseId),
    "Ungültige oder veränderliche Kartenrelease-ID.",
  );
  assertLocalUrl(options.basemapUrl, "Basemap", "pmtiles:///");
  assertLocalUrl(options.glyphsUrl, "Schriftdateien", "/");
  assertLocalUrl(options.spriteUrl, "Sprites", "/");
  invariant(Number.isInteger(options.maxZoom) && options.maxZoom >= 0 && options.maxZoom <= 24, "Ungültiger Basemap-Maximalzoom.");

  const style = clone(upstream);
  style.name = `Zugfolge Weltkarte dunkel ${options.releaseId}`;
  style.sources = {
    basemap: {
      type: "vector",
      url: options.basemapUrl,
      minzoom: 0,
      maxzoom: options.maxZoom,
      attribution: options.attribution,
    },
  };
  style.glyphs = options.glyphsUrl;
  style.sprite = options.spriteUrl;
  style.layers = style.layers.map((layer) => {
    if (layer.source === undefined) return layer;
    invariant(layer.source === upstreamSourceId, `Layer ${layer.id ?? "<ohne ID>"} referenziert eine unbekannte Vorlagequelle.`);
    return { ...layer, source: "basemap" };
  });
  style.metadata = {
    ...(style.metadata ?? {}),
    "zugfolge:release_id": options.releaseId,
    "zugfolge:self_hosted": true,
    "zugfolge:runtime_external_sources": 0,
    "zugfolge:coverage": "world-z0-10,germany-z11-15",
  };

  const remainingExternal = externalUrls(style);
  invariant(remainingExternal.length === 0, `Offline-Stil enthält externe URLs: ${remainingExternal.map(({ path }) => path).join(", ")}.`);
  return {
    style,
    styleHash: createHash("sha256").update(canonical(style)).digest("hex"),
  };
}

export function serializeOfflineBasemapStyle(style) {
  return `${JSON.stringify(style, null, 2)}\n`;
}

export async function materializeOfflineBasemapStyle(upstream, options, outputPath) {
  const result = buildOfflineBasemapStyle(upstream, options);
  const output = resolve(outputPath);
  const outputDirectory = dirname(output);
  await mkdir(outputDirectory, { recursive: true });
  const temporary = join(
    outputDirectory,
    `.${basename(output)}.building-${process.pid}-${randomUUID()}`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serializeOfflineBasemapStyle(result.style), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, output);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
  return Object.freeze({
    layers: result.style.layers.length,
    output,
    styleHash: result.styleHash,
  });
}
