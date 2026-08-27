"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
const main = read("main.js");

test("desktop boot and recovery shells inherit the Vision palette", () => {
  assert.match(main, /const DEFAULT_BRAND_PRIMARY = ["']158 64% 52%["']/);
  assert.match(
    main,
    /deriveSplashPalette\(\s*theme\?\.background \|\| DEFAULT_BRAND_PRIMARY,?\s*\)/,
  );
  assert.match(main, /paletteBase: palette\.base/);
  assert.match(main, /paletteGlow: palette\.glow/);
  assert.match(main, /paletteForeground: palette\.foreground/);
  assert.match(main, /<svg class="mark"/);

  const css = read("assets/error.css");
  const html = read("assets/error.html");
  const script = read("assets/error.js");
  assert.doesNotMatch(css, /#5b8cff|#2c5cff|#0f172a|#94a3b8|#e2e8f0|#f8fafc/i);
  assert.match(css, /--champagne: 43 71% 66%/);
  assert.match(html, /<svg class="mark"/);
  assert.match(script, /hslComponents/);
  assert.match(script, /--theme-(?:base|glow|foreground)/);
});

test("package versions and native identity links remain aligned", () => {
  const versions = [
    JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
      .version,
    JSON.parse(
      fs.readFileSync(path.join(root, "apps/frontend/package.json"), "utf8"),
    ).version,
    JSON.parse(read("package.json")).version,
  ];
  assert.equal(new Set(versions).size, 1);
  assert.match(main, /app\.setAboutPanelOptions\(/);
  assert.match(main, /label: t\(["']menu\.sourceCode["']\)/);
  assert.match(main, /label: t\(["']menu\.documentation["']\)/);
  assert.match(
    main,
    /const TRUSTED_EXTERNAL_URLS = new Set\(\[REPOSITORY_URL, DOCUMENTATION_URL\]\)/,
  );
  assert.match(main, /if \(!TRUSTED_EXTERNAL_URLS\.has\(url\)\) return false/);
  assert.match(
    main,
    /setWindowOpenHandler\(\(\{ url \}\) => \{\s*openTrustedExternalUrl\(url\);\s*return \{ action: ["']deny["'] \}/,
  );
  assert.match(main, /openTrustedExternalUrl\(REPOSITORY_URL\)/);
  assert.match(main, /openTrustedExternalUrl\(DOCUMENTATION_URL\)/);
});

test("Vision Demo uses a valid, distinct badged macOS icon", () => {
  const config = JSON.parse(read("electron-builder-demo.json"));
  assert.equal(config.mac.icon, "resources-demo/icon-demo.icns");
  assert.notEqual(config.mac.icon, "build/icon.icns");
  const svg = read("resources-demo/icon-demo.svg");
  assert.match(svg, />DEMO<\/text>/);

  const icon = fs.readFileSync(
    path.join(__dirname, "resources-demo/icon-demo.icns"),
  );
  const productionIcon = fs.readFileSync(
    path.join(__dirname, "build/icon.icns"),
  );
  assert.notDeepEqual(icon, productionIcon);
  assert.equal(icon.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(icon.readUInt32BE(4), icon.length);
  const chunkTypes = [];
  for (let offset = 8; offset + 8 <= icon.length;) {
    const size = icon.readUInt32BE(offset + 4);
    assert.ok(size >= 8);
    chunkTypes.push(icon.subarray(offset, offset + 4).toString("ascii"));
    offset += size;
  }
  assert.deepEqual(chunkTypes, [
    "ic11",
    "ic12",
    "ic07",
    "ic13",
    "ic08",
    "ic14",
    "ic09",
    "ic10",
  ]);
});
