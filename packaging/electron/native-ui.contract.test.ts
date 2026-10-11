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
const ipcSchemas = readSource("runtime", "ipc-schemas.ts");
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
// runtime module such as main.js, preload.js or badge-image.js.
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

test("native language bridge validates language and rebuilds menus", () => {
  assert.match(
    preload,
    /setLanguage: \(language\) => ipcRenderer\.invoke\(["']app:set-language["'], language\)/,
  );
  assert.match(main, /registerHandler\(\s*["']app:set-language["']/);
  assert.match(
    ipcSchemas,
    /language !== ["']en["'] && language !== ["']nl["']/,
  );
  assert.match(main, /request !== nativeLanguageRequest/);
  assert.match(main, /settings\.nativeLanguage = language/);
  assert.match(main, /await initI18n\(persistedSettings\.nativeLanguage\)/);
  assert.match(main, /setupApplicationMenu\(\);\s+setupDockMenu\(\);/);
  assert.ok(
    main.indexOf("const request = ++nativeLanguageRequest") <
      main.indexOf("if (nativeLanguage === language)"),
    "a request for the active language must still cancel an older in-flight load",
  );
});

test("launch starts loading the splash before native platform setup", () => {
  const launchStart = main.indexOf("async function launch()");
  const nativeStart = main.indexOf(
    'const endNative = bootMark("native_runtime_start")',
    launchStart,
  );
  const launchPrelude = main.slice(launchStart, nativeStart);

  const initI18n = launchPrelude.indexOf(
    "await initI18n(persistedSettings.nativeLanguage);",
  );
  const createWindow = launchPrelude.indexOf("createWindow();");
  const loadSplash = launchPrelude.indexOf(
    "mainWindow.loadURL(splashDataUrl());",
  );
  const applicationMenu = launchPrelude.indexOf("setupApplicationMenu();");
  const dockMenu = launchPrelude.indexOf("setupDockMenu();");
  const accentSubscription = launchPrelude.indexOf(
    "subscribeAccentColorChanges();",
  );

  assert.ok(initI18n >= 0, "launch must initialize localized labels");
  assert.ok(
    createWindow > initI18n,
    "window creation must follow localization",
  );
  assert.ok(loadSplash > createWindow, "the splash must load into the window");
  assert.ok(
    applicationMenu > loadSplash,
    "application-menu setup must not block splash loading",
  );
  assert.ok(
    dockMenu > loadSplash,
    "dock-menu setup must not block splash loading",
  );
  assert.ok(
    accentSubscription > loadSplash,
    "accent-color subscription must not block splash loading",
  );
});

test("planned-payment count reaches every desktop platform", () => {
  assert.match(main, /process\.platform === ["']win32["']/);
  assert.match(main, /setOverlayIcon\(/);
  assert.match(
    main,
    /nativeImage\.createFromBuffer\(createBadgePngBuffer\(count\)/,
  );
  assert.match(main, /app\.dock\.setBadge\(/);
  assert.match(main, /app\.setBadgeCount\(clamped\)/);
  assert.match(
    main,
    /count === 1\s*\?\s*["']upcoming\.count\.one["']\s*:\s*["']upcoming\.count\.other["']/,
  );
  assert.doesNotMatch(
    main,
    /registerHandler\(\s*["']app:set-badge["'][\s\S]{0,240}process\.platform !== ["']darwin["']/,
  );
  assert.match(main, /from "\.\/badge-image"/);
  assertCompiledModulePackaged("badge-image.js");
});

test("About metadata and a non-macOS Help item are present", () => {
  assert.match(main, /app\.setAboutPanelOptions\(/);
  assert.doesNotMatch(
    main,
    /if \(process\.platform === ["']darwin["'] \|\| process\.platform === ["']linux["']\) \{\s+try \{\s+app\.setAboutPanelOptions/,
  );
  assert.match(main, /label: t\(["']menu.about["']/);
  assert.match(main, /click: \(\) => app\.showAboutPanel\(\)/);
});

test("desktop update and restore recovery expose only the native writer", () => {
  assert.doesNotMatch(main, /update:[a-z-]+image/);
  assert.match(main, /createRuntimeProvider\(["']native["']/);
  assert.match(main, /await activeRuntime\.start\(\)/);
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

test("application URLs are derived from the single mutable app port", () => {
  assert.match(main, /let appPort = DEFAULT_APP_PORT/);
  assert.match(
    main,
    /const appUrl = \(\) => `http:\/\/localhost:\$\{appPort\}`/,
  );
  assert.match(main, /const healthUrl = \(\) => `\$\{appUrl\(\)\}\/health`/);
  assert.doesNotMatch(main, /\b(?:APP_URL|HEALTH_URL)\b/);
  assert.doesNotMatch(main, /appPort\s*=\s*port;\s*(?:APP_URL|HEALTH_URL)\s*=/);
});

test("desktop menus do not emit retired browser deep links", () => {
  for (const retiredPath of [
    "/portfolio/exchange-rates",
    "/research/symbol/",
    "/portfolio/market",
    "/portfolio/watchlist",
  ]) {
    assert.doesNotMatch(main, new RegExp(retiredPath.replaceAll("/", "\\/")));
  }
});

test("macOS vibrancy is enabled only through the validated renderer request", () => {
  assert.doesNotMatch(main, /vibrancy:\s*["']under-window["']/);
  assert.match(main, /registerHandler\(\s*["']app:set-vibrancy["']/);
  assert.match(ipcSchemas, /typeof enabled !== ["']boolean["']/);
  assert.match(
    main,
    /mainWindow\.setVibrancy\(enabled \? ["']under-window["'] : null\)/,
  );
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
