// Main-process-only local checkpoint. The encrypted key and signed receipt live
// outside PostgreSQL. Callers must verify the full database chain separately.
import crypto from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

const VERSION = 3;
const GENESIS_HASH = "0".repeat(64);
const HASH = /^[0-9a-f]{64}$/;
export const ANCHOR_KIND = "macos_keychain_witness_hmac_v3";
const TRANSFER_AAD = Buffer.from("vision-audit-transfer-v1");
const TRANSFER_MAX_BYTES = 16 * 1024;
const RECEIPT_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const RETENTION_DOMAINS = ["dbEditor", "split", "retag"] as const;
const RETENTION_LEGACY_FIELD = {
  dbEditor: "dbEditorMaxId",
  split: "splitMaxId",
  retag: "retagMaxId",
} as const;

export type Checkpoint = { sequence: number; hash: string };

export type LegacyCutover = {
  dbEditorMaxId: number;
  splitMaxId: number;
  retagMaxId: number;
};

export type RetentionBoundary = {
  through: number;
  hash: string;
  domainMax: { dbEditor: number; split: number; retag: number };
  migrationHeads: string[];
};

type UnsignedReceipt = {
  version: number;
  keyId: string;
  sequence: number;
  hash: string;
  legacyCutover: LegacyCutover;
  createdAt: string;
  enrollmentSequence?: number;
  retention?: RetentionBoundary | undefined;
};

type Receipt = UnsignedReceipt & { mac: string };

export type AnchorMetadata = {
  sequence: number;
  headHash: string;
  anchorKind: string;
  receiptId: string;
  receiptHash: string;
  enrollmentSequence?: number;
  retention?: RetentionBoundary;
};

export type TrustedCheckpoint = Checkpoint & {
  legacyCutover: LegacyCutover;
  retention?: RetentionBoundary;
  metadata: AnchorMetadata;
};

export type WitnessValue = {
  version: number;
  keyId: string;
  sequence: number;
  hash: string;
  receiptHash: string;
};

/** The secure-storage subset used here; Electron's safeStorage satisfies it. */
export interface AuditSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Independent checkpoint store (the macOS Keychain helper in production). */
export interface AuditWitness {
  read(): Promise<unknown>;
  create(value: WitnessValue): Promise<unknown>;
  replace(value: WitnessValue): Promise<unknown>;
}

export interface AuditAnchorOptions {
  userDataDir: string;
  safeStorage?: AuditSafeStorage | undefined;
  witness: AuditWitness;
  platform?: string | undefined;
}

/**
 * Inputs are validated at runtime (they may come from the database bridge or
 * IPC), so the parameters are `unknown`.
 */
export interface AuditAnchor {
  initializeFirstCheckpoint(
    head: unknown,
    legacyCutover: unknown,
    options?: { enrollment?: boolean },
  ): Promise<AnchorMetadata>;
  initializeGenesis(legacyCutover: unknown): Promise<AnchorMetadata>;
  readTrustedCheckpoint(): Promise<TrustedCheckpoint>;
  persistCheckpoint(head: unknown): Promise<AnchorMetadata>;
  persistRetentionBoundary(candidate: unknown): Promise<AnchorMetadata>;
  compareHead(head: unknown): Promise<{
    status: "anchored" | "ahead_of_anchor";
    checkpoint: Checkpoint;
  }>;
  exportProtectedTransfer(password: unknown): Promise<Buffer>;
  importProtectedTransfer(
    contents: Buffer,
    password: unknown,
    options?: { expectedCurrent?: { sequence: unknown; hash: unknown } },
  ): Promise<AnchorMetadata>;
  rotateKey(): Promise<AnchorMetadata>;
}

interface AnchorState {
  key: Buffer;
  receipt: Receipt;
  checkpoint: Checkpoint;
  metadata: AnchorMetadata;
}

interface LoadOptions {
  verifyWitness?: boolean;
  keyFile?: string;
  receiptFile?: string;
}

export class AuditAnchorError extends Error {
  code: string;

