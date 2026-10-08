"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  REJECT_INVALID,
  createIpcArgumentContracts,
  isValidHslComponents,
  validateBackupDest,
} = require("./ipc-schemas");

const PICKED = "/Users/demo/Backups/vision.visionbak";
const contracts = createIpcArgumentContracts({
  isAllowedRestorePath: (resolved) =>
    [PICKED, "/Users/demo/Backups/notes.txt"].includes(resolved),
});

function accept(channel, ...args) {
  return contracts[channel].validate(args);
}

function reject(channel, args, message) {
  let error;
  assert.throws(
    () => contracts[channel].validate(args),
    (thrown) => {
      error = thrown;
      return message === undefined || thrown.message === message;
    },
  );
  const { invalidResult } = contracts[channel];
  return typeof invalidResult === "function"
    ? invalidResult(error)
    : invalidResult;
}

test("argument-free channels accept no arguments and reject extra ones", () => {
  for (const channel of [
    "update:check-github",
    "audit:enroll",
    "backup:select-file",
    "recovery:retry",
    "app:renderer-ready",
    "app:get-accent-color",
  ]) {
    assert.deepEqual(accept(channel), []);
    assert.deepEqual(accept(channel, undefined), []);
    reject(channel, ["unexpected"], "Unexpected IPC arguments");
  }
  assert.equal(contracts["update:check-github"].invalidResult, REJECT_INVALID);
  assert.equal(contracts["backup:select-dir"].invalidResult, null);
  assert.deepEqual(reject("audit:enroll", [1]), {
    success: false,
    error: "Unexpected IPC arguments",
  });
});

test("audit:read keeps the audit-viewer range rules", () => {
  assert.deepEqual(accept("audit:read"), [{ afterSequence: 0, limit: 100 }]);
  assert.deepEqual(accept("audit:read", { afterSequence: 7, limit: 500 }), [
    { afterSequence: 7, limit: 500 },
  ]);
  assert.deepEqual(reject("audit:read", [null]), {
    success: false,
    status: "failed",
    error: "Invalid audit read options",
  });
  reject("audit:read", [{ extra: true }], "Invalid audit read options");
  reject("audit:read", [{ limit: 0 }], "Invalid audit read range");
  reject("audit:read", [{ limit: 501 }], "Invalid audit read range");
  reject("audit:read", [{ afterSequence: -1 }], "Invalid audit read range");
});

test("audit transfers reject a missing or out-of-range password before any dialog", () => {
  for (const channel of ["audit:transfer-export", "audit:transfer-import"]) {
    const password = "p".repeat(16);
    assert.deepEqual(accept(channel, password), [password]);
    assert.deepEqual(accept(channel, "p".repeat(1024)), ["p".repeat(1024)]);
    for (const invalid of [
      undefined,
      null,
      12345678901234567890,
      { password },
      "p".repeat(15),
      "p".repeat(1025),
    ]) {
      assert.deepEqual(reject(channel, [invalid]), {
        success: false,
        status: "failed",
        reason: "transfer_password_invalid",
      });
    }
  }
});

test("backup restore accepts only picker-blessed files with a backup extension", () => {
  assert.deepEqual(accept("backup:restore", PICKED), [
    PICKED,
    { passphrase: undefined },
  ]);
  assert.deepEqual(
    accept(
      "backup:restore",
      "/Users/demo/Backups/../Backups/vision.visionbak",
      {
        passphrase: "secret",
      },
    ),
    [PICKED, { passphrase: "secret" }],
  );
  // A non-object options value carried no passphrase before and still does not.
  assert.deepEqual(accept("backup:restore", PICKED, "ignored"), [
    PICKED,
    { passphrase: undefined },
  ]);
  assert.deepEqual(reject("backup:restore", [42]), {
    success: false,
    error: "Invalid restore path",
  });
  reject("backup:restore", [""], "Invalid restore path");
  reject(
    "backup:restore",
    ["/etc/passwd"],
    "Restore path was not selected via the file picker",
  );
  reject(
    "backup:restore",
    ["/Users/demo/Backups/notes.txt"],
    "Unsupported backup file extension",
  );
  reject(
    "backup:restore",
    [PICKED, { passphrase: 1234 }],
    "Invalid restore passphrase",
  );
});

test("backup:is-encrypted answers false for paths the picker did not bless", () => {
  assert.deepEqual(accept("backup:is-encrypted", PICKED), [PICKED]);
  assert.equal(reject("backup:is-encrypted", [undefined]), false);
  assert.equal(reject("backup:is-encrypted", ["/etc/passwd"]), false);
});

test("backup:run validates the destination and the optional UI snapshot", () => {
  assert.deepEqual(accept("backup:run", "/Users/demo/Backups/"), [
    "/Users/demo/Backups",
    null,
  ]);
  assert.deepEqual(accept("backup:run", "/Users/demo/Backups", '{"keys":{}}'), [
    "/Users/demo/Backups",
    '{"keys":{}}',
  ]);
  assert.deepEqual(reject("backup:run", ["/etc/vision"]), {
    success: false,
    error: "Backup to system directories is not allowed",
  });
  reject("backup:run", [undefined], "Invalid backup directory");
  reject(
    "backup:run",
    ["/Users/demo/Backups", { keys: {} }],
    "Invalid frontend state snapshot",
  );
});

