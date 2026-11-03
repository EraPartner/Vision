/**
 * Backup Roundtrip Tests
 *
 * Tests the full create → open roundtrip of the .visionbak bundle format, plus
 * the encryption/decryption path. No database or network is required.
 *
 * The bundle module is compiled from packaging/electron/ into CommonJS under
 * packaging/electron/out/ (the vitest global setup builds it), so we
 * import it via createRequire to stay compatible with this ESM test suite.
 */

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { promises as fsp, mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { must } from "./helpers/must.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");

// The compiled CommonJS modules are loaded at run time, so their shapes are
// declared here (importing the sources' types would pull in the untyped
// yauzl dependency). Keep in step with packaging/electron/backup/.
interface BundleOptions {
  destDir: string;
  deviceId: string;
  appVersion?: string | null;
  databasePath: string;
  database: {
    schemaVersion: number;
    sqliteVersion?: string | null;
    sha256?: string | null;
    bytes?: number | null;
  };
  attachmentsDir?: string | null;
  frontendState?: unknown;
}
interface OpenedBundle {
  metadata: Readonly<Record<string, unknown>>;
  databasePath: string | null;
  dbSqlPath: string | null;
  attachmentsDir: string | null;
  frontendState: unknown;
  cleanup: () => void;
}
interface BundleModule {
  createBundle: (options: BundleOptions) => Promise<{ bundlePath: string }>;
  encryptBundle: (
    bundlePath: string,
    passphrase: string,
  ) => Promise<{ encPath: string }>;
  openBundle: (
    bundlePath: string,
    options?: { passphrase?: string | null },
  ) => Promise<OpenedBundle>;
  isBundleEncrypted: (filePath: string) => Promise<boolean>;
  BUNDLE_VERSION: number;
}
interface ZipWriter {
  append(
    name: string,
    data: string | Uint8Array,
    options?: { date?: Date; mode?: number },
  ): Promise<void>;
  file(sourcePath: string, name: string): Promise<void>;
  directory(sourceDir: string, prefix: string): Promise<void>;
  finalize(): Promise<void>;
  abort(): Promise<void>;
}
interface ZipWriterModule {
  createZipWriter: (
    filePath: string,
    options?: { level?: number; forceZip64?: boolean },
  ) => Promise<ZipWriter>;
}

const require = createRequire(import.meta.url);
const {
  createBundle,
  encryptBundle,
  openBundle,
  isBundleEncrypted,
  BUNDLE_VERSION,
} = require(
  join(REPO_ROOT, "packaging/electron/out/backup/bundle.js"),
) as BundleModule;

const { createZipWriter } = require(
  join(REPO_ROOT, "packaging/electron/out/backup/zip-writer.js"),
) as ZipWriterModule;

