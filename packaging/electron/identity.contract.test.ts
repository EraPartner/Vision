import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { appRoot } from "./paths";
import { isRecord, parseJson, parseJsonAs } from "./test-support";

// Compiled into out/: sources and packaging files are read from the package root.
const root = path.resolve(appRoot, "..", "..");
const read = (file: string) =>
  fs.readFileSync(path.join(appRoot, file), "utf8");

interface ExtraResource {
  from: string;
  to: string;
}

function isExtraResource(value: unknown): value is ExtraResource {
  return (
    isRecord(value) &&
    typeof value.from === "string" &&
    typeof value.to === "string"
  );
}

function versionOf(text: string): unknown {
  const parsed = parseJson(text);
  return isRecord(parsed) ? parsed.version : undefined;
}

// The external-link policy is covered behaviourally by
// runtime/renderer-security.test.ts (externalBrowserUrl).
void test("package versions align", () => {
  const versions: unknown[] = [
    versionOf(fs.readFileSync(path.join(root, "package.json"), "utf8")),
    versionOf(
      fs.readFileSync(path.join(root, "apps/frontend/package.json"), "utf8"),
    ),
    versionOf(read("package.json")),
  ];
  assert.equal(new Set(versions).size, 1);
});

void test("Vision Demo uses a valid, distinct badged macOS icon", () => {
  const config = parseJsonAs(
    read("electron-builder-demo.json"),
    (value): value is { mac: { icon: string } } =>
      isRecord(value) &&
      isRecord(value.mac) &&
      typeof value.mac.icon === "string",
    "electron-builder-demo.json",
  );
  assert.equal(config.mac.icon, "resources-demo/icon-demo.icns");
  assert.notEqual(config.mac.icon, "build/icon.icns");
  const svg = read("resources-demo/icon-demo.svg");
  assert.match(svg, />DEMO<\/text>/);

  const icon = fs.readFileSync(
    path.join(appRoot, "resources-demo/icon-demo.icns"),
  );
  const productionIcon = fs.readFileSync(path.join(appRoot, "build/icon.icns"));
  assert.notDeepEqual(icon, productionIcon);
  assert.equal(icon.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(icon.readUInt32BE(4), icon.length);
  const chunkTypes: string[] = [];
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

void test("Vision Demo packages its native runtime without an external service dependency", () => {
  const installer = fs.readFileSync(path.join(root, "install-demo.sh"), "utf8");
  const config = parseJsonAs(
    read("electron-builder-demo.json"),
    (
      value,
    ): value is { extraResources: ExtraResource[]; afterPack: string } =>
      isRecord(value) &&
      Array.isArray(value.extraResources) &&
      value.extraResources.every(isExtraResource) &&
      typeof value.afterPack === "string",
    "electron-builder-demo.json",
  );
  assert.doesNotMatch(installer, /command -v (?:podman|colima)\b/im);
  assert.match(installer, /build-native-package\.js --demo/);
  assert.deepEqual(
    config.extraResources.map((entry) => entry.to),
    ["resources/DEMO"],
  );
  assert.deepEqual(
    config.extraResources.map((entry) => entry.from),
    ["resources-demo/DEMO"],
  );
  assert.equal(config.afterPack, "./out/scripts/finalize-native-package.js");
});

void test("native macOS installers stage frontend output outside the shared dist directory", () => {
  const helper = fs.readFileSync(
    path.join(root, "scripts/lib/native-mac-build.sh"),
    "utf8",
  );
  const productionInstaller = fs.readFileSync(
    path.join(root, "install.sh"),
    "utf8",
  );
  const demoInstaller = fs.readFileSync(
    path.join(root, "install-demo.sh"),
    "utf8",
  );

  assert.match(helper, /mktemp -d .*vision-native-build-/);
  assert.match(helper, /VISION_FRONTEND_DIST=.*frontend-dist/);
  assert.match(helper, /vite" build/);
  assert.match(helper, /--outDir "\$VISION_FRONTEND_DIST"/);
  assert.doesNotMatch(helper, /bun run build/);
  assert.match(productionInstaller, /trap cleanup_native_macos_build EXIT/);
  assert.match(demoInstaller, /trap cleanup_native_macos_build EXIT/);
});
