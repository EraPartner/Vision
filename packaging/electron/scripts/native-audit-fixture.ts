#!/usr/bin/env node
// Writes the Electron audit-anchor fixture Vision Native's byte-compatibility tests
// read (apps/native/Tests/VisionNativeCoreTests/Fixtures/audit/). It drives the real
// createAuditAnchor with a fake Keychain witness and a fake safeStorage that encodes
// exactly like Electron's on macOS (Chromium OSCrypt "v10": AES-128-CBC, IV of 16
// spaces, PBKDF2-HMAC-SHA1(password, "saltysalt", 1003) to 16 bytes), using a fixed,
// synthetic "Safe Storage" password. The key is random on every run, so rerunning
// replaces every file; commit them together.
//
//   bun packaging/electron/build.ts
//   node packaging/electron/out/scripts/native-audit-fixture.js <output directory>
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAuditAnchor,
  type AuditSafeStorage,
  type WitnessValue,
} from "../audit-anchor";

export const FIXTURE_SAFE_STORAGE_PASSWORD =
  "vision-native-audit-fixture-safe-storage";
export const FIXTURE_TRANSFER_PASSWORD = "vision-native-audit-fixture-transfer";

const V10 = Buffer.from("v10");
const IV = Buffer.alloc(16, 0x20);

function oscryptKey(password: string): Buffer {
  return crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

/** Electron safeStorage as Chromium's macOS OSCrypt encodes it. */
export function oscryptSafeStorage(password: string): AuditSafeStorage {
  const key = oscryptKey(password);
  return {
    isEncryptionAvailable: () => true,
    encryptString(plainText: string): Buffer {
      const cipher = crypto.createCipheriv("aes-128-cbc", key, IV);
      return Buffer.concat([
        V10,
        cipher.update(plainText, "utf8"),
        cipher.final(),
      ]);
    },
    decryptString(encrypted: Buffer): string {
      if (!encrypted.subarray(0, 3).equals(V10)) throw new Error("not v10");
      const decipher = crypto.createDecipheriv("aes-128-cbc", key, IV);
      return Buffer.concat([
        decipher.update(encrypted.subarray(3)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

/** The Keychain witness, kept in memory as the JSON text the helper stores. */
export function memoryWitness() {
  let stored: string | undefined;
  return {
    read: async () => (stored === undefined ? null : JSON.parse(stored)),
    create: async (value: WitnessValue) => {
      if (stored !== undefined) throw new Error("audit_witness_already_exists");
      stored = JSON.stringify(value);
    },
    replace: async (value: WitnessValue) => {
      stored = JSON.stringify(value);
    },
    text: () => stored,
  };
}

const hash = (label: string) =>
  crypto.createHash("sha256").update(label).digest("hex");

export async function writeFixture(outputDirectory: string): Promise<void> {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vision-audit-fixture-"),
  );
  try {
    const witness = memoryWitness();
    const anchor = createAuditAnchor({
      userDataDir,
      safeStorage: oscryptSafeStorage(FIXTURE_SAFE_STORAGE_PASSWORD),
      witness,
      platform: "darwin",
    });
    await anchor.initializeFirstCheckpoint(
      { sequence: 5, hash: hash("fixture head 5") },
      { dbEditorMaxId: 3, splitMaxId: 1, retagMaxId: 0 },
      { enrollment: true },
    );
    await anchor.persistCheckpoint({
      sequence: 12,
      hash: hash("fixture head 12"),
    });
    await anchor.persistRetentionBoundary({
      through: 4,
      hash: hash("fixture retention 4"),
      domainMax: { dbEditor: 7, split: 2, retag: 0 },
      migrationHeads: ["0158_audit_chain", "0161_audit_retention"],
    });
    const transfer = await anchor.exportProtectedTransfer(
      FIXTURE_TRANSFER_PASSWORD,
    );
    const trusted = await anchor.readTrustedCheckpoint();
    const anchorDirectory = path.join(userDataDir, "audit-anchor");
    fs.mkdirSync(outputDirectory, { recursive: true });
    for (const name of ["key.enc", "checkpoint.json"]) {
      fs.copyFileSync(
        path.join(anchorDirectory, name),
        path.join(outputDirectory, name),
      );
    }
    fs.writeFileSync(
      path.join(outputDirectory, "witness.json"),
      witness.text() ?? "",
    );
    fs.writeFileSync(path.join(outputDirectory, "transfer.vat"), transfer);
    fs.writeFileSync(
      path.join(outputDirectory, "expected.json"),
      `${JSON.stringify(
        {
          safeStoragePassword: FIXTURE_SAFE_STORAGE_PASSWORD,
          transferPassword: FIXTURE_TRANSFER_PASSWORD,
          trusted,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const output = process.argv[2];
  if (!output) {
    console.error("Usage: native-audit-fixture.js <output directory>");
    process.exitCode = 1;
  } else {
    writeFixture(path.resolve(output)).catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
