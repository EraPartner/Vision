import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { appRoot } from "./paths";

interface BuilderConfig {
  extends?: string;
  files: string[];
}

// Compiled into out/: sources and packaging files are read from the package root.
const readSource = (...segments: string[]) =>
  fs.readFileSync(path.join(appRoot, ...segments), "utf8");
const main = readSource("main.ts");
const preload = readSource("preload.ts");
const rootPackage: { scripts: Record<string, string> } = JSON.parse(
  fs.readFileSync(path.join(appRoot, "..", "..", "package.json"), "utf8"),
);
const electronPackage: { main: string } = JSON.parse(
  readSource("package.json"),
);
const baseConfig: BuilderConfig = JSON.parse(
  readSource("electron-builder-base.json"),
);
const demoConfig: BuilderConfig = JSON.parse(
  readSource("electron-builder-demo.json"),
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

test("compiled shell entry points ship with the desktop package", () => {
  assertCompiledModulePackaged("main.js");
  assertCompiledModulePackaged("preload.js");
});

test("Electron development cannot reuse packaged Vision data", () => {
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

test("renderer boot is verified instead of leaving the static splash forever", () => {
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

test("main locates uncompiled files from the package root, not out/", () => {
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
