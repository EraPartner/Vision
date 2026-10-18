// The ADR-204 phase-1 interop gate, Swift to Electron: the `native-interop` CI job
// downloads what Vision Native's Swift code wrote on macOS (NativeInteropExportTests in
// apps/native) into VISION_NATIVE_INTEROP_DIR and opens it with the Electron readers.
// Without the variable (every local and ordinary CI run) the tests are skipped.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAuditAnchor } from "../audit-anchor";
import {
  memoryWitness,
  oscryptSafeStorage,
} from "../scripts/native-audit-fixture";
import { isBundleEncrypted, openBundle } from "./bundle";

const interopDir = process.env.VISION_NATIVE_INTEROP_DIR;
const skip = interopDir
  ? false
  : "VISION_NATIVE_INTEROP_DIR is not set (the native-interop CI job sets it)";

interface ExpectedBundle {
  plain: string;
  encrypted: string;
  passphrase: string;
  deviceId: string;
  schemaHead: string;
  appVersion: string;
  createdAt: string;
  dbSql: string;
  attachments: Record<string, string>;
  frontendState: unknown;
}

interface ExpectedAudit {
  transfer: string;
  password: string;
  sequence: number;
  hash: string;
  legacyCutover: unknown;
  retention: unknown;
  receiptId: string;
  receiptHash: string;
  enrollmentSequence: number | null;
}

function expected(): { bundle: ExpectedBundle; audit: ExpectedAudit } {
  return JSON.parse(
    fs.readFileSync(path.join(interopDir ?? "", "expected.json"), "utf8"),
  );
}

function listFiles(root: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) Object.assign(files, listFiles(full, relative));
    else if (entry.isFile()) files[relative] = fs.readFileSync(full, "utf8");
    else assert.fail(`unexpected attachment entry ${relative}`);
  }
  return files;
}

async function assertBundle(
  file: string,
  passphrase: string | null,
  bundle: ExpectedBundle,
): Promise<void> {
  const opened = await openBundle(path.join(interopDir ?? "", file), {
    passphrase,
  });
  try {
    assert.equal(opened.metadata.deviceId, bundle.deviceId);
    assert.equal(opened.metadata.schemaHead, bundle.schemaHead);
    assert.equal(opened.metadata.appVersion, bundle.appVersion);
    assert.equal(opened.metadata.createdAt, bundle.createdAt);
    assert.equal(opened.metadata.bundleVersion, 1);
    assert.equal(fs.readFileSync(opened.dbSqlPath, "utf8"), bundle.dbSql);
    assert.ok(opened.attachmentsDir, "the bundle carries attachments");
    assert.deepEqual(listFiles(opened.attachmentsDir), bundle.attachments);
    assert.deepEqual(opened.frontendState, bundle.frontendState);
  } finally {
    opened.cleanup();
  }
}

test(
  "Electron opens the unencrypted bundle Vision Native wrote",
  { skip },
  async () => {
    const { bundle } = expected();
    const file = path.join(interopDir ?? "", bundle.plain);
    assert.equal(await isBundleEncrypted(file), false);
    await assertBundle(bundle.plain, null, bundle);
  },
);

test(
  "Electron opens the v2-encrypted bundle Vision Native wrote",
  { skip },
  async () => {
    const { bundle } = expected();
    const file = path.join(interopDir ?? "", bundle.encrypted);
    assert.equal(await isBundleEncrypted(file), true);
    assert.equal(
      fs.readFileSync(file).subarray(0, 10).toString("latin1"),
      "VISIONBAK2",
    );
    await assertBundle(bundle.encrypted, bundle.passphrase, bundle);
    await assert.rejects(
      openBundle(file, { passphrase: `${bundle.passphrase}-wrong` }),
    );
  },
);

test(
  "Electron imports the audit transfer Vision Native exported",
  { skip },
  async (t) => {
    const { audit } = expected();
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vision-native-interop-"),
    );
    t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
    const anchor = createAuditAnchor({
      userDataDir,
      safeStorage: oscryptSafeStorage("vision-native-interop-safe-storage"),
      witness: memoryWitness(),
      platform: "darwin",
    });
    const contents = fs.readFileSync(
      path.join(interopDir ?? "", audit.transfer),
    );
    const metadata = await anchor.importProtectedTransfer(
      contents,
      audit.password,
    );
    assert.equal(metadata.sequence, audit.sequence);
    assert.equal(metadata.headHash, audit.hash);
    assert.equal(metadata.receiptId, audit.receiptId);
    assert.equal(metadata.receiptHash, audit.receiptHash);
    assert.equal(metadata.enrollmentSequence ?? null, audit.enrollmentSequence);
    const trusted = await anchor.readTrustedCheckpoint();
    assert.deepEqual(trusted.legacyCutover, audit.legacyCutover);
    assert.deepEqual(trusted.retention ?? null, audit.retention);
  },
);