describe("backup bundle dependency loading", () => {
  it("keeps archive libraries unloaded until a backup path uses them", () => {
    const probe = spawnSync(
      "node",
      [
        "-e",
        `const { createRequire } = require("node:module");
const req = createRequire(process.argv[1]);
const dependencies = ["yauzl"].map((name) => req.resolve(name));
req(process.argv[2]);
for (const dependency of dependencies) {
  if (require.cache[dependency]) process.exit(1);
}`,
        __filename,
        join(REPO_ROOT, "packaging/electron/out/backup/bundle.js"),
      ],
      { encoding: "utf8" },
    );
    expect(probe.status, probe.stderr).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Shared temp root — cleaned up after all tests
// ---------------------------------------------------------------------------

const TEST_TMP = mkdtempSync(join(tmpdir(), "vision_roundtrip_"));

afterAll(() => {
  rmSync(TEST_TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Build minimal test fixtures in a subdirectory, return paths. */
async function buildFixtures(subdir: string) {
  const base = join(TEST_TMP, subdir);
  await fsp.mkdir(base, { recursive: true });

  // db.sqlite3: a small SQLite database file, as the snapshot step writes it
  const databasePath = join(base, "snapshot.sqlite3");
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE categories (id INTEGER PRIMARY KEY, general TEXT, detail TEXT);
           INSERT INTO categories VALUES (1, 'FOOD', 'Groceries');
           CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount DECIMAL_TEXT(18,2), date DATE_TEXT);
           INSERT INTO transactions VALUES (1, '-42.00', '2025-01-15');`);
  db.close();
  const database = {
    schemaVersion: 1,
    sqliteVersion: "3.53.4",
    sha256: sha256(databasePath),
    bytes: (await fsp.stat(databasePath)).size,
  };

  // attachments/ tree with two files
  const attachmentsDir = join(base, "attachments");
  await fsp.mkdir(join(attachmentsDir, "tx-001"), { recursive: true });
  await fsp.writeFile(
    join(attachmentsDir, "tx-001", "receipt.jpg"),
    Buffer.from("FAKEJPEG"),
  );
  await fsp.writeFile(
    join(attachmentsDir, "tx-001", "invoice.pdf"),
    Buffer.from("FAKEPDF"),
  );

  return { base, databasePath, database, attachmentsDir };
}

// ---------------------------------------------------------------------------
// Suite 1: plain roundtrip (no encryption)
// ---------------------------------------------------------------------------

describe("createBundle + openBundle (plain)", () => {
  it("produces a valid .visionbak and round-trips all fields", async () => {
    const { databasePath, database, attachmentsDir } =
      await buildFixtures("plain");

    const frontendState = {
      keys: {
        "vision.theme": "dark",
        "vision.language": "nl",
      },
    };

    // Arrange
    const destDir = join(TEST_TMP, "plain_out");
    const { bundlePath } = await createBundle({
      destDir,
      deviceId: "test-device",
      appVersion: "2.0.0-test",
      databasePath,
      database,
      attachmentsDir,
      frontendState,
    });

    // Assert: file exists with expected extension
    expect(bundlePath).toMatch(/\.visionbak$/);
    expect(existsSync(bundlePath)).toBe(true);

    // Act: open the bundle
    const result = await openBundle(bundlePath);

    try {
      // Metadata integrity
      expect(result.metadata.bundleVersion).toBe(BUNDLE_VERSION);
      expect(result.metadata.database).toBe("sqlite");
      expect(result.metadata.schemaVersion).toBe(1);
      expect(result.metadata.sqliteVersion).toBe("3.53.4");
      expect(result.metadata.databaseSha256).toBe(database.sha256);
      expect(result.metadata.databaseBytes).toBe(database.bytes);
      expect(result.metadata.appVersion).toBe("2.0.0-test");
      expect(result.metadata.deviceId).toBe("test-device");
      expect(result.metadata.encrypted).toBe(false);
      expect(result.metadata.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // db.sqlite3 is the same file, byte for byte
      expect(result.dbSqlPath).toBeNull();
      expect(sha256(must(result.databasePath, "databasePath"))).toBe(database.sha256);

      // attachments tree preserved
      expect(result.attachmentsDir).not.toBeNull();
      const receipt = await fsp.readFile(
        join(must(result.attachmentsDir, "attachmentsDir"), "tx-001", "receipt.jpg"),
      );
      const invoice = await fsp.readFile(
        join(must(result.attachmentsDir, "attachmentsDir"), "tx-001", "invoice.pdf"),
      );
      expect(receipt.toString()).toBe("FAKEJPEG");
      expect(invoice.toString()).toBe("FAKEPDF");

      // frontend state preserved
      expect(result.frontendState).toEqual(frontendState);
    } finally {
      result.cleanup();
    }
  });

  it("handles missing attachmentsDir gracefully (null)", async () => {
    const { databasePath, database } = await buildFixtures("no_attach");

    const destDir = join(TEST_TMP, "no_attach_out");
    const { bundlePath } = await createBundle({
      destDir,
      deviceId: "dev",
      appVersion: "1.0.0",
      databasePath,
      database,
      attachmentsDir: null,
      frontendState: null,
    });

    const result = await openBundle(bundlePath);
    try {
      expect(result.attachmentsDir).toBeNull();
      expect(result.frontendState).toBeNull();
    } finally {
      result.cleanup();
    }
  });

  it("refuses a database file that is not SQLite, and a missing schema version", async () => {
    const { base, databasePath, database } = await buildFixtures("refusals");
    const notSqlite = join(base, "db.sql");
    await fsp.writeFile(notSqlite, "-- pg_dump output\n");
    const destDir = join(TEST_TMP, "refusals_out");
    await expect(
      createBundle({ destDir, deviceId: "dev", databasePath: notSqlite, database }),
    ).rejects.toThrow(/not a SQLite database/u);
    await expect(
      createBundle({ destDir, deviceId: "dev", databasePath, database: { schemaVersion: 0 } }),
    ).rejects.toThrow(/schema version/u);
    expect(existsSync(destDir) ? await fsp.readdir(destDir) : []).toEqual([]);
  });

  it("handles non-existent attachmentsDir gracefully", async () => {
    const { databasePath, database } = await buildFixtures("missing_attach");

    const destDir = join(TEST_TMP, "missing_attach_out");
    const { bundlePath } = await createBundle({
      destDir,
      deviceId: "dev",
      appVersion: "1.0.0",
      databasePath,
      database,
      attachmentsDir: join(TEST_TMP, "does_not_exist"),
      frontendState: null,
    });

    const result = await openBundle(bundlePath);
    try {
      expect(result.attachmentsDir).toBeNull();
    } finally {
      result.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2: isBundleEncrypted detection
// ---------------------------------------------------------------------------

describe("isBundleEncrypted", () => {
  it("returns false for a plain .visionbak", async () => {
    const { databasePath, database } = await buildFixtures("enc_detect_plain");
    const destDir = join(TEST_TMP, "enc_detect_plain_out");
    const { bundlePath } = await createBundle({
      destDir,
      deviceId: "dev",
      appVersion: "1.0.0",
      databasePath,
      database,
      attachmentsDir: null,
      frontendState: null,
    });

    expect(await isBundleEncrypted(bundlePath)).toBe(false);
  });

  it("returns true for a .visionbak.enc", async () => {
    const { databasePath, database } = await buildFixtures("enc_detect_enc");
    const destDir = join(TEST_TMP, "enc_detect_enc_out");
    const { bundlePath } = await createBundle({
      destDir,
      deviceId: "dev",
      appVersion: "1.0.0",
      databasePath,
      database,
      attachmentsDir: null,
      frontendState: null,
    });

    const { encPath } = await encryptBundle(bundlePath, "test-passphrase");

    expect(await isBundleEncrypted(encPath)).toBe(true);
  });

  it("returns false for non-existent file", async () => {
    expect(
      await isBundleEncrypted(join(TEST_TMP, "does_not_exist.visionbak")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: encrypted roundtrip
// ---------------------------------------------------------------------------

describe("encryptBundle + openBundle (encrypted)", () => {
  it("round-trips through AES-256-GCM with correct passphrase", async () => {
    const { databasePath, database, attachmentsDir } =
      await buildFixtures("enc_rt");
    const frontendState = { keys: { "vision.theme": "light" } };

    const destDir = join(TEST_TMP, "enc_rt_out");
    const { bundlePath } = await createBundle({
      destDir,
      deviceId: "enc-device",
      appVersion: "2.1.0",
      databasePath,
      database,
      attachmentsDir,
      frontendState,
    });

    // Encrypt with v2 (GCM) — passphrase, per-bundle salt embedded in header.
    const passphrase = "super-secret-passphrase";
    const { encPath } = await encryptBundle(bundlePath, passphrase);

    // Original .visionbak deleted after encryption
    expect(existsSync(bundlePath)).toBe(false);
    expect(existsSync(encPath)).toBe(true);
    expect(encPath).toMatch(/\.visionbak\.enc$/);

    // Open with correct passphrase
    const result = await openBundle(encPath, { passphrase });
    try {
      expect(result.metadata.schemaVersion).toBe(1);
      expect(result.metadata.deviceId).toBe("enc-device");

      expect(sha256(must(result.databasePath, "databasePath"))).toBe(database.sha256);

      expect(result.frontendState).toEqual(frontendState);

      const receipt = await fsp.readFile(
        join(must(result.attachmentsDir, "attachmentsDir"), "tx-001", "receipt.jpg"),
      );
      expect(receipt.toString()).toBe("FAKEJPEG");
    } finally {
      result.cleanup();
    }
  });

  it("throws when opening encrypted bundle without a passphrase", async () => {
    const { databasePath, database } = await buildFixtures("enc_no_key");

    const destDir = join(TEST_TMP, "enc_no_key_out");
    const { bundlePath } = await createBundle({
      destDir,
      deviceId: "dev",
      appVersion: "1.0.0",
      databasePath,
      database,
      attachmentsDir: null,
      frontendState: null,
    });

    const { encPath } = await encryptBundle(bundlePath, "some-pass");

    await expect(openBundle(encPath)).rejects.toThrow(/encrypted/i);
  });

  it("throws when opening encrypted bundle with wrong passphrase", async () => {
    const { databasePath, database } = await buildFixtures("enc_wrong_key");

    const destDir = join(TEST_TMP, "enc_wrong_key_out");
    const { bundlePath } = await createBundle({
      destDir,
      deviceId: "dev",
      appVersion: "1.0.0",
      databasePath,
      database,
      attachmentsDir: null,
      frontendState: null,
    });

    const { encPath } = await encryptBundle(bundlePath, "correct-pass");

    await expect(
      openBundle(encPath, { passphrase: "wrong-pass" }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suite 4: error conditions
// ---------------------------------------------------------------------------

describe("openBundle error conditions", () => {
  it("throws on a file that is not a valid zip", async () => {
    const badPath = join(TEST_TMP, "bad.visionbak");
    await fsp.writeFile(badPath, "this is not a zip");

    await expect(openBundle(badPath)).rejects.toThrow();
  });

  it("throws on a zip missing db.sqlite3", async () => {
    // Build a zip with only metadata.json (no database member)
    const noDbPath = join(TEST_TMP, "no_db.visionbak");
    const archive = await createZipWriter(noDbPath);
    await archive.append(
      "metadata.json",
      JSON.stringify({
        bundleVersion: 2,
        database: "sqlite",
        schemaVersion: 1,
        appVersion: "1.0.0",
        deviceId: "dev",
        createdAt: new Date().toISOString(),
        encrypted: false,
      }),
    );
    await archive.finalize();

    await expect(openBundle(noDbPath)).rejects.toThrow(/db\.sqlite3|corrupt/i);
  });

  it("opens a Vision 2.0 bundle (db.sql) without a database, for the caller to refuse", async () => {
    const legacyPath = join(TEST_TMP, "legacy_v2.visionbak");
    const archive = await createZipWriter(legacyPath);
    await archive.append(
      "metadata.json",
      JSON.stringify({ bundleVersion: 1, schemaHead: "0005_x", appVersion: "2.0.0", deviceId: "dev", encrypted: false }),
    );
    await archive.append("db.sql", "-- pg_dump output\n");
    await archive.finalize();

    const result = await openBundle(legacyPath);
    try {
      expect(result.databasePath).toBeNull();
      expect(result.dbSqlPath).not.toBeNull();
      expect(result.metadata.bundleVersion).toBe(1);
    } finally {
      result.cleanup();
    }
  });

  it("throws on a zip missing metadata.json", async () => {
    const noMetaPath = join(TEST_TMP, "no_meta.visionbak");
    const archive = await createZipWriter(noMetaPath);
    await archive.file(
      (await buildFixtures("no_meta")).databasePath,
      "db.sqlite3",
    );
    await archive.finalize();

    await expect(openBundle(noMetaPath)).rejects.toThrow(
      /metadata\.json|corrupt/i,
    );
  });
});
