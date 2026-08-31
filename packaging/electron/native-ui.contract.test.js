"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const preload = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");
const rootPackage = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
);

test("native language bridge validates language and rebuilds menus", () => {
  assert.match(
    preload,
    /setLanguage: \(language\) => ipcRenderer\.invoke\(["']app:set-language["'], language\)/,
  );
  assert.match(main, /registerHandler\(\s*["']app:set-language["']/);
  assert.match(main, /language !== ["']en["'] && language !== ["']nl["']/);
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
  const builder = fs.readFileSync(
    path.join(__dirname, "electron-builder-base.json"),
    "utf8",
  );
  assert.match(builder, /"badge-image\.js"/);
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

test("native mode never starts a Docker writer from update or restore recovery", () => {
  assert.match(
    main,
    /update:pull-image[\s\S]{0,500}runtimeMode === ["']native["'][\s\S]{0,300}Docker image updates are unavailable/,
  );
  assert.match(
    main,
    /activeRuntime\?\.mode !== ["']native["'][\s\S]{0,500}["']docker["'][\s\S]{0,200}["']start["']/,
  );
  assert.ok(
    main.indexOf('if (runtimeMode === "native")') <
      main.indexOf("Check Docker is installed and running"),
    "native launch must return before the first Docker availability check",
  );
});

test("Electron development cannot reuse packaged Vision data", () => {
  assert.match(
    rootPackage.scripts["electron:dev"],
    /VISION_DEVELOPMENT_PROFILE=true/,
  );
  assert.match(main, /app\.setPath\(\s*["']userData["']/);
  assert.match(main, /Vision Development/);
  assert.match(
    main,
    /NATIVE_RUNTIME_ID = __IS_DEMO[\s\S]{0,100}DEMO_RUNTIME_ID[\s\S]{0,120}__IS_DEVELOPMENT_PROFILE[\s\S]{0,80}["']vision_dev["'][\s\S]{0,40}["']vision["']/,
  );
  assert.match(
    main,
    /readRuntimeSelectionState\(\s*app\.getPath\(["']userData["']\),\s*NATIVE_RUNTIME_ID/,
  );
  assert.match(main, /runtimeId: NATIVE_RUNTIME_ID/);
});

test("renderer boot is verified instead of leaving the static splash forever", () => {
  const baseConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, "electron-builder-base.json"), "utf8"),
  );
  const demoConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, "electron-builder-demo.json"), "utf8"),
  );
  assert.ok(baseConfig.files.includes("main.js"));
  assert.ok(baseConfig.files.includes("preload.js"));
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
