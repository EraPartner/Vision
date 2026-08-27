"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const preload = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");

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
