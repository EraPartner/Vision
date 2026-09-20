"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAuditAnchor } = require("../audit-anchor");

const GENESIS = "0".repeat(64);
const HEAD_A = "a".repeat(64);
const HEAD_B = "b".repeat(64);
const ZERO_CUTOVER = { dbEditorMaxId: 0, splitMaxId: 0, retagMaxId: 0 };

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`test-only:${value}`),
    decryptString: (value) => {
      const encoded = value.toString();
      if (!encoded.startsWith("test-only:")) throw new Error("key unavailable");
      return encoded.slice("test-only:".length);
    },
  };
}

async function fixture(t, storage = fakeSafeStorage()) {
  const userDataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-audit-anchor-"),
  );
  t.after(() => fs.promises.rm(userDataDir, { recursive: true, force: true }));
  let checkpoint;
  const witness = {
    read: async () => checkpoint && structuredClone(checkpoint),
    create: async (value) => {
      if (checkpoint) throw new Error("already exists");
      checkpoint = structuredClone(value);
    },
    replace: async (value) => {
      if (!checkpoint) throw new Error("missing");
      checkpoint = structuredClone(value);
    },
    remove: () => {
      checkpoint = undefined;
    },
  };
  return {
    userDataDir,
    storage,
    witness,
    keyPath: path.join(userDataDir, "audit-anchor", "key.enc"),
    receiptPath: path.join(userDataDir, "audit-anchor", "checkpoint.json"),
    anchor: createAuditAnchor({
      userDataDir,
      safeStorage: storage,
      witness,
      platform: "darwin",
    }),
  };
}

test("initializes only a genesis receipt and reloads an authenticated checkpoint", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.anchor.readTrustedCheckpoint(), {
    code: "uninitialized",
  });
  const genesis = await f.anchor.initializeGenesis(ZERO_CUTOVER);
  assert.equal(genesis.sequence, 0);
  assert.equal(genesis.headHash, GENESIS);
  assert.deepEqual(
    (await f.anchor.readTrustedCheckpoint()).legacyCutover,
    ZERO_CUTOVER,
  );
  assert.equal(genesis.anchorKind, "macos_keychain_witness_hmac_v3");
  assert.match(genesis.receiptHash, /^[0-9a-f]{64}$/);
  assert.equal((await fs.promises.stat(f.keyPath)).mode & 0o777, 0o600);
  assert.equal((await fs.promises.stat(f.receiptPath)).mode & 0o777, 0o600);
  assert.equal(
    (await f.anchor.initializeGenesis(ZERO_CUTOVER)).receiptHash,
    genesis.receiptHash,
  );

  const updated = await f.anchor.persistCheckpoint({
    sequence: 2,
    hash: HEAD_A,
  });
  assert.equal(updated.sequence, 2);
  const restarted = createAuditAnchor({
    userDataDir: f.userDataDir,
    safeStorage: f.storage,
    witness: f.witness,
    platform: "darwin",
  });
  assert.deepEqual(await restarted.compareHead({ sequence: 2, hash: HEAD_A }), {
    status: "anchored",
    checkpoint: { sequence: 2, hash: HEAD_A },
  });
  assert.equal(
    (await restarted.readTrustedCheckpoint()).metadata.receiptHash,
    updated.receiptHash,
  );
});

