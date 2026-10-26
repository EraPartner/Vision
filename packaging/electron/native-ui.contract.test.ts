import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { appRoot } from "./paths";
import {
  isRecord,
  isStringArray,
  isStringRecord,
  parseJsonAs,
} from "./test-support";

interface BuilderConfig {
  extends?: string;
  files: string[];
}

// Compiled into out/: sources and packaging files are read from the package root.
const readSource = (...segments: string[]) =>
  fs.readFileSync(path.join(appRoot, ...segments), "utf8");
const main = readSource("main.ts");
const preload = readSource("preload.ts");
function hasOptionalExtends(value: unknown): value is { extends?: string } {
  return (
    isRecord(value) &&
    (value.extends === undefined || typeof value.extends === "string")
  );
}
function isBuilderConfig(value: unknown): value is BuilderConfig {
  return (
    isRecord(value) &&
    (value.extends === undefined || typeof value.extends === "string") &&
    isStringArray(value.files)
  );
}
const rootPackage = parseJsonAs(
  fs.readFileSync(path.join(appRoot, "..", "..", "package.json"), "utf8"),
  (value): value is { scripts: Record<string, string> } =>
    isRecord(value) && isStringRecord(value.scripts),
  "root package.json",
);
const electronPackage = parseJsonAs(
  readSource("package.json"),
  (value): value is { main: string } =>
    isRecord(value) && typeof value.main === "string",
  "electron package.json",
);
const baseConfig = parseJsonAs(
  readSource("electron-builder-base.json"),
  isBuilderConfig,
  "electron-builder-base.json",
);
const demoConfig = parseJsonAs(
  readSource("electron-builder-demo.json"),
  hasOptionalExtends,
  "electron-builder-demo.json",
);

// Every compiled shell module ships from out/; no exclusion may drop a
// runtime module such as main.js or preload.js.
function assertCompiledModulePackaged(file: string): void {
  assert.ok(baseConfig.files.includes("out/**/*"));
  const excluded = baseConfig.files.filter(
    (pattern) =>
      pattern.startsWith("!") &&
      (pattern.endsWith(`/${file}`) ||
        pattern === "!out/**/*" ||
        pattern === "!out/**/*.js"),
  );
  assert.deepEqual(excluded, [], `out/${file} must be packaged`);
}

void test("compiled shell entry points ship with the desktop package", () => {
  assertCompiledModulePackaged("main.js");
  assertCompiledModulePackaged("preload.js");
});

void test("Electron development cannot reuse packaged Vision data", () => {
  assert.match(
    rootPackage.scripts["electron:dev"] ?? "",
    /VISION_DEVELOPMENT_PROFILE=true/,
  );
  assert.match(main, /app\.setPath\(\s*["']userData["']/);
  assert.match(main, /Vision Development/);
  assert.match(
    main,
    /NATIVE_RUNTIME_ID = __IS_DEMO[\s\S]{0,100}DEMO_RUNTIME_ID[\s\S]{0,120}__IS_DEVELOPMENT_PROFILE[\s\S]{0,80}["']vision_dev["'][\s\S]{0,40}["']vision["']/,
  );
  assert.match(main, /runtimeId: NATIVE_RUNTIME_ID/);
});

void test("renderer boot is verified instead of leaving the static splash forever", () => {
  assert.equal(electronPackage.main, "out/main.js");
  assertCompiledModulePackaged("main.js");
  assertCompiledModulePackaged("preload.js");
  assert.match(main, /preload: path\.join\(__dirname, "preload\.js"\)/);
  assert.equal(demoConfig.extends, "./electron-builder-base.json");
  assert.match(preload, /window\.addEventListener\(\s*["']error["']/);
  assert.match(preload, /app:renderer-failure/);
  assert.match(main, /RENDERER_READY_TIMEOUT_MS/);
  assert.match(main, /reloadIgnoringCache\(\)/);
  assert.match(main, /app\.rendererErrorPageMessage/);
  assert.match(main, /app:renderer-ready[\s\S]{0,300}stopRendererBootWatchdog/);
  assert.match(main, /did-fail-load/);
  assert.match(main, /render-process-gone/);
});

void test("main locates uncompiled files from the package root, not out/", () => {
  // __dirname is out/ at runtime: only the compiled preload sits beside main.js.
  assert.deepEqual(
    [...main.matchAll(/__dirname[^\n]*/g)].map((match) => match[0]),
    ['__dirname, "preload.js"),'],
  );
  assert.match(main, /path\.join\(appRoot, "i18n"\)/);
  assert.match(main, /path\.join\(appRoot, "assets", "error\.html"\)/);
  assert.match(main, /path\.join\(appRoot, "native-runtime"\)/);
  assert.match(
    main,
    /const repoRoot = path\.resolve\(appRoot, "\.\.", "\.\."\)/,
  );
  assert.match(
    main,
    /repoRootFallback: path\.resolve\(appRoot, "\.\.", "\.\."\)/,
  );
});