  constructor(code: string) {
    super(`Audit anchor ${code}`);
    this.name = "AuditAnchorError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function requireHead(head: unknown): Checkpoint {
  if (
    !isRecord(head) ||
    !isSafeInteger(head.sequence) ||
    head.sequence < 0 ||
    !isHash(head.hash)
  ) {
    throw new TypeError("Invalid audit chain head");
  }
  return { sequence: head.sequence, hash: head.hash };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function requireLegacyCutover(cutover: unknown): LegacyCutover {
  if (!isRecord(cutover)) throw new TypeError("Invalid audit legacy cutover");
  const { dbEditorMaxId, splitMaxId, retagMaxId } = cutover;
  if (
    !isNonNegativeSafeInteger(dbEditorMaxId) ||
    !isNonNegativeSafeInteger(splitMaxId) ||
    !isNonNegativeSafeInteger(retagMaxId)
  ) {
    throw new TypeError("Invalid audit legacy cutover");
  }
  return { dbEditorMaxId, splitMaxId, retagMaxId };
}

function isMigrationHeads(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 16 &&
    value.every(
      (head) => typeof head === "string" && /^[0-9a-z_]{1,64}$/.test(head),
    ) &&
    JSON.stringify(value) === JSON.stringify([...value].sort())
  );
}

function requireRetention(retention: unknown): RetentionBoundary | undefined {
  return retention === undefined ? undefined : parseRetention(retention);
}

function parseRetention(retention: unknown): RetentionBoundary {
  if (
    !isRecord(retention) ||
    !isSafeInteger(retention.through) ||
    retention.through < 1 ||
    !isHash(retention.hash) ||
    !isMigrationHeads(retention.migrationHeads) ||
    !isRecord(retention.domainMax)
  )
    throw new TypeError("Invalid audit retention boundary");
  const { dbEditor, split, retag } = retention.domainMax;
  if (
    !isNonNegativeSafeInteger(dbEditor) ||
    !isNonNegativeSafeInteger(split) ||
    !isNonNegativeSafeInteger(retag)
  )
    throw new TypeError("Invalid audit retention boundary");
  return {
    through: retention.through,
    hash: retention.hash,
    domainMax: { dbEditor, split, retag },
    migrationHeads: [...retention.migrationHeads],
  };
}

function assertSecureStorage(
  platform: string,
  safeStorage: AuditSafeStorage | undefined,
): asserts safeStorage is AuditSafeStorage {
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

/**
 * The MAC input. Accepts a raw record so a transferred receipt is verified
 * exactly as its sender serialized it.
 */
function signedBytes(receipt: Readonly<Record<string, unknown>>): Buffer {
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

function macFor(
  key: Buffer,
  receipt: Readonly<Record<string, unknown>>,
): string {
  return crypto
    .createHmac("sha256", key)
    .update(signedBytes(receipt))
    .digest("hex");
}

function requireTransferPassword(
  password: unknown,
): asserts password is string {
  if (
    typeof password !== "string" ||
    password.length < 16 ||
    password.length > 1024
  ) {
    throw new AuditAnchorError("transfer_password_invalid");
  }
}

function validateTransferredReceipt(key: Buffer, receipt: unknown): void {
  if (
    !Buffer.isBuffer(key) ||
    key.length !== 32 ||
    !isRecord(receipt) ||
    receipt.version !== VERSION ||
    receipt.keyId !== crypto.createHash("sha256").update(key).digest("hex") ||
    !isSafeInteger(receipt.sequence) ||
    receipt.sequence < 0 ||
    !isHash(receipt.hash) ||
    typeof receipt.createdAt !== "string" ||
    !RECEIPT_TIME.test(receipt.createdAt) ||
    !isHash(receipt.mac) ||
    (receipt.enrollmentSequence !== undefined &&
      (!isSafeInteger(receipt.enrollmentSequence) ||
        receipt.enrollmentSequence < 0 ||
        receipt.enrollmentSequence > receipt.sequence))
  )
    throw new AuditAnchorError("transfer_invalid");
  try {
    requireLegacyCutover(receipt.legacyCutover);
    const retention = requireRetention(receipt.retention);
    if (retention !== undefined && retention.through >= receipt.sequence) {
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

function deriveTransferKey(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.lstat(file);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readRegular(file: string): Promise<string> {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile()) throw new AuditAnchorError("invalid_file_type");
  return fs.promises.readFile(file, "utf8");
}

async function atomicPrivateWrite(
  file: string,
  contents: string,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let handle: FileHandle | undefined;
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

/** Validate a parsed checkpoint.json and return it with normalized fields. */
function requireStoredReceipt(parsed: unknown): Receipt {
  if (isRecord(parsed) && parsed.version === 2) {
    throw new AuditAnchorError("legacy_anchor_unverified");
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== VERSION ||
    !isHash(parsed.keyId) ||
    !isSafeInteger(parsed.sequence) ||
    parsed.sequence < 0 ||
    !isHash(parsed.hash) ||
    !parsed.legacyCutover ||
    (parsed.enrollmentSequence !== undefined &&
      (!isSafeInteger(parsed.enrollmentSequence) ||
        parsed.enrollmentSequence < 0 ||
        parsed.enrollmentSequence > parsed.sequence)) ||
    (parsed.retention !== undefined &&
      (!isRecord(parsed.retention) ||
        !isSafeInteger(parsed.retention.through) ||
        parsed.retention.through >= parsed.sequence)) ||
    typeof parsed.createdAt !== "string" ||
    !RECEIPT_TIME.test(parsed.createdAt) ||
    !isHash(parsed.mac)
  ) {
    throw new AuditAnchorError("receipt_invalid");
  }
  const { version, keyId, sequence, hash, createdAt, enrollmentSequence, mac } =
    parsed;
  let legacyCutover: LegacyCutover;
  let retention: RetentionBoundary | undefined;
  try {
    legacyCutover = requireLegacyCutover(parsed.legacyCutover);
    retention = requireRetention(parsed.retention);
  } catch {
    throw new AuditAnchorError("receipt_invalid");
  }
  // Same field order as the receipts this module writes.
  return {
    version,
    keyId,
    sequence,
    hash,
    legacyCutover,
    createdAt,
    ...(isSafeInteger(enrollmentSequence) ? { enrollmentSequence } : {}),
    retention,
    mac,
  };
}

export function createAuditAnchor({
  userDataDir,
  safeStorage,
  witness,
  platform = process.platform,
}: AuditAnchorOptions): AuditAnchor {
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
  let queue: Promise<unknown> = Promise.resolve();

  async function readWitness(): Promise<unknown> {
    if (!witness || typeof witness.read !== "function") {
      throw new AuditAnchorError("witness_unavailable");
    }
    try {
      return await witness.read();
    } catch {
      throw new AuditAnchorError("witness_unavailable");
    }
  }

  function witnessValue(current: AnchorState): WitnessValue {
    return {
      version: VERSION,
      keyId: current.receipt.keyId,
      sequence: current.receipt.sequence,
      hash: current.receipt.hash,
      receiptHash: current.metadata.receiptHash,
    };
  }

  function witnessMatches(stored: unknown, current: AnchorState): boolean {
    return (
      isRecord(stored) &&
      Object.entries(witnessValue(current)).every(
        ([field, value]) => stored[field] === value,
      )
    );
  }

  // A reload right after this module wrote both files; the original failed
  // with a TypeError if they vanished in between.
  function requireLoaded(current: AnchorState | undefined): AnchorState {
    if (!current) throw new TypeError("Audit anchor files disappeared");
    return current;
  }

  async function requireMatchingWitness(
    current: AnchorState,
  ): Promise<AnchorState> {
    const stored = await readWitness();
    if (!stored) throw new AuditAnchorError("witness_missing");
    if (!witnessMatches(stored, current)) {
      throw new AuditAnchorError("witness_mismatch");
    }
    return current;
  }

  async function loadPair({
    verifyWitness = true,
    keyFile = keyPath,
    receiptFile = receiptPath,
  }: LoadOptions = {}): Promise<AnchorState | undefined> {
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
    let key: Buffer;
    try {
      const encoded = await readRegular(keyFile);
      if (!BASE64.test(encoded)) {
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readRegular(receiptFile));
    } catch (error) {
      if (error instanceof AuditAnchorError) throw error;
      throw new AuditAnchorError("receipt_invalid");
    }
    const receipt = requireStoredReceipt(parsed);
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
    const current: AnchorState = {
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

  async function clearTransferJournal(): Promise<void> {
    await fs.promises.rm(transferOldKeyPath, { force: true });
    await fs.promises.rm(transferOldReceiptPath, { force: true });
    const handle = await fs.promises.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function recoverTransfer(): Promise<void> {
    const [hasOldKey, hasOldReceipt] = await Promise.all([
      exists(transferOldKeyPath),
      exists(transferOldReceiptPath),
    ]);
    if (!hasOldKey && !hasOldReceipt) return;
    const stored = await readWitness();
    const matches = (candidate: AnchorState | undefined) =>
      candidate !== undefined && witnessMatches(stored, candidate);
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

  async function load(options?: LoadOptions): Promise<AnchorState | undefined> {
    await recoverTransfer();
    return loadPair(options);
  }

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  async function initializeFirstCheckpoint(
    head: unknown,
    legacyCutover: unknown,
    { enrollment = false }: { enrollment?: boolean } = {},
  ): Promise<AnchorMetadata> {
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
      const unsigned: UnsignedReceipt = {
        version: VERSION,
        keyId: crypto.createHash("sha256").update(key).digest("hex"),
        sequence: initial.sequence,
        hash: initial.hash,
        legacyCutover: cutover,
        createdAt: new Date().toISOString(),
        ...(enrollment ? { enrollmentSequence: initial.sequence } : {}),
      };
      const receipt: Receipt = { ...unsigned, mac: macFor(key, unsigned) };
      await atomicPrivateWrite(receiptPath, `${JSON.stringify(receipt)}\n`);
      const initialized = await load({ verifyWitness: false });
      try {
        await witness.create(witnessValue(requireLoaded(initialized)));
      } catch {
        throw new AuditAnchorError("witness_unavailable");
      }
      return requireLoaded(await load()).metadata;
    });
  }

  function initializeGenesis(legacyCutover: unknown): Promise<AnchorMetadata> {
    return initializeFirstCheckpoint(
      { sequence: 0, hash: GENESIS_HASH },
      legacyCutover,
    );
  }

  async function readTrustedCheckpoint(): Promise<TrustedCheckpoint> {
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

  async function persistCheckpoint(head: unknown): Promise<AnchorMetadata> {
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
      const unsigned: UnsignedReceipt = {
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
      const receipt: Receipt = {
        ...unsigned,
        mac: macFor(current.key, unsigned),
      };
      await atomicPrivateWrite(receiptPath, `${JSON.stringify(receipt)}\n`);
      try {
        await witness.replace(
          witnessValue(requireLoaded(await load({ verifyWitness: false }))),
        );
      } catch {
        throw new AuditAnchorError("witness_unavailable");
      }
      return requireLoaded(await load()).metadata;
    });
  }

  async function persistRetentionBoundary(
    candidate: unknown,
  ): Promise<AnchorMetadata> {
    const retention = parseRetention(candidate);
    return serialize(async () => {
      const current = await load();
      if (!current) throw new AuditAnchorError("uninitialized");
      const previous = current.receipt.retention;
      if (
        retention.through >= current.receipt.sequence ||
        retention.through <= (previous?.through ?? 0) ||
        RETENTION_DOMAINS.some(
          (field) =>
            retention.domainMax[field] <
            (previous?.domainMax[field] ??
              current.receipt.legacyCutover[RETENTION_LEGACY_FIELD[field]]),
        )
      ) {
        throw new AuditAnchorError("retention_regression");
      }
      const unsigned: UnsignedReceipt = {
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
      const receipt: Receipt = {
        ...unsigned,
        mac: macFor(current.key, unsigned),
      };
      await atomicPrivateWrite(receiptPath, `${JSON.stringify(receipt)}\n`);
      try {
        await witness.replace(
          witnessValue(requireLoaded(await load({ verifyWitness: false }))),
        );
      } catch {
        throw new AuditAnchorError("witness_unavailable");
      }
      return requireLoaded(await load()).metadata;
    });
  }

  async function compareHead(head: unknown): Promise<{
    status: "anchored" | "ahead_of_anchor";
    checkpoint: Checkpoint;
  }> {
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

  async function exportProtectedTransfer(password: unknown): Promise<Buffer> {
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
    contents: Buffer,
    password: unknown,
    {
      expectedCurrent,
    }: { expectedCurrent?: { sequence: unknown; hash: unknown } } = {},
  ): Promise<AnchorMetadata> {
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
      let payload: unknown;
      try {
        const envelope: unknown = JSON.parse(contents.toString("utf8"));
        if (
          !isRecord(envelope) ||
          envelope.format !== "vision-audit-transfer" ||
          envelope.version !== 1 ||
          envelope.kdf !== "scrypt-n32768-r8-p1"
        )
          throw new Error("format");
        const decode = (value: unknown, length?: number) => {
          if (typeof value !== "string" || !BASE64.test(value))
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
      let key: Buffer | undefined;
      try {
        if (
          !isRecord(payload) ||
          typeof payload.key !== "string" ||
          !BASE64.test(payload.key)
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
        // Written exactly as the sender serialized it; the MAC covers it.
        await atomicPrivateWrite(
          receiptPath,
          `${JSON.stringify(payload.receipt)}\n`,
        );
        const imported = requireLoaded(
          await loadPair({ verifyWitness: false }),
        );
        if (current) await witness.replace(witnessValue(imported));
        else await witness.create(witnessValue(imported));
        if (current) await clearTransferJournal();
        return requireLoaded(await load()).metadata;
      } catch (error) {
        if (current) await recoverTransfer();
        if (error instanceof AuditAnchorError) throw error;
        throw new AuditAnchorError("transfer_import_incomplete");
      } finally {
        key?.fill(0);
      }
    });
  }

  async function rotateKey(): Promise<AnchorMetadata> {
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
        const unsigned: UnsignedReceipt = {
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
        const receipt: Receipt = { ...unsigned, mac: macFor(key, unsigned) };
        await atomicPrivateWrite(keyPath, encrypted.toString("base64"));
        await atomicPrivateWrite(receiptPath, `${JSON.stringify(receipt)}\n`);
        const rotated = await load({ verifyWitness: false });
        try {
          await witness.replace(witnessValue(requireLoaded(rotated)));
        } catch {
          throw new AuditAnchorError("witness_unavailable");
        }
        return requireLoaded(await load()).metadata;
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