test("password-protected transfer installs the trusted checkpoint on a fresh device", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t);
  await source.anchor.initializeFirstCheckpoint(
    { sequence: 4, hash: HEAD_A },
    ZERO_CUTOVER,
    { enrollment: true },
  );
  await target.anchor.initializeGenesis(ZERO_CUTOVER);
  const old = await target.anchor.readTrustedCheckpoint();
  const oldKeyFile = await fs.promises.readFile(target.keyPath, "utf8");
  const oldReceiptFile = await fs.promises.readFile(target.receiptPath, "utf8");
  const transfer = await source.anchor.exportProtectedTransfer(
    "a long synthetic passphrase",
  );
  assert.equal(transfer.toString().includes(HEAD_A), false);
  await assert.rejects(
    target.anchor.importProtectedTransfer(
      transfer,
      "wrong synthetic passphrase",
      { expectedCurrent: old },
    ),
    { code: "transfer_invalid_or_password" },
  );
  const tampered = JSON.parse(transfer.toString());
  tampered.tag = Buffer.alloc(16).toString("base64");
  await assert.rejects(
    target.anchor.importProtectedTransfer(
      Buffer.from(JSON.stringify(tampered)),
      "a long synthetic passphrase",
      { expectedCurrent: old },
    ),
    { code: "transfer_invalid_or_password" },
  );
  assert.equal((await target.anchor.readTrustedCheckpoint()).sequence, 0);
  await assert.rejects(
    target.anchor.importProtectedTransfer(
      transfer,
      "a long synthetic passphrase",
    ),
    { code: "transfer_target_not_fresh" },
  );
  const metadata = await target.anchor.importProtectedTransfer(
    transfer,
    "a long synthetic passphrase",
    {
      expectedCurrent: { sequence: old.sequence, hash: old.hash },
    },
  );
  assert.equal(metadata.sequence, 4);
  assert.equal(metadata.enrollmentSequence, 4);
  assert.equal((await target.anchor.readTrustedCheckpoint()).hash, HEAD_A);
  await assert.rejects(
    target.anchor.importProtectedTransfer(
      transfer,
      "a long synthetic passphrase",
      {
        expectedCurrent: { sequence: old.sequence, hash: old.hash },
      },
    ),
    { code: "transfer_target_not_fresh" },
  );
  const journalDir = path.join(target.userDataDir, "audit-anchor");
  await fs.promises.writeFile(
    path.join(journalDir, "key.before-transfer.enc"),
    oldKeyFile,
    { mode: 0o600 },
  );
  await fs.promises.writeFile(
    path.join(journalDir, "checkpoint.before-transfer.json"),
    oldReceiptFile,
    { mode: 0o600 },
  );
  assert.equal((await target.anchor.readTrustedCheckpoint()).hash, HEAD_A);
  assert.equal(
    fs.existsSync(path.join(journalDir, "key.before-transfer.enc")),
    false,
  );
});

test("interrupted transfer restores the fresh checkpoint only when its witness still matches", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t);
  await source.anchor.initializeFirstCheckpoint(
    { sequence: 4, hash: HEAD_A },
    ZERO_CUTOVER,
    { enrollment: true },
  );
  await target.anchor.initializeGenesis(ZERO_CUTOVER);
  const fresh = await target.anchor.readTrustedCheckpoint();
  const transfer = await source.anchor.exportProtectedTransfer(
    "synthetic transfer password",
  );
  target.witness.replace = async () => {
    throw new Error("synthetic Keychain interruption");
  };
  await assert.rejects(
    target.anchor.importProtectedTransfer(
      transfer,
      "synthetic transfer password",
      { expectedCurrent: { sequence: fresh.sequence, hash: fresh.hash } },
    ),
    { code: "transfer_import_incomplete" },
  );
  assert.equal((await target.anchor.readTrustedCheckpoint()).hash, fresh.hash);

  const oldKey = await fs.promises.readFile(target.keyPath, "utf8");
  const oldReceipt = await fs.promises.readFile(target.receiptPath, "utf8");
  const journalKey = path.join(
    target.userDataDir,
    "audit-anchor",
    "key.before-transfer.enc",
  );
  const journalReceipt = path.join(
    target.userDataDir,
    "audit-anchor",
    "checkpoint.before-transfer.json",
  );
  await fs.promises.writeFile(journalKey, oldKey, { mode: 0o600 });
  await fs.promises.writeFile(journalReceipt, oldReceipt, { mode: 0o600 });
  await fs.promises.writeFile(target.keyPath, "interrupted-key", {
    mode: 0o600,
  });
  const restarted = createAuditAnchor({
    userDataDir: target.userDataDir,
    safeStorage: target.storage,
    witness: target.witness,
    platform: "darwin",
  });
  assert.equal((await restarted.readTrustedCheckpoint()).hash, fresh.hash);
  assert.equal(await fs.promises.readFile(target.keyPath, "utf8"), oldKey);
  assert.equal(fs.existsSync(journalKey), false);
  assert.equal(fs.existsSync(journalReceipt), false);
});

test("rotating the audit key keeps the anchored head but changes the protected identity", async (t) => {
  const f = await fixture(t);
  const before = await f.anchor.initializeFirstCheckpoint(
    { sequence: 3, hash: HEAD_A },
    ZERO_CUTOVER,
    { enrollment: true },
  );
  const rotated = await f.anchor.rotateKey();
  assert.equal(rotated.sequence, before.sequence);
  assert.equal(rotated.headHash, before.headHash);
  assert.equal(rotated.enrollmentSequence, before.enrollmentSequence);
  assert.notEqual(rotated.receiptId, before.receiptId);
  assert.notEqual(rotated.receiptHash, before.receiptHash);
  assert.equal((await f.anchor.readTrustedCheckpoint()).hash, HEAD_A);
  const advanced = await f.anchor.persistCheckpoint({
    sequence: 4,
    hash: HEAD_B,
  });
  assert.equal(advanced.sequence, 4);
  assert.equal(advanced.enrollmentSequence, 3);
});

