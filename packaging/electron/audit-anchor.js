"use strict";

// Main-process-only local checkpoint. The encrypted key and signed receipt live
// outside PostgreSQL. Callers must verify the full database chain separately.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const VERSION = 3;
const GENESIS_HASH = "0".repeat(64);
const HASH = /^[0-9a-f]{64}$/;
const ANCHOR_KIND = "macos_keychain_witness_hmac_v3";
const TRANSFER_AAD = Buffer.from("vision-audit-transfer-v1");
const TRANSFER_MAX_BYTES = 16 * 1024;

class AuditAnchorError extends Error {
  constructor(code) {
    super(`Audit anchor ${code}`);
    this.name = "AuditAnchorError";
    this.code = code;
  }
}

function requireHead(head) {
  if (
    !head ||
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 0 ||
    typeof head.hash !== "string" ||
    !HASH.test(head.hash)
  ) {
    throw new TypeError("Invalid audit chain head");
  }
  return { sequence: head.sequence, hash: head.hash };
}

function requireLegacyCutover(cutover) {
  const fields = ["dbEditorMaxId", "splitMaxId", "retagMaxId"];
  if (
    !cutover ||
    fields.some(
      (field) => !Number.isSafeInteger(cutover[field]) || cutover[field] < 0,
    )
  ) {
    throw new TypeError("Invalid audit legacy cutover");
  }
  return Object.fromEntries(fields.map((field) => [field, cutover[field]]));
}

function requireRetention(retention) {
  if (retention === undefined) return undefined;
  if (
    !retention ||
    !Number.isSafeInteger(retention.through) ||
    retention.through < 1 ||
    typeof retention.hash !== "string" ||
    !HASH.test(retention.hash) ||
    !Array.isArray(retention.migrationHeads) ||
    retention.migrationHeads.length > 16 ||
    retention.migrationHeads.some(
      (head) => typeof head !== "string" || !/^[0-9a-z_]{1,64}$/.test(head),
    ) ||
    JSON.stringify(retention.migrationHeads) !==
      JSON.stringify([...retention.migrationHeads].sort()) ||
    !retention.domainMax ||
    ["dbEditor", "split", "retag"].some(
      (field) =>
        !Number.isSafeInteger(retention.domainMax[field]) ||
        retention.domainMax[field] < 0,
    )
  )
    throw new TypeError("Invalid audit retention boundary");
  return {
    through: retention.through,
    hash: retention.hash,
    domainMax: {
      dbEditor: retention.domainMax.dbEditor,
      split: retention.domainMax.split,
      retag: retention.domainMax.retag,
    },
    migrationHeads: [...retention.migrationHeads],
  };
}

function assertSecureStorage(platform, safeStorage) {
  if (platform !== "darwin") throw new AuditAnchorError("unsupported_platform");
  if (
    !safeStorage ||
    typeof safeStorage.isEncryptionAvailable !== "function" ||
    typeof safeStorage.encryptString !== "function" ||
    typeof safeStorage.decryptString !== "function" ||
    !safeStorage.isEncryptionAvailable()
  ) {
    throw new AuditAnchorError("secure_storage_unavailable");
  }
}

function signedBytes(receipt) {
  const fields = [
    VERSION,
    receipt.keyId,
    receipt.sequence,
    receipt.hash,
    receipt.legacyCutover,
    receipt.createdAt,
  ];
  // Existing v3 receipts predate explicit enrollment. Keep their MAC encoding.
  if (receipt.enrollmentSequence !== undefined) {
    fields.push(receipt.enrollmentSequence);
  }
  if (receipt.retention !== undefined) fields.push(receipt.retention);
  return Buffer.from(JSON.stringify(fields));
}

function macFor(key, receipt) {
  return crypto
    .createHmac("sha256", key)
    .update(signedBytes(receipt))
    .digest("hex");
}

function requireTransferPassword(password) {
  if (
    typeof password !== "string" ||
    password.length < 16 ||
    password.length > 1024
  ) {
    throw new AuditAnchorError("transfer_password_invalid");
  }
}

