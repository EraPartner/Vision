"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const preload = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");
const contract = fs.readFileSync(
  path.join(root, "packaging/electron/electron-api.d.ts"),
  "utf8",
);

function matches(source, pattern) {
  return new Set([...source.matchAll(pattern)].map((match) => match[1]));
}

function interfaceBody(name, followingType) {
  const start = contract.indexOf(`export interface ${name} {`);
  const end = contract.indexOf(`export type ${followingType}`, start);
  assert.ok(
    start >= 0 && end > start,
    `${name} must be present in shared types`,
  );
  return contract.slice(start, end);
}

test("main, preload, and the shared invoke contract expose the same channels", () => {
  const declared = matches(
    interfaceBody("ElectronInvokeContract", "ElectronInvokeChannel"),
    /^\s+"([^"]+)":/gm,
  );
  const registered = matches(main, /registerHandler\(\s*"([^"]+)"/g);
  const invoked = matches(preload, /ipcRenderer\.invoke\("([^"]+)"/g);

  assert.equal(declared.size, 25);
  assert.deepEqual(registered, declared);
  assert.deepEqual(invoked, declared);
});

test("preload subscriptions and main sends match the shared event contract", () => {
  const declared = matches(
    interfaceBody("ElectronEventContract", "ElectronEventChannel"),
    /^\s+"([^"]+)":/gm,
  );
  const subscribed = matches(preload, /ipcRenderer\.on\("([^"]+)"/g);
  const sent = new Set([
    ...matches(main, /webContents\.send\(\s*"([^"]+)"/g),
    ...matches(main, /sendToApp\(\s*"([^"]+)"/g),
  ]);

  assert.equal(declared.size, 6);
  assert.deepEqual(subscribed, declared);
  assert.deepEqual(sent, declared);
});

test("all five context bridges consume a shared interface", () => {
  const interfaces = {
    electronUpdater: "ElectronUpdaterBridge",
    electronBackup: "ElectronBackupBridge",
    electronServices: "ElectronServicesBridge",
    electronAPI: "ElectronApiBridge",
    electronRecovery: "ElectronRecoveryBridge",
  };
  for (const [name, interfaceName] of Object.entries(interfaces)) {
    assert.match(
      preload,
      new RegExp(
        `\\./electron-api"\\)\\.${interfaceName}[^]*exposeInMainWorld\\("${name}", ${name}\\)`,
      ),
    );
  }
});