test("a retention boundary remains authenticated across closure, rotation, and transfer", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t);
  await source.anchor.initializeFirstCheckpoint(
    { sequence: 4, hash: HEAD_A },
    ZERO_CUTOVER,
  );
  const retention = {
    through: 2,
    hash: HEAD_B,
    domainMax: { dbEditor: 3, split: 5, retag: 7 },
    migrationHeads: ["0118_audit_retention_pruner"],
  };
  const first = await source.anchor.persistRetentionBoundary(retention);
  assert.deepEqual(first.retention, retention);
  await assert.rejects(source.anchor.persistRetentionBoundary(retention), {
    code: "retention_regression",
  });
  await source.anchor.persistCheckpoint({ sequence: 5, hash: HEAD_B });
  await source.anchor.rotateKey();
  assert.deepEqual(
    (await source.anchor.readTrustedCheckpoint()).retention,
    retention,
  );
  const file = await source.anchor.exportProtectedTransfer(
    "synthetic transfer password",
  );
  await target.anchor.initializeGenesis(ZERO_CUTOVER);
  await target.anchor.importProtectedTransfer(
    file,
    "synthetic transfer password",
    {
      expectedCurrent: { sequence: 0, hash: GENESIS },
    },
  );
  assert.deepEqual(
    (await target.anchor.readTrustedCheckpoint()).retention,
    retention,
  );
});

test("rejects rollback and forks, while allowing a newer unanchored database head", async (t) => {
  const f = await fixture(t);
  await f.anchor.initializeGenesis(ZERO_CUTOVER);
  await f.anchor.persistCheckpoint({ sequence: 4, hash: HEAD_A });
  await assert.rejects(f.anchor.compareHead({ sequence: 3, hash: HEAD_A }), {
    code: "rollback",
  });
  await assert.rejects(f.anchor.compareHead({ sequence: 4, hash: HEAD_B }), {
    code: "fork",
  });
  await assert.rejects(
    f.anchor.persistCheckpoint({ sequence: 3, hash: HEAD_B }),
    { code: "rollback" },
  );
  await assert.rejects(
    f.anchor.persistCheckpoint({ sequence: 4, hash: HEAD_B }),
    { code: "fork" },
  );
  assert.equal(
    (await f.anchor.compareHead({ sequence: 5, hash: HEAD_B })).status,
    "ahead_of_anchor",
  );
  assert.equal((await f.anchor.readTrustedCheckpoint()).sequence, 4);
});

test("rejects a changed receipt, lost key, missing receipt, and key rotation", async (t) => {
  const f = await fixture(t);
  await f.anchor.initializeGenesis(ZERO_CUTOVER);
  const original = await fs.promises.readFile(f.receiptPath, "utf8");
  await fs.promises.writeFile(
    f.receiptPath,
    JSON.stringify({ ...JSON.parse(original), version: 2 }),
  );
  await assert.rejects(f.anchor.readTrustedCheckpoint(), {
    code: "legacy_anchor_unverified",
  });
  await fs.promises.writeFile(f.receiptPath, original);
  const altered = JSON.parse(original);
  altered.hash = HEAD_B;
  await fs.promises.writeFile(f.receiptPath, JSON.stringify(altered));
  await assert.rejects(f.anchor.readTrustedCheckpoint(), {
    code: "receipt_tampered",
  });
  await fs.promises.writeFile(f.receiptPath, original);

  const forgedCutover = JSON.parse(original);
  forgedCutover.legacyCutover.splitMaxId = 99;
  await fs.promises.writeFile(f.receiptPath, JSON.stringify(forgedCutover));
  await assert.rejects(f.anchor.readTrustedCheckpoint(), {
    code: "receipt_tampered",
  });
  await fs.promises.writeFile(f.receiptPath, original);

  await fs.promises.writeFile(
    f.keyPath,
    f.storage
      .encryptString(Buffer.alloc(32, 7).toString("base64"))
      .toString("base64"),
  );
  await assert.rejects(f.anchor.readTrustedCheckpoint(), {
    code: "key_changed",
  });
  await fs.promises.rm(f.keyPath);
  await assert.rejects(f.anchor.initializeGenesis(ZERO_CUTOVER), {
    code: "key_missing",
  });
  await fs.promises.writeFile(f.keyPath, "invalid");
  await assert.rejects(f.anchor.readTrustedCheckpoint(), {
    code: "key_unavailable",
  });
  await fs.promises.rm(f.receiptPath);
  await assert.rejects(f.anchor.initializeGenesis(ZERO_CUTOVER), {
    code: "receipt_missing",
  });
});

