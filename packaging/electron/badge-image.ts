import zlib from "node:zlib";

const DIGITS: Readonly<Record<string, readonly string[]>> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"],
};

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

export function createBadgePngBuffer(count: number): Buffer {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  const setPixel = (
    x: number,
    y: number,
    r: number,
    g: number,
    b: number,
    a = 255,
  ) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const offset = (y * size + x) * 4;
    pixels[offset] = r;
    pixels[offset + 1] = g;
    pixels[offset + 2] = b;
    pixels[offset + 3] = a;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - 15.5, y - 15.5);
      if (distance <= 15) setPixel(x, y, 255, 255, 255);
      if (distance <= 13) setPixel(x, y, 220, 38, 38);
    }
  }

  const label = count > 99 ? "99+" : String(Math.max(1, count));
  const scale = label.length === 1 ? 5 : label.length === 2 ? 4 : 3;
  const glyphWidth = 3 * scale;
  const gap = scale;
  const totalWidth = label.length * glyphWidth + (label.length - 1) * gap;
  const startX = Math.floor((size - totalWidth) / 2);
  const startY = Math.floor((size - 5 * scale) / 2);
  for (const [index, char] of [...label].entries()) {
    const glyph = DIGITS[char];
    // Callers pass an integer count; any other character has no glyph.
    if (glyph === undefined) {
      throw new TypeError(`No badge glyph for ${JSON.stringify(char)}`);
    }
    for (const [row, line] of glyph.entries()) {
      for (const [col, bit] of [...line].entries()) {
        if (bit !== "1") continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            setPixel(
              startX + index * (glyphWidth + gap) + col * scale + dx,
              startY + row * scale + dy,
              255,
              255,
              255,
            );
          }
        }
      }
    }
  }

  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (size * 4 + 1);
    scanlines[rowOffset] = 0;
    pixels.copy(scanlines, rowOffset + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
