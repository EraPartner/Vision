import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { appRoot } from "./paths";
import {
  REJECT_INVALID,
  createIpcArgumentContracts,
} from "./runtime/ipc-schemas";

// Compiled into out/: the sources are read from the package root.
const main = fs.readFileSync(path.join(appRoot, "main.ts"), "utf8");
const preload = fs.readFileSync(path.join(appRoot, "preload.ts"), "utf8");
const contract = fs.readFileSync(
  path.join(appRoot, "electron-api.d.ts"),
  "utf8",
);

function matches(source: string, pattern: RegExp): Set<string | undefined> {
  return new Set([...source.matchAll(pattern)].map((match) => match[1]));
}

function interfaceBody(name: string, followingType: string): string {
  const start = contract.indexOf(`export interface ${name} {`);
  const end = contract.indexOf(`export type ${followingType}`, start);
  assert.ok(
    start >= 0 && end > start,
    `${name} must be present in shared types`,
  );
  return contract.slice(start, end);
}

void test("main, preload, and the shared invoke contract expose the same channels", () => {
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

void test("preload subscriptions and main sends match the shared event contract", () => {
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

void test("every invoke channel declares an argument contract", () => {
  const declared = matches(
    interfaceBody("ElectronInvokeContract", "ElectronInvokeChannel"),
    /^\s+"([^"]+)":/gm,
  );
  const contracts = createIpcArgumentContracts({
    isAllowedRestorePath: () => false,
  });

  assert.deepEqual(new Set(Object.keys(contracts)), declared);
  for (const [channel, contract] of Object.entries(contracts)) {
    assert.equal(
      typeof contract.validate,
      "function",
      `${channel} must declare validate`,
    );
    assert.ok(
      Object.hasOwn(contract, "invalidResult"),
      `${channel} must declare how invalid arguments are answered`,
    );
    assert.ok(
      contract.invalidResult === REJECT_INVALID ||
        contract.invalidResult === null ||
        contract.invalidResult === false ||
        typeof contract.invalidResult === "function" ||
        typeof contract.invalidResult === "object",
      `${channel} has an unusable invalidResult`,
    );
  }
});

void test("registerHandler is the only ipcMain.handle call and enforces contracts", () => {
  assert.equal([...main.matchAll(/ipcMain\.handle\(channel,/g)].length, 1);
  assert.equal([...main.matchAll(/^\s*ipcMain\.handle\(/gm)].length, 1);
  const start = main.indexOf("function registerHandler<");
  const handle = main.indexOf("ipcMain.handle(", start);
  const body = main.slice(start, main.indexOf("\n}\n", start));
  assert.ok(start >= 0 && handle > start);
  assert.match(
    main.slice(start, handle),
    /has no argument contract in runtime\/ipc-schemas\.ts/,
  );
  assert.ok(
    body.indexOf("trustedSender") < body.indexOf("validate(rawArgs)"),
    "the sender check must run before argument validation",
  );
  assert.ok(
    body.indexOf("validate(rawArgs)") < body.indexOf("fn(event, ...args)"),
    "handlers must receive only validated arguments",
  );
  assert.doesNotMatch(body, /fn\(event, \.\.\.rawArgs\)/);
});
