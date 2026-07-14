/** Pixel dimensions of an encoded image. */
export interface ImageSize {
  width: number;
  height: number;
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function ascii(b: Uint8Array, at: number, len: number): string {
  return String.fromCharCode(...b.subarray(at, at + len));
}

function startsWith(b: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, i) => b[i] === byte);
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function pngSize(b: Uint8Array): ImageSize | undefined {
  if (b.length < 24 || !startsWith(b, PNG_MAGIC)) return undefined;
  // IHDR is required to be the first chunk: 8-byte magic, 4-byte length, "IHDR", then dims.
  const v = view(b);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** SOF0–SOF15 carry the frame dimensions; C4/C8/CC sit in that range but don't (DHT/JPG/DAC). */
function isSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSize(b: Uint8Array): ImageSize | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  const v = view(b);
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return undefined; // lost the marker boundary
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    // TEM and RST0–7/SOI/EOI stand alone — no length field follows.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const len = v.getUint16(i + 2);
    if (len < 2) return undefined;
    if (isSof(marker)) {
      if (i + 9 > b.length) return undefined;
      // SOFn payload: length(2) precision(1) height(2) width(2)
      return { height: v.getUint16(i + 5), width: v.getUint16(i + 7) };
    }
    i += 2 + len;
  }
  return undefined;
}

function webpSize(b: Uint8Array): ImageSize | undefined {
  if (b.length < 16 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return undefined;
  const v = view(b);
  switch (ascii(b, 12, 4)) {
    case "VP8 ": {
      // Lossy: 3-byte frame tag, 3-byte sync code, then 14-bit width and height.
      if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
      return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
    }
    case "VP8L": {
      // Lossless: 0x2f signature, then 14-bit width-1 and height-1, bit-packed little-endian.
      if (b.length < 25 || b[20] !== 0x2f) return undefined;
      const bits = v.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case "VP8X": {
      // Extended: 4 flag bytes, then 24-bit canvas width-1 and height-1.
      if (b.length < 30) return undefined;
      return {
        width: (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1,
        height: (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1,
      };
    }
  }
  return undefined;
}

function gifSize(b: Uint8Array): ImageSize | undefined {
  if (b.length < 10) return undefined;
  const magic = ascii(b, 0, 6);
  if (magic !== "GIF87a" && magic !== "GIF89a") return undefined;
  const v = view(b);
  return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
}

/**
 * Width/height read straight out of an encoded image's header — enough to size-check an
 * upload without decoding it. Covers what LoadImage realistically gets fed (Telegram
 * re-encodes photos to JPEG; ComfyUI writes PNG). Anything else returns undefined, which
 * callers must treat as "unknown", never as "small enough".
 */
export function imageSize(bytes: Uint8Array): ImageSize | undefined {
  return pngSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes) ?? gifSize(bytes);
}

/**
 * Factor that fits `size` inside a `max`×`max` box with the aspect ratio intact.
 * Never enlarges — anything already inside the box scales by 1.
 */
export function fitScale(size: ImageSize, max: number): number {
  return Math.min(1, max / Math.max(size.width, size.height));
}

/** The size ComfyUI's ImageScaleBy lands on — it rounds each axis independently. */
export function scaledSize(size: ImageSize, scale: number): ImageSize {
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
}
