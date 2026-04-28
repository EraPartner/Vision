/**
 * Backup Roundtrip Tests
 *
 * Tests the full create → open roundtrip of the .visionbak bundle format, plus
 * the encryption/decryption path.  No Docker, database, or network required.
 *
 * The bundle module lives in packaging/electron/ and uses CommonJS, so we
 * import it via createRequire to stay compatible with this ESM test suite.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { promises as fsp, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../..');

const require = createRequire(import.meta.url);
const {
    createBundle,
    encryptBundle,
    openBundle,
    isBundleEncrypted,
    BUNDLE_VERSION,
} = require(join(REPO_ROOT, 'packaging/electron/backup/bundle.js'));

// ---------------------------------------------------------------------------
// Shared temp root — cleaned up after all tests
// ---------------------------------------------------------------------------

const TEST_TMP = mkdtempSync(join(tmpdir(), 'vision_roundtrip_'));

afterAll(() => {
    rmSync(TEST_TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build minimal test fixtures in a subdirectory, return paths. */
async function buildFixtures(subdir) {
    const base = join(TEST_TMP, subdir);
    await fsp.mkdir(base, { recursive: true });

    // db.sql — realistic pg_dump header + a few INSERT statements
    const dbSqlPath = join(base, 'db.sql');
    const dbSqlContent = [
        '-- pg_dump output',
        'SET standard_conforming_strings = on;',
        "INSERT INTO categories (id, general, detail) VALUES (1, 'FOOD', 'Groceries');",
        "INSERT INTO transactions (id, amount, date) VALUES (1, -42.00, '2025-01-15');",
    ].join('\n');
    await fsp.writeFile(dbSqlPath, dbSqlContent, 'utf8');

    // attachments/ tree with two files
    const attachmentsDir = join(base, 'attachments');
    await fsp.mkdir(join(attachmentsDir, 'tx-001'), { recursive: true });
    await fsp.writeFile(join(attachmentsDir, 'tx-001', 'receipt.jpg'), Buffer.from('FAKEJPEG'));
    await fsp.writeFile(join(attachmentsDir, 'tx-001', 'invoice.pdf'), Buffer.from('FAKEPDF'));

    return { base, dbSqlPath, dbSqlContent, attachmentsDir };
}

// ---------------------------------------------------------------------------
// Suite 1: plain roundtrip (no encryption)
// ---------------------------------------------------------------------------