test("does not create an insecure anchor without macOS secure storage", async (t) => {
  const f = await fixture(t);
  const linux = createAuditAnchor({
    userDataDir: f.userDataDir,
    safeStorage: f.storage,
    witness: f.witness,
    platform: "linux",
  });
  await assert.rejects(linux.initializeGenesis(ZERO_CUTOVER), {
    code: "unsupported_platform",
  });
  await assert.rejects(
    createAuditAnchor({
      userDataDir: f.userDataDir,
      safeStorage: { ...f.storage, isEncryptionAvailable: () => false },
      witness: f.witness,
      platform: "darwin",
    }).initializeGenesis(ZERO_CUTOVER),
    { code: "secure_storage_unavailable" },
  );
  assert.equal(fs.existsSync(f.keyPath), false);
});

test("serializes simultaneous checkpoint writes and retains the latest sequence", async (t) => {
  const f = await fixture(t);
  await f.anchor.initializeGenesis(ZERO_CUTOVER);
  await Promise.all([
    f.anchor.persistCheckpoint({ sequence: 1, hash: HEAD_A }),
    f.anchor.persistCheckpoint({ sequence: 2, hash: HEAD_B }),
  ]);
  assert.deepEqual(await f.anchor.compareHead({ sequence: 2, hash: HEAD_B }), {
    status: "anchored",
    checkpoint: { sequence: 2, hash: HEAD_B },
  });
});

test("independent witness detects app-data rollback and removal", async (t) => {
  const f = await fixture(t);
  await f.anchor.initializeGenesis(ZERO_CUTOVER);
  const oldReceipt = await fs.promises.readFile(f.receiptPath, "utf8");
  await f.anchor.persistCheckpoint({ sequence: 2, hash: HEAD_A });
  await fs.promises.writeFile(f.receiptPath, oldReceipt);
  await assert.rejects(f.anchor.readTrustedCheckpoint(), {
    code: "witness_mismatch",
  });
  f.witness.remove();
  await assert.rejects(f.anchor.readTrustedCheckpoint(), {
    code: "witness_missing",
  });
  await assert.rejects(f.anchor.initializeGenesis(ZERO_CUTOVER), {
    code: "witness_missing",
  });
});

test("explicit existing-install enrollment signs its baseline and retains it across closures", async (t) => {
  const f = await fixture(t);
  const enrolled = await f.anchor.initializeFirstCheckpoint(
    { sequence: 3, hash: HEAD_A },
    ZERO_CUTOVER,
    { enrollment: true },
  );
  assert.equal(enrolled.enrollmentSequence, 3);
  assert.equal(
    (await f.anchor.readTrustedCheckpoint()).metadata.enrollmentSequence,
    3,
  );
  const next = await f.anchor.persistCheckpoint({ sequence: 4, hash: HEAD_B });
  assert.equal(next.enrollmentSequence, 3);
  const original = await fs.promises.readFile(f.receiptPath, "utf8");
  const altered = JSON.parse(original);
  altered.enrollmentSequence = 0;
  await fs.promises.writeFile(f.receiptPath, JSON.stringify(altered));
  await assert.rejects(f.anchor.readTrustedCheckpoint(), {
    code: "receipt_tampered",
  });
});

test("a failed Keychain advance leaves the receipt unavailable instead of repairing it", async (t) => {
  const f = await fixture(t);
  await f.anchor.initializeGenesis(ZERO_CUTOVER);
  f.witness.replace = async () => {
    throw new Error("synthetic Keychain failure");
  };
  await assert.rejects(
    f.anchor.persistCheckpoint({ sequence: 1, hash: HEAD_A }),
    { code: "witness_unavailable" },
  );
  await assert.rejects(f.anchor.readTrustedCheckpoint(), {
    code: "witness_mismatch",
  });
});