function validateTransferredReceipt(key, receipt) {
  if (
    !Buffer.isBuffer(key) ||
    key.length !== 32 ||
    !receipt ||
    receipt.version !== VERSION ||
    receipt.keyId !== crypto.createHash("sha256").update(key).digest("hex") ||
    !Number.isSafeInteger(receipt.sequence) ||
    receipt.sequence < 0 ||
    typeof receipt.hash !== "string" ||
    !HASH.test(receipt.hash) ||
    typeof receipt.createdAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(receipt.createdAt) ||
    typeof receipt.mac !== "string" ||
    !HASH.test(receipt.mac) ||
    (receipt.enrollmentSequence !== undefined &&
      (!Number.isSafeInteger(receipt.enrollmentSequence) ||
        receipt.enrollmentSequence < 0 ||
        receipt.enrollmentSequence > receipt.sequence))
  )
    throw new AuditAnchorError("transfer_invalid");
  try {
    requireLegacyCutover(receipt.legacyCutover);
    if (
      receipt.retention !== undefined &&
      requireRetention(receipt.retention).through >= receipt.sequence
    ) {
      throw new TypeError("Invalid retention boundary");
    }
  } catch {
    throw new AuditAnchorError("transfer_invalid");
  }
  if (
    !crypto.timingSafeEqual(
      Buffer.from(receipt.mac, "hex"),
      Buffer.from(macFor(key, receipt), "hex"),
    )
  ) {
    throw new AuditAnchorError("transfer_invalid");
  }
}