describe('createBundle + openBundle (plain)', () => {
    it('produces a valid .visionbak and round-trips all fields', async () => {
        const { dbSqlPath, dbSqlContent, attachmentsDir } = await buildFixtures('plain');

        const frontendState = {
            keys: {
                'vision.theme': 'dark',
                'vision.language': 'nl',
            },
        };

        // Arrange
        const destDir = join(TEST_TMP, 'plain_out');
        const { bundlePath } = await createBundle({
            destDir,
            deviceId: 'test-device',
            schemaHead: '0015_test_migration',
            appVersion: '2.0.0-test',
            dbSqlPath,
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
            expect(result.metadata.schemaHead).toBe('0015_test_migration');
            expect(result.metadata.appVersion).toBe('2.0.0-test');
            expect(result.metadata.deviceId).toBe('test-device');
            expect(result.metadata.encrypted).toBe(false);
            expect(result.metadata.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

            // db.sql content
            const restoredSql = await fsp.readFile(result.dbSqlPath, 'utf8');
            expect(restoredSql).toBe(dbSqlContent);

            // attachments tree preserved
            expect(result.attachmentsDir).not.toBeNull();
            const receipt = await fsp.readFile(
                join(result.attachmentsDir, 'tx-001', 'receipt.jpg'),
            );
            const invoice = await fsp.readFile(
                join(result.attachmentsDir, 'tx-001', 'invoice.pdf'),
            );
            expect(receipt.toString()).toBe('FAKEJPEG');
            expect(invoice.toString()).toBe('FAKEPDF');

            // frontend state preserved
            expect(result.frontendState).toEqual(frontendState);
        } finally {
            result.cleanup();
        }
    });

    it('handles missing attachmentsDir gracefully (null)', async () => {
        const { dbSqlPath } = await buildFixtures('no_attach');

        const destDir = join(TEST_TMP, 'no_attach_out');
        const { bundlePath } = await createBundle({
            destDir,
            deviceId: 'dev',
            schemaHead: '',
            appVersion: '1.0.0',
            dbSqlPath,
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

    it('handles non-existent attachmentsDir gracefully', async () => {
        const { dbSqlPath } = await buildFixtures('missing_attach');

        const destDir = join(TEST_TMP, 'missing_attach_out');
        const { bundlePath } = await createBundle({
            destDir,
            deviceId: 'dev',
            schemaHead: '',
            appVersion: '1.0.0',
            dbSqlPath,
            attachmentsDir: join(TEST_TMP, 'does_not_exist'),
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

describe('isBundleEncrypted', () => {
    it('returns false for a plain .visionbak', async () => {
        const { dbSqlPath } = await buildFixtures('enc_detect_plain');
        const destDir = join(TEST_TMP, 'enc_detect_plain_out');
        const { bundlePath } = await createBundle({
            destDir,
            deviceId: 'dev',
            schemaHead: '',
            appVersion: '1.0.0',
            dbSqlPath,
            attachmentsDir: null,
            frontendState: null,
        });

        expect(await isBundleEncrypted(bundlePath)).toBe(false);
    });

    it('returns true for a .visionbak.enc', async () => {
        const { dbSqlPath } = await buildFixtures('enc_detect_enc');
        const destDir = join(TEST_TMP, 'enc_detect_enc_out');
        const { bundlePath } = await createBundle({
            destDir,
            deviceId: 'dev',
            schemaHead: '',
            appVersion: '1.0.0',
            dbSqlPath,
            attachmentsDir: null,
            frontendState: null,
        });

        const { encPath } = await encryptBundle(bundlePath, 'test-passphrase');

        expect(await isBundleEncrypted(encPath)).toBe(true);
    });

    it('returns false for non-existent file', async () => {
        expect(await isBundleEncrypted(join(TEST_TMP, 'does_not_exist.visionbak'))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Suite 3: encrypted roundtrip
// ---------------------------------------------------------------------------

describe('encryptBundle + openBundle (encrypted)', () => {
    it('round-trips through AES-256-GCM with correct passphrase', async () => {
        const { dbSqlPath, dbSqlContent, attachmentsDir } = await buildFixtures('enc_rt');
        const frontendState = { keys: { 'vision.theme': 'light' } };

        const destDir = join(TEST_TMP, 'enc_rt_out');
        const { bundlePath } = await createBundle({
            destDir,
            deviceId: 'enc-device',
            schemaHead: '0020_enc_migration',
            appVersion: '2.1.0',
            dbSqlPath,
            attachmentsDir,
            frontendState,
        });

        // Encrypt with v2 (GCM) — passphrase, per-bundle salt embedded in header.
        const passphrase = 'super-secret-passphrase';
        const { encPath } = await encryptBundle(bundlePath, passphrase);

        // Original .visionbak deleted after encryption
        expect(existsSync(bundlePath)).toBe(false);
        expect(existsSync(encPath)).toBe(true);
        expect(encPath).toMatch(/\.visionbak\.enc$/);

        // Open with correct passphrase
        const result = await openBundle(encPath, { passphrase });
        try {
            expect(result.metadata.schemaHead).toBe('0020_enc_migration');
            expect(result.metadata.deviceId).toBe('enc-device');

            const restoredSql = await fsp.readFile(result.dbSqlPath, 'utf8');
            expect(restoredSql).toBe(dbSqlContent);

            expect(result.frontendState).toEqual(frontendState);

            const receipt = await fsp.readFile(
                join(result.attachmentsDir, 'tx-001', 'receipt.jpg'),
            );
            expect(receipt.toString()).toBe('FAKEJPEG');
        } finally {
            result.cleanup();
        }
    });

    it('throws when opening encrypted bundle without a passphrase', async () => {
        const { dbSqlPath } = await buildFixtures('enc_no_key');

        const destDir = join(TEST_TMP, 'enc_no_key_out');
        const { bundlePath } = await createBundle({
            destDir,
            deviceId: 'dev',
            schemaHead: '',
            appVersion: '1.0.0',
            dbSqlPath,
            attachmentsDir: null,
            frontendState: null,
        });

        const { encPath } = await encryptBundle(bundlePath, 'some-pass');

        await expect(openBundle(encPath)).rejects.toThrow(/encrypted/i);
    });

    it('throws when opening encrypted bundle with wrong passphrase', async () => {
        const { dbSqlPath } = await buildFixtures('enc_wrong_key');

        const destDir = join(TEST_TMP, 'enc_wrong_key_out');
        const { bundlePath } = await createBundle({
            destDir,
            deviceId: 'dev',
            schemaHead: '',
            appVersion: '1.0.0',
            dbSqlPath,
            attachmentsDir: null,
            frontendState: null,
        });

        const { encPath } = await encryptBundle(bundlePath, 'correct-pass');

        await expect(openBundle(encPath, { passphrase: 'wrong-pass' })).rejects.toThrow();
    });
});

// ---------------------------------------------------------------------------
// Suite 4: error conditions
// ---------------------------------------------------------------------------

describe('openBundle error conditions', () => {
    it('throws on a file that is not a valid zip', async () => {
        const badPath = join(TEST_TMP, 'bad.visionbak');
        await fsp.writeFile(badPath, 'this is not a zip');

        await expect(openBundle(badPath)).rejects.toThrow();
    });

    it('throws on a zip missing db.sql', async () => {
        // Build a zip with only metadata.json (no db.sql)
        const archiver = require(join(REPO_ROOT, 'packaging/electron/node_modules/archiver'));
        const { createWriteStream } = require('node:fs');

        const noDbPath = join(TEST_TMP, 'no_db.visionbak');
        await new Promise((resolve, reject) => {
            const output = createWriteStream(noDbPath);
            const archive = archiver('zip');
            archive.on('error', reject);
            output.on('close', resolve);
            archive.pipe(output);
            archive.append(JSON.stringify({ bundleVersion: 1, schemaHead: '', appVersion: '1.0.0', deviceId: 'dev', createdAt: new Date().toISOString(), encrypted: false }), { name: 'metadata.json' });
            archive.finalize();
        });

        await expect(openBundle(noDbPath)).rejects.toThrow(/db\.sql|corrupt/i);
    });

    it('throws on a zip missing metadata.json', async () => {
        const archiver = require(join(REPO_ROOT, 'packaging/electron/node_modules/archiver'));
        const { createWriteStream } = require('node:fs');

        const noMetaPath = join(TEST_TMP, 'no_meta.visionbak');
        await new Promise((resolve, reject) => {
            const output = createWriteStream(noMetaPath);
            const archive = archiver('zip');
            archive.on('error', reject);
            output.on('close', resolve);
            archive.pipe(output);
            archive.append('SELECT 1;', { name: 'db.sql' });
            archive.finalize();
        });

        await expect(openBundle(noMetaPath)).rejects.toThrow(/metadata\.json|corrupt/i);
    });
});
