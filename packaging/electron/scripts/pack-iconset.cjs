"use strict";

const fs = require("fs");
const path = require("path");

const [iconsetDir, outputPath] = process.argv.slice(2);
if (!iconsetDir || !outputPath) {
  console.error(
    "Usage: node scripts/pack-iconset.cjs <iconset-dir> <output.icns>",
  );
  process.exit(2);
}

// Modern ICNS PNG representations. The same pixel size appears twice where
// macOS distinguishes a 1x representation from the next smaller 2x one.
const representations = [
  ["ic11", "icon_16x16@2x.png", 32],
  ["ic12", "icon_32x32@2x.png", 64],
  ["ic07", "icon_128x128.png", 128],
  ["ic13", "icon_128x128@2x.png", 256],
  ["ic08", "icon_256x256.png", 256],
  ["ic14", "icon_256x256@2x.png", 512],
  ["ic09", "icon_512x512.png", 512],
  ["ic10", "icon_512x512@2x.png", 1024],
];

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const chunks = representations.map(([type, file, expectedSize]) => {
  const png = fs.readFileSync(path.join(iconsetDir, file));
  if (!png.subarray(0, 8).equals(pngSignature)) {
    throw new Error(`${file} is not a PNG`);
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(
      `${file} is ${width}x${height}; expected ${expectedSize}x${expectedSize}`,
    );
  }
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32BE(header.length + png.length, 4);
  return Buffer.concat([header, png]);
});

const totalLength = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
const header = Buffer.alloc(8);
header.write("icns", 0, 4, "ascii");
header.writeUInt32BE(totalLength, 4);
fs.writeFileSync(outputPath, Buffer.concat([header, ...chunks]));