function deriveTransferKey(password, salt) {
  return crypto.scryptSync(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

async function exists(file) {
  try {
    await fs.promises.lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readRegular(file) {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile()) throw new AuditAnchorError("invalid_file_type");
  return fs.promises.readFile(file, "utf8");
}

async function atomicPrivateWrite(file, contents) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let handle;
  try {
    handle = await fs.promises.open(tmp, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(tmp, file);
    await fs.promises.chmod(file, 0o600);
    // Persist the rename as well as the file bytes across a process crash.
    const directory = await fs.promises.open(path.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (handle) await handle.close();
    await fs.promises.rm(tmp, { force: true });
  }
}

function createAuditAnchor({
  userDataDir,
  safeStorage,
  witness,
  platform = process.platform,
}) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) {
    throw new TypeError("userDataDir must be an absolute path");
  }
  const directory = path.join(userDataDir, "audit-anchor");
  const keyPath = path.join(directory, "key.enc");
  const receiptPath = path.join(directory, "checkpoint.json");
  const transferOldKeyPath = path.join(directory, "key.before-transfer.enc");
  const transferOldReceiptPath = path.join(
    directory,
    "checkpoint.before-transfer.json",
  );
  let queue = Promise.resolve();

  async function readWitness() {
    if (!witness || typeof witness.read !== "function") {
      throw new AuditAnchorError("witness_unavailable");
    }
    try {
      return await witness.read();
    } catch {
      throw new AuditAnchorError("witness_unavailable");
    }
  }

  function witnessValue(current) {
    return {
      version: VERSION,
      keyId: current.receipt.keyId,
      sequence: current.receipt.sequence,
      hash: current.receipt.hash,
      receiptHash: current.metadata.receiptHash,
    };
  }

  async function requireMatchingWitness(current) {
    const stored = await readWitness();
    if (!stored) throw new AuditAnchorError("witness_missing");
    const expected = witnessValue(current);
    if (Object.keys(expected).some((key) => stored[key] !== expected[key])) {
      throw new AuditAnchorError("witness_mismatch");
    }
    return current;
  }

  async function loadPair({
    verifyWitness = true,
    keyFile = keyPath,
    receiptFile = receiptPath,
  } = {}) {
    const [hasKey, hasReceipt] = await Promise.all([
      exists(keyFile),
      exists(receiptFile),
    ]);
    if (!hasKey && !hasReceipt) {
      if (await readWitness())
        throw new AuditAnchorError("local_anchor_missing");
      return undefined;
    }
    if (!hasKey) throw new AuditAnchorError("key_missing");
    if (!hasReceipt) throw new AuditAnchorError("receipt_missing");
    assertSecureStorage(platform, safeStorage);
    let key;
    try {
      const encoded = await readRegular(keyFile);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        throw new Error("invalid key encoding");
      }
      key = Buffer.from(
        safeStorage.decryptString(Buffer.from(encoded, "base64")),
        "base64",
      );
    } catch (error) {
      if (error instanceof AuditAnchorError) throw error;
      throw new AuditAnchorError("key_unavailable");
    }
    if (key.length !== 32) throw new AuditAnchorError("key_unavailable");
    let receipt;
    try {
      receipt = JSON.parse(await readRegular(receiptFile));
    } catch (error) {
      if (error instanceof AuditAnchorError) throw error;
      throw new AuditAnchorError("receipt_invalid");
    }
    if (receipt?.version === 2) {
      throw new AuditAnchorError("legacy_anchor_unverified");
    }
    if (
      receipt.version !== VERSION ||
      typeof receipt.keyId !== "string" ||
      !HASH.test(receipt.keyId) ||
      !Number.isSafeInteger(receipt.sequence) ||
      receipt.sequence < 0 ||
      typeof receipt.hash !== "string" ||
      !HASH.test(receipt.hash) ||
      !receipt.legacyCutover ||
      (receipt.enrollmentSequence !== undefined &&
        (!Number.isSafeInteger(receipt.enrollmentSequence) ||
          receipt.enrollmentSequence < 0 ||
          receipt.enrollmentSequence > receipt.sequence)) ||
      (receipt.retention !== undefined &&
        (!Number.isSafeInteger(receipt.retention?.through) ||
          receipt.retention.through >= receipt.sequence)) ||
      typeof receipt.createdAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(receipt.createdAt) ||
      typeof receipt.mac !== "string" ||
      !HASH.test(receipt.mac)
    ) {
      throw new AuditAnchorError("receipt_invalid");
    }
    try {
      receipt.legacyCutover = requireLegacyCutover(receipt.legacyCutover);
      receipt.retention = requireRetention(receipt.retention);
    } catch {
      throw new AuditAnchorError("receipt_invalid");
    }
    const keyId = crypto.createHash("sha256").update(key).digest("hex");
    if (receipt.keyId !== keyId) throw new AuditAnchorError("key_changed");
    const expected = Buffer.from(macFor(key, receipt), "hex");
    if (!crypto.timingSafeEqual(Buffer.from(receipt.mac, "hex"), expected)) {
      throw new AuditAnchorError("receipt_tampered");
    }
    const receiptHash = crypto
      .createHash("sha256")
      .update(signedBytes(receipt))
      .update(expected)
      .digest("hex");
    const current = {
      key,
      receipt,
      checkpoint: { sequence: receipt.sequence, hash: receipt.hash },
      metadata: {
        sequence: receipt.sequence,
        headHash: receipt.hash,
        anchorKind: ANCHOR_KIND,
        receiptId: `${receipt.keyId}:${receipt.sequence}${receipt.retention ? `:${receipt.retention.through}` : ""}`,
        receiptHash,
        ...(receipt.enrollmentSequence !== undefined
          ? { enrollmentSequence: receipt.enrollmentSequence }
          : {}),
        ...(receipt.retention ? { retention: receipt.retention } : {}),
      },
    };
    return verifyWitness ? requireMatchingWitness(current) : current;
  }

  async function clearTransferJournal() {
    await fs.promises.rm(transferOldKeyPath, { force: true });
    await fs.promises.rm(transferOldReceiptPath, { force: true });
    const handle = await fs.promises.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function recoverTransfer() {
    const [hasOldKey, hasOldReceipt] = await Promise.all([
      exists(transferOldKeyPath),
      exists(transferOldReceiptPath),
    ]);
    if (!hasOldKey && !hasOldReceipt) return;
    const stored = await readWitness();
    const matches = (candidate) =>
      candidate &&
      stored &&
      Object.entries(witnessValue(candidate)).every(
        ([field, value]) => stored[field] === value,
      );
    const current = await loadPair({ verifyWitness: false }).catch(
      () => undefined,
    );
    if (matches(current)) {
      await clearTransferJournal();
      return;
    }
    if (hasOldKey && hasOldReceipt) {
      const previous = await loadPair({
        verifyWitness: false,
        keyFile: transferOldKeyPath,
        receiptFile: transferOldReceiptPath,
      }).catch(() => undefined);
      if (matches(previous)) {
        await atomicPrivateWrite(
          keyPath,
          await readRegular(transferOldKeyPath),
        );
        await atomicPrivateWrite(
          receiptPath,
          await readRegular(transferOldReceiptPath),
        );
        await clearTransferJournal();
        return;
      }
    }
    throw new AuditAnchorError("transfer_import_incomplete");
  }

  async function load(options) {
    await recoverTransfer();
    return loadPair(options);
  }

  function serialize(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  async function initializeFirstCheckpoint(
    head,
    legacyCutover,
    { enrollment = false } = {},
  ) {
    return serialize(async () => {
      const current = await load();
      if (current) return current.metadata;
      const initial = requireHead(head);
      const cutover = requireLegacyCutover(legacyCutover);
      assertSecureStorage(platform, safeStorage);
      const key = crypto.randomBytes(32);
      const encrypted = safeStorage.encryptString(key.toString("base64"));
      if (!Buffer.isBuffer(encrypted) || !encrypted.length) {
        throw new AuditAnchorError("secure_storage_unavailable");
      }
      // A partial first write is a hard error on restart, never a new key.
      await atomicPrivateWrite(keyPath, encrypted.toString("base64"));
      const receipt = {
        version: VERSION,
        keyId: crypto.createHash("sha256").update(key).digest("hex"),
        sequence: initial.sequence,
        hash: initial.hash,
        legacyCutover: cutover,
        createdAt: new Date().toISOString(),
        ...(enrollment ? { enrollmentSequence: initial.sequence } : {}),
      };
      receipt.mac = macFor(key, receipt);
      await atomicPrivateWrite(receiptPath, `${JSON.stringify(receipt)}\n`);
      const initialized = await load({ verifyWitness: false });
      try {
        await witness.create(witnessValue(initialized));
      } catch {
        throw new AuditAnchorError("witness_unavailable");
      }
      return (await load()).metadata;
    });
  }

  function initializeGenesis(legacyCutover) {
    return initializeFirstCheckpoint(
      { sequence: 0, hash: GENESIS_HASH },
      legacyCutover,
    );
  }

  async function readTrustedCheckpoint() {
    const current = await load();
    if (!current) throw new AuditAnchorError("uninitialized");
    return {
      ...current.checkpoint,
      legacyCutover: current.receipt.legacyCutover,
      ...(current.receipt.retention
        ? { retention: current.receipt.retention }
        : {}),
      metadata: current.metadata,
    };
  }

  async function persistCheckpoint(head) {
    const next = requireHead(head);
    return serialize(async () => {
      const current = await load();
      if (!current) throw new AuditAnchorError("uninitialized");
      if (next.sequence < current.checkpoint.sequence) {
        throw new AuditAnchorError("rollback");
      }
      if (next.sequence === current.checkpoint.sequence) {
        if (next.hash !== current.checkpoint.hash) {
          throw new AuditAnchorError("fork");
        }
        return current.metadata;
      }
      const receipt = {
        version: VERSION,
        keyId: current.receipt.keyId,
        sequence: next.sequence,
        hash: next.hash,
        legacyCutover: current.receipt.legacyCutover,
        createdAt: new Date().toISOString(),
        ...(current.receipt.enrollmentSequence !== undefined
          ? { enrollmentSequence: current.receipt.enrollmentSequence }
          : {}),
        ...(current.receipt.retention
          ? { retention: current.receipt.retention }
          : {}),
      };
      receipt.mac = macFor(current.key, receipt);
      await atomicPrivateWrite(receiptPath, `${JSON.stringify(receipt)}\n`);
      try {
        await witness.replace(
          witnessValue(await load({ verifyWitness: false })),
        );
      } catch {
        throw new AuditAnchorError("witness_unavailable");
      }
      return (await load()).metadata;
    });
  }

  async function persistRetentionBoundary(candidate) {
    const retention = requireRetention(candidate);
    return serialize(async () => {
      const current = await load();
      if (!current) throw new AuditAnchorError("uninitialized");
      if (
        retention.through >= current.receipt.sequence ||
        retention.through <= (current.receipt.retention?.through ?? 0) ||
        ["dbEditor", "split", "retag"].some(
          (field) =>
            retention.domainMax[field] <
            (current.receipt.retention?.domainMax[field] ??
              current.receipt.legacyCutover[
                {
                  dbEditor: "dbEditorMaxId",
                  split: "splitMaxId",
                  retag: "retagMaxId",
                }[field]
              ]),
        )
      ) {
        throw new AuditAnchorError("retention_regression");
      }
      const receipt = {
        version: VERSION,
        keyId: current.receipt.keyId,
        sequence: current.receipt.sequence,
        hash: current.receipt.hash,
        legacyCutover: current.receipt.legacyCutover,
        createdAt: new Date().toISOString(),
        ...(current.receipt.enrollmentSequence !== undefined
          ? { enrollmentSequence: current.receipt.enrollmentSequence }
          : {}),
        retention,
      };
      receipt.mac = macFor(current.key, receipt);
      await atomicPrivateWrite(receiptPath, `${JSON.stringify(receipt)}\n`);
      try {
        await witness.replace(
          witnessValue(await load({ verifyWitness: false })),
        );
      } catch {
        throw new AuditAnchorError("witness_unavailable");
      }
      return (await load()).metadata;
    });
  }

  async function compareHead(head) {
    const current = await readTrustedCheckpoint();
    const candidate = requireHead(head);
    if (candidate.sequence < current.sequence) {
      throw new AuditAnchorError("rollback");
    }
    if (
      candidate.sequence === current.sequence &&
      candidate.hash !== current.hash
    ) {
      throw new AuditAnchorError("fork");
    }
    return {
      status:
        candidate.sequence === current.sequence
          ? "anchored"
          : "ahead_of_anchor",
      checkpoint: { sequence: current.sequence, hash: current.hash },
    };
  }

  async function exportProtectedTransfer(password) {
    requireTransferPassword(password);
    const current = await load();
    if (!current) throw new AuditAnchorError("uninitialized");
    const salt = crypto.randomBytes(16);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
      "aes-256-gcm",
      deriveTransferKey(password, salt),
      nonce,
    );
    cipher.setAAD(TRANSFER_AAD);
    const plaintext = Buffer.from(
      JSON.stringify({
        key: current.key.toString("base64"),
        receipt: current.receipt,
      }),
    );
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    plaintext.fill(0);
    return Buffer.from(
      JSON.stringify({
        format: "vision-audit-transfer",
        version: 1,
        kdf: "scrypt-n32768-r8-p1",
        salt: salt.toString("base64"),
        nonce: nonce.toString("base64"),
        ciphertext: encrypted.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      }),
    );
  }

  async function importProtectedTransfer(
    contents,
    password,
    { expectedCurrent } = {},
  ) {
    requireTransferPassword(password);
    if (!Buffer.isBuffer(contents) || contents.length > TRANSFER_MAX_BYTES) {
      throw new AuditAnchorError("transfer_invalid");
    }
    return serialize(async () => {
      const current = await load();
      if (
        current &&
        (!expectedCurrent ||
          current.checkpoint.sequence !== expectedCurrent.sequence ||
          current.checkpoint.hash !== expectedCurrent.hash)
      ) {
        throw new AuditAnchorError("transfer_target_not_fresh");
      }
      let payload;
      try {
        const envelope = JSON.parse(contents.toString("utf8"));
        if (
          envelope.format !== "vision-audit-transfer" ||
          envelope.version !== 1 ||
          envelope.kdf !== "scrypt-n32768-r8-p1"
        )
          throw new Error("format");
        const decode = (value, length) => {
          if (
            typeof value !== "string" ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
          )
            throw new Error("encoding");
          const bytes = Buffer.from(value, "base64");
          if (length !== undefined && bytes.length !== length)
            throw new Error("length");
          return bytes;
        };
        const decipher = crypto.createDecipheriv(
          "aes-256-gcm",
          deriveTransferKey(password, decode(envelope.salt, 16)),
          decode(envelope.nonce, 12),
        );
        decipher.setAAD(TRANSFER_AAD);
        decipher.setAuthTag(decode(envelope.tag, 16));
        payload = JSON.parse(
          Buffer.concat([
            decipher.update(decode(envelope.ciphertext)),
            decipher.final(),
          ]).toString("utf8"),
        );
      } catch {
        throw new AuditAnchorError("transfer_invalid_or_password");
      }
      let key;
      try {
        if (
          typeof payload.key !== "string" ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.key)
        ) {
          throw new Error("key");
        }
        key = Buffer.from(payload.key, "base64");
        validateTransferredReceipt(key, payload.receipt);
        assertSecureStorage(platform, safeStorage);
        const encrypted = safeStorage.encryptString(key.toString("base64"));
        if (!Buffer.isBuffer(encrypted) || !encrypted.length)
          throw new Error("storage");
        if (current) {
          await atomicPrivateWrite(
            transferOldKeyPath,
            await readRegular(keyPath),
          );
          await atomicPrivateWrite(
            transferOldReceiptPath,
            await readRegular(receiptPath),
          );
        }
        await atomicPrivateWrite(keyPath, encrypted.toString("base64"));
        await atomicPrivateWrite(
          receiptPath,
          `${JSON.stringify(payload.receipt)}\n`,
        );
        const imported = await loadPair({ verifyWitness: false });
        if (current) await witness.replace(witnessValue(imported));
        else await witness.create(witnessValue(imported));
        if (current) await clearTransferJournal();
        return (await load()).metadata;
      } catch (error) {
        if (current) await recoverTransfer();
        if (error instanceof AuditAnchorError) throw error;
        throw new AuditAnchorError("transfer_import_incomplete");
      } finally {
        key?.fill(0);
      }
    });
  }

  async function rotateKey() {
    return serialize(async () => {
      const current = await load();
      if (!current) throw new AuditAnchorError("uninitialized");
      assertSecureStorage(platform, safeStorage);
      const key = crypto.randomBytes(32);
      try {
        const encrypted = safeStorage.encryptString(key.toString("base64"));
        if (!Buffer.isBuffer(encrypted) || !encrypted.length) {
          throw new AuditAnchorError("secure_storage_unavailable");
        }
        const receipt = {
          version: VERSION,
          keyId: crypto.createHash("sha256").update(key).digest("hex"),
          sequence: current.receipt.sequence,
          hash: current.receipt.hash,
          legacyCutover: current.receipt.legacyCutover,
          createdAt: new Date().toISOString(),
          ...(current.receipt.enrollmentSequence !== undefined
            ? { enrollmentSequence: current.receipt.enrollmentSequence }
            : {}),
          ...(current.receipt.retention
            ? { retention: current.receipt.retention }
            : {}),
        };
        receipt.mac = macFor(key, receipt);
        await atomicPrivateWrite(keyPath, encrypted.toString("base64"));
        await atomicPrivateWrite(receiptPath, `${JSON.stringify(receipt)}\n`);
        const rotated = await load({ verifyWitness: false });
        try {
          await witness.replace(witnessValue(rotated));
        } catch {
          throw new AuditAnchorError("witness_unavailable");
        }
        return (await load()).metadata;
      } finally {
        key.fill(0);
      }
    });
  }

  return {
    initializeFirstCheckpoint,
    initializeGenesis,
    readTrustedCheckpoint,
    persistCheckpoint,
    persistRetentionBoundary,
    compareHead,
    exportProtectedTransfer,
    importProtectedTransfer,
    rotateKey,
  };
}

module.exports = { createAuditAnchor, AuditAnchorError, ANCHOR_KIND };
