import { deflateSync } from "node:zlib";

const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];

export function createSuDuoIco() {
  const images = ICON_SIZES.map((size) => ({ size, png: createPng(size) }));
  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = headerSize;
  for (const [index, image] of images.entries()) {
    const entry = 6 + index * 16;
    header[entry] = image.size === 256 ? 0 : image.size;
    header[entry + 1] = image.size === 256 ? 0 : image.size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
  }
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

function createPng(size) {
  const supersample = 4;
  const highSize = size * supersample;
  const high = Buffer.alloc(highSize * highSize * 4);
  for (let y = 0; y < highSize; y += 1) {
    for (let x = 0; x < highSize; x += 1) {
      const px = ((x + 0.5) / highSize) * 256;
      const py = ((y + 0.5) / highSize) * 256;
      const color = pixel(px, py);
      const index = (y * highSize + x) * 4;
      high[index] = color[0];
      high[index + 1] = color[1];
      high[index + 2] = color[2];
      high[index + 3] = color[3];
    }
  }
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sums = [0, 0, 0, 0];
      for (let dy = 0; dy < supersample; dy += 1) {
        for (let dx = 0; dx < supersample; dx += 1) {
          const source =
            ((y * supersample + dy) * highSize + x * supersample + dx) * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            sums[channel] += high[source + channel];
          }
        }
      }
      const target = (y * size + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        rgba[target + channel] = Math.round(
          sums[channel] / (supersample * supersample),
        );
      }
    }
  }
  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const target = y * (size * 4 + 1);
    scanlines[target] = 0;
    rgba.copy(scanlines, target + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pixel(x, y) {
  if (!insideRoundedRect(x, y, 12, 12, 244, 244, 54)) {
    return [0, 0, 0, 0];
  }
  const progress = Math.max(0, Math.min(1, (x + y - 36) / 430));
  const background = mix([24, 54, 111], [11, 16, 32], progress);
  const border =
    !insideRoundedRect(x, y, 15, 15, 241, 241, 51) &&
    insideRoundedRect(x, y, 12, 12, 244, 244, 54);
  if (border) {
    return [71, 126, 220, 190];
  }
  // 与 web/public/favicon.svg 同一套几何：左边白色 S，右边渐变 D。
  // S：上横、左半圆、中间短横、右半圆、下横，笔画宽 24。
  const s =
    insideRect(x, y, 83, 65, 125, 89) ||
    (x <= 83 && Math.abs(Math.hypot(x - 83, y - 103) - 26) <= 12) ||
    insideRect(x, y, 83, 117, 87, 141) ||
    (x >= 87 && Math.abs(Math.hypot(x - 87, y - 155) - 26) <= 12) ||
    insideRect(x, y, 45, 169, 87, 193);
  if (s) {
    return [244, 248, 255, 255];
  }
  const d =
    insideHalfEllipse(x, y, 141, 65, 193, 167, 44) &&
    !insideHalfEllipse(x, y, 165, 89, 169, 167, 20);
  if (d) {
    const accent = Math.max(0, Math.min(1, (y - 65) / 128));
    return [...mix([117, 167, 255], [85, 224, 193], accent), 255];
  }
  return [...background, 255];
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  const centerX = Math.max(left + radius, Math.min(right - radius, x));
  const centerY = Math.max(top + radius, Math.min(bottom - radius, y));
  return (x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2;
}

function insideRect(x, y, left, top, right, bottom) {
  return x >= left && x <= right && y >= top && y <= bottom;
}

/** 竖直的「D」形：left 到 flatRight 是矩形，右边接半个椭圆（横半轴 radiusX，竖半轴为高度一半）。 */
function insideHalfEllipse(x, y, left, top, bottom, flatRight, radiusX) {
  if (y < top || y > bottom || x < left) return false;
  if (x <= flatRight) return true;
  const radiusY = (bottom - top) / 2;
  return ((x - flatRight) / radiusX) ** 2 + ((y - (top + radiusY)) / radiusY) ** 2 <= 1;
}

function mix(left, right, ratio) {
  return left.map((value, index) =>
    Math.round(value + (right[index] - value) * ratio),
  );
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
