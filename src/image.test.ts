import { test, expect } from "bun:test";
import { fitScale, imageSize, scaledSize } from "./image.ts";

function bytes(...parts: (number[] | string)[]): Uint8Array {
  const flat: number[] = [];
  for (const p of parts) {
    if (typeof p === "string") for (const ch of p) flat.push(ch.charCodeAt(0));
    else flat.push(...p);
  }
  return new Uint8Array(flat);
}

/** Big-endian uint32/uint16 as byte arrays, for hand-built headers. */
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];

const png = (w: number, h: number) =>
  bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], be32(13), "IHDR", be32(w), be32(h), [8, 6, 0, 0, 0]);

/** JPEG with an APP0 segment ahead of the SOF0, as every real encoder emits. */
const jpeg = (w: number, h: number) =>
  bytes(
    [0xff, 0xd8],
    [0xff, 0xe0],
    be16(16),
    "JFIF",
    [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    [0xff, 0xc0],
    be16(17),
    [8],
    be16(h),
    be16(w),
    [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
  );

test("imageSize reads PNG dimensions", () => {
  expect(imageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
});

test("imageSize reads JPEG dimensions past leading segments", () => {
  expect(imageSize(jpeg(4000, 3000))).toEqual({ width: 4000, height: 3000 });
});

test("imageSize reads progressive JPEG (SOF2)", () => {
  const b = jpeg(800, 600);
  b[22] = 0xc2; // SOF0 -> SOF2
  expect(imageSize(b)).toEqual({ width: 800, height: 600 });
});

test("imageSize reads lossy WebP", () => {
  const b = bytes(
    "RIFF",
    be32(0),
    "WEBP",
    "VP8 ",
    be32(0),
    [0, 0, 0],
    [0x9d, 0x01, 0x2a],
    le16(1024),
    le16(768),
  );
  expect(imageSize(b)).toEqual({ width: 1024, height: 768 });
});

test("imageSize reads lossless WebP", () => {
  // 14-bit (width-1) then 14-bit (height-1), packed little-endian.
  const packed = (640 - 1) | ((480 - 1) << 14);
  const b = bytes("RIFF", be32(0), "WEBP", "VP8L", be32(0), [0x2f], [
    packed & 0xff,
    (packed >>> 8) & 0xff,
    (packed >>> 16) & 0xff,
    (packed >>> 24) & 0xff,
  ]);
  expect(imageSize(b)).toEqual({ width: 640, height: 480 });
});

test("imageSize reads extended WebP", () => {
  const b = bytes("RIFF", be32(0), "WEBP", "VP8X", be32(0), [0, 0, 0, 0], [0xff, 0x0b, 0], [0xbf, 0x02, 0]);
  expect(imageSize(b)).toEqual({ width: 3072, height: 704 });
});

test("imageSize reads GIF", () => {
  expect(imageSize(bytes("GIF89a", le16(500), le16(400), [0, 0, 0]))).toEqual({
    width: 500,
    height: 400,
  });
});

test("imageSize returns undefined for unknown or truncated data", () => {
  expect(imageSize(bytes("not an image at all"))).toBeUndefined();
  expect(imageSize(new Uint8Array(0))).toBeUndefined();
  expect(imageSize(png(100, 100).subarray(0, 20))).toBeUndefined();
  // JPEG magic but the SOF never arrives.
  expect(imageSize(bytes([0xff, 0xd8], [0xff, 0xe0], be16(4), [0, 0]))).toBeUndefined();
});

test("fitScale shrinks by the longest side and never enlarges", () => {
  expect(fitScale({ width: 3840, height: 2160 }, 960)).toBeCloseTo(0.25);
  expect(fitScale({ width: 2160, height: 3840 }, 960)).toBeCloseTo(0.25);
  expect(fitScale({ width: 960, height: 960 }, 960)).toBe(1);
  expect(fitScale({ width: 320, height: 200 }, 960)).toBe(1);
});

test("fitting to 3840/upscale_by keeps the result inside 4K at any multiplier", () => {
  const sources: [number, number][] = [
    [4000, 3000],
    [8000, 1000],
    [1001, 1001],
    [961, 12],
    [12000, 9000],
    [3, 7000],
    [640, 480],
  ];
  for (const by of [1, 1.5, 2, 3, 4]) {
    for (const [width, height] of sources) {
      const fitted = scaledSize({ width, height }, fitScale({ width, height }, Math.floor(3840 / by)));
      const out = scaledSize(fitted, by);
      expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(3840);
    }
  }
});

test("scaledSize preserves aspect ratio", () => {
  const src = { width: 4000, height: 3000 };
  expect(scaledSize(src, fitScale(src, 960))).toEqual({ width: 960, height: 720 });
});

test("scaledSize leaves a small source untouched", () => {
  const src = { width: 640, height: 481 };
  expect(scaledSize(src, fitScale(src, 960))).toEqual(src);
});