test("backup:save-settings rejects missing or mistyped settings instead of throwing", () => {
  assert.deepEqual(
    accept("backup:save-settings", {
      backupDir: "/Users/demo/Backups",
      backupOnQuit: true,
    }),
    [{ backupDir: "/Users/demo/Backups", backupOnQuit: true }],
  );
  assert.deepEqual(
    accept("backup:save-settings", { backupDir: "", backupOnQuit: false }),
    [{ backupDir: "", backupOnQuit: false }],
  );
  for (const invalid of [
    undefined,
    null,
    [],
    { backupDir: "/Users/demo/Backups" },
    { backupDir: "/Users/demo/Backups", backupOnQuit: "yes" },
    { backupDir: undefined, backupOnQuit: true },
  ]) {
    assert.deepEqual(reject("backup:save-settings", [invalid]), {
      success: false,
      error: "Invalid backup settings",
    });
  }
  assert.deepEqual(
    reject("backup:save-settings", [
      { backupDir: "/Library/Vision", backupOnQuit: true },
    ]),
    { success: false, error: "Backup to system directories is not allowed" },
  );
});

test("services:save-settings requires a boolean toggle", () => {
  assert.deepEqual(
    accept("services:save-settings", { keepServicesOnQuit: true }),
    [{ keepServicesOnQuit: true }],
  );
  for (const invalid of [
    undefined,
    {},
    { keepServicesOnQuit: "true" },
    { keepServicesOnQuit: 1 },
  ]) {
    assert.deepEqual(reject("services:save-settings", [invalid]), {
      success: false,
      error: "Invalid services settings",
    });
  }
});

test("backup:set-passphrase no longer turns a non-string into a clear request", () => {
  assert.deepEqual(accept("backup:set-passphrase", ""), [""]);
  assert.deepEqual(accept("backup:set-passphrase", " secret "), [" secret "]);
  assert.deepEqual(reject("backup:set-passphrase", [undefined]), {
    success: false,
    available: false,
    error: "Invalid backup passphrase",
  });
});

test("renderer failure diagnostics normalize anything to structural metadata", () => {
  assert.deepEqual(
    accept("app:renderer-failure", {
      kind: "resource",
      name: "ResourceLoadError",
      source: "index-abc.js",
      line: 12,
    }),
    [
      {
        kind: "resource",
        name: "ResourceLoadError",
        source: "index-abc.js",
        line: 12,
      },
    ],
  );
  for (const payload of [
    undefined,
    null,
    "boom",
    { kind: "x", name: "<b>", source: "/abs/path", line: 1.5 },
  ]) {
    assert.deepEqual(accept("app:renderer-failure", payload), [
      { kind: "error", name: "UnknownError", source: "unknown", line: 0 },
    ]);
  }
});

test("native shell setters keep their accepted values", () => {
  assert.deepEqual(accept("app:set-badge", 3), [3]);
  assert.deepEqual(accept("app:set-badge", "4.9"), [4]);
  assert.deepEqual(accept("app:set-badge", -2), [0]);
  assert.deepEqual(accept("app:set-badge", 5000), [999]);
  assert.deepEqual(reject("app:set-badge", [Number.NaN]), { success: false });
  reject("app:set-badge", ["many"], "Invalid badge count");

  assert.deepEqual(accept("app:set-language", "nl"), ["nl"]);
  assert.deepEqual(reject("app:set-language", ["fr"]), { success: false });

  assert.deepEqual(accept("app:set-vibrancy", false), [false]);
  assert.deepEqual(reject("app:set-vibrancy", ["true"]), { success: false });
});

test("theme:persist-splash accepts only HSL component strings", () => {
  const colors = {
    mode: "dark",
    background: "158 64% 52%",
    foreground: "0 0% 100%",
    surface: "220 14.5% 8%",
    text: "0 0% 98%",
  };
  assert.deepEqual(accept("theme:persist-splash", { ...colors, extra: 1 }), [
    colors,
  ]);
  assert.deepEqual(
    accept("theme:persist-splash", {
      background: "1 2% 3%",
      foreground: "4 5% 6%",
    }),
    [
      {
        mode: undefined,
        background: "1 2% 3%",
        foreground: "4 5% 6%",
        surface: undefined,
        text: undefined,
      },
    ],
  );
  for (const invalid of [
    undefined,
    { ...colors, background: "red" },
    { ...colors, mode: "sepia" },
    { ...colors, text: "1 2% 3%;}</style><script>" },
  ]) {
    assert.deepEqual(reject("theme:persist-splash", [invalid]), {
      success: false,
    });
  }
});

test("shared helpers keep their previous decisions", () => {
  assert.equal(
    validateBackupDest("/Users/demo/Library/Mobile Documents"),
    null,
  );
  assert.equal(
    validateBackupDest("/private/var/db/x"),
    "Backup to system directories is not allowed",
  );
  assert.equal(validateBackupDest(""), "Invalid backup directory");
  assert.equal(isValidHslComponents("158 64% 52%"), true);
  assert.equal(isValidHslComponents(`${"1".repeat(30)} 1% 1%`), false);
});
