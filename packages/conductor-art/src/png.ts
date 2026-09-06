import { inflateSync } from "node:zlib";
import { invariant } from "./errors.js";
import type { DecodedArtImage } from "./types.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const MAX_IMAGE_PIXELS = 16_777_216;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left: number, up: number, upperLeft: number): number {
  const predicted = left + up - upperLeft;
  const a = Math.abs(predicted - left), b = Math.abs(predicted - up), c = Math.abs(predicted - upperLeft);
  return a <= b && a <= c ? left : b <= c ? up : upperLeft;
}

/** Liest ausschließlich 8-Bit-PNGs ohne Interlacing; keine Bildbearbeitung oder Ausgabe. */
export function decodeArtPng(input: Uint8Array): DecodedArtImage {
  invariant(input.byteLength <= 64 * 1024 * 1024 && input.byteLength >= 45, "png_size_invalid");
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  invariant(bytes.subarray(0, 8).equals(PNG_SIGNATURE), "png_signature_invalid");
  let offset = 8, width = 0, height = 0, colorType = -1;
  let palette: Buffer | undefined, transparency: Buffer | undefined;
  let header = false, end = false, imageData = false, dataEnded = false;
  const compressed: Buffer[] = [];
  while (offset < bytes.length) {
    invariant(offset + 12 <= bytes.length, "png_chunk_truncated");
    const length = bytes.readUInt32BE(offset);
    invariant(length <= bytes.length - offset - 12, "png_chunk_truncated");
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    invariant(/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type), "png_chunk_type_invalid");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    invariant(crc32(bytes.subarray(offset + 4, offset + 8 + length)) === bytes.readUInt32BE(offset + 8 + length), "png_crc_mismatch");
    invariant(header || type === "IHDR", "png_header_missing");
    if (type === "IHDR") {
      invariant(!header && offset === 8 && length === 13, "png_header_invalid");
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]!;
      invariant(width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= MAX_IMAGE_PIXELS, "png_dimensions_invalid");
      invariant(data[8] === 8 && [0, 2, 3, 4, 6].includes(colorType) && data[10] === 0 && data[11] === 0 && data[12] === 0, "png_encoding_unsupported");
      header = true;
    } else if (type === "PLTE") {
      invariant(!palette && !imageData && length >= 3 && length <= 768 && length % 3 === 0 && colorType !== 0 && colorType !== 4, "png_palette_invalid");
      palette = data;
    } else if (type === "tRNS") {
      invariant(!transparency && !imageData && ([0, 2, 3].includes(colorType)), "png_transparency_invalid");
      invariant((colorType === 0 && length === 2) || (colorType === 2 && length === 6) || (colorType === 3 && !!palette && length > 0 && length <= palette.length / 3), "png_transparency_invalid");
      transparency = data;
    } else if (type === "IDAT") {
      invariant(!dataEnded && (colorType !== 3 || !!palette), "png_data_order_invalid");
      imageData = true; compressed.push(data);
    } else if (type === "IEND") {
      invariant(imageData && length === 0 && offset + 12 === bytes.length, "png_end_invalid");
      end = true;
    } else {
      invariant(type[0] === type[0]!.toLowerCase() && type !== "acTL" && type !== "fcTL" && type !== "fdAT", "png_critical_chunk_unsupported");
      if (imageData) dataEnded = true;
    }
    offset += length + 12;
  }
  invariant(header && end && imageData, "png_incomplete");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const stride = width * channels;
  const expected = (stride + 1) * height;
  let inflated: Buffer;
  try { inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected }); }
  catch { invariant(false, "png_deflate_invalid"); }
  invariant(inflated.length === expected, "png_scanline_length_invalid");
  const unfiltered = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)]!;
    invariant(filter <= 4, "png_filter_invalid");
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x >= channels ? unfiltered[at - channels]! : 0;
      const up = y > 0 ? unfiltered[at - stride]! : 0;
      const upperLeft = y > 0 && x >= channels ? unfiltered[at - stride - channels]! : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
      unfiltered[at] = (inflated[y * (stride + 1) + x + 1]! + predictor) & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const at = pixel * channels, out = pixel * 4;
    if (colorType === 3) {
      const index = unfiltered[at]!;
      invariant(palette && index * 3 + 2 < palette.length, "png_palette_index_invalid");
      rgba[out] = palette[index * 3]!; rgba[out + 1] = palette[index * 3 + 1]!; rgba[out + 2] = palette[index * 3 + 2]!;
      rgba[out + 3] = transparency?.[index] ?? 255;
    } else if (colorType === 0 || colorType === 4) {
      const grey = unfiltered[at]!;
      rgba[out] = grey; rgba[out + 1] = grey; rgba[out + 2] = grey;
      rgba[out + 3] = colorType === 4 ? unfiltered[at + 1]! : transparency?.readUInt16BE(0) === grey ? 0 : 255;
    } else {
      rgba[out] = unfiltered[at]!; rgba[out + 1] = unfiltered[at + 1]!; rgba[out + 2] = unfiltered[at + 2]!;
      const transparent = transparency && transparency.readUInt16BE(0) === rgba[out] && transparency.readUInt16BE(2) === rgba[out + 1] && transparency.readUInt16BE(4) === rgba[out + 2];
      rgba[out + 3] = colorType === 6 ? unfiltered[at + 3]! : transparent ? 0 : 255;
    }
  }
  return { width, height, rgba };
}
