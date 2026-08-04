import { describe, expect, it } from 'vitest';

import { ELECTRON_ERROR_KEYS, electronErrorToMessage } from '@/lib/api/electronErrorMessage';

/** Identity translate — assertions are on keys, not copy. */
const t = (key: string) => key;

describe('electronErrorToMessage', () => {
    describe('unwraps the IPC machinery', () => {
        it("strips Electron's remote-method wrapper and keeps the real message", () => {
            const err = new Error(
                "Error invoking remote method 'backup:run': Backup destination is not writable",
            );
            expect(electronErrorToMessage(err, t)).toBe('Backup destination is not writable');
        });

        it('strips a leading Error: prefix left by String(err)', () => {
            expect(electronErrorToMessage('Error: Backup destination is not writable', t)).toBe(
                'Backup destination is not writable',
            );
        });

        it('strips a doubled prefix from a String(err) round-trip through IPC', () => {
            const raw = "Error: Error invoking remote method 'backup:restore': Error: Archive is not a Vision backup";
            expect(electronErrorToMessage(raw, t)).toBe('Archive is not a Vision backup');
        });

        it('never leaks the channel name', () => {
            const raw = "Error invoking remote method 'backup:set-passphrase': something";
            expect(electronErrorToMessage(raw, t)).not.toContain('backup:set-passphrase');
        });
    });

    describe('swallows machine shapes that carry host detail', () => {
        it('maps ENOENT (which embeds an absolute path) to generic copy', () => {
            const raw = "ENOENT: no such file or directory, open '/Users/someone/Documents/vision.visionbak'";
            const msg = electronErrorToMessage(raw, t);
            expect(msg).toBe(ELECTRON_ERROR_KEYS.notFound);
            expect(msg).not.toContain('/Users/someone');
        });

        it.each([
            ['EACCES', "EACCES: permission denied, open '/private/var/x'"],
            ['EPERM', "EPERM: operation not permitted, unlink '/private/var/x'"],
        ])('maps %s to permission copy', (_label, raw) => {
            expect(electronErrorToMessage(raw, t)).toBe(ELECTRON_ERROR_KEYS.permission);
        });

        it.each([
            ['ENOSPC', 'ENOSPC: no space left on device, write'],
            ['EDQUOT', 'EDQUOT: disk quota exceeded, write'],
        ])('maps %s to disk-full copy', (_label, raw) => {
            expect(electronErrorToMessage(raw, t)).toBe(ELECTRON_ERROR_KEYS.diskFull);
        });

        it('maps the workDir sentinel to not-ready copy', () => {
            expect(electronErrorToMessage('workDir not set', t)).toBe(ELECTRON_ERROR_KEYS.notReady);
        });

        it('maps the sender-guard sentinel to generic copy', () => {
            expect(electronErrorToMessage('Unauthorized sender for backup:run', t)).toBe(
                ELECTRON_ERROR_KEYS.unknown,
            );
        });
    });

    describe('keeps main-process copy that a user can act on', () => {
        it('passes an authored message through unchanged', () => {
            const authored = 'Shell update not available in embedded mode — use Docker image update instead.';
            expect(electronErrorToMessage(authored, t)).toBe(authored);
        });

        it('passes an authored message through after unwrapping', () => {
            const raw = "Error invoking remote method 'update:install-shell': Shell update not available in embedded mode";
            expect(electronErrorToMessage(raw, t)).toBe('Shell update not available in embedded mode');
        });
    });

    describe('falls back for anything with no message', () => {
        it.each([[undefined], [null], [''], ['   '], [{}], [42], [{ message: 123 }]])(
            '%s',
            (value) => {
                expect(electronErrorToMessage(value, t)).toBe(ELECTRON_ERROR_KEYS.unknown);
            },
        );
    });
});
