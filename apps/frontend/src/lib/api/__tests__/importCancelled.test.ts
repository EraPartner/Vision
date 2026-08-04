import { describe, expect, it } from 'vitest';

import { ImportCancelledError, isImportCancelled } from '@/lib/api/importCancelled';

describe('isImportCancelled', () => {
    it('recognizes the cancellation error the import clients throw', () => {
        expect(isImportCancelled(new ImportCancelledError())).toBe(true);
    });

    it('recognizes a bare AbortError that was never wrapped', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        expect(isImportCancelled(err)).toBe(true);
    });

    it('recognizes a DOMException-shaped abort, which does not extend Error', () => {
        expect(isImportCancelled({ name: 'AbortError' })).toBe(true);
    });

    it('preserves the original error as the cause', () => {
        const cause = new Error('underlying');
        expect(new ImportCancelledError({ cause }).cause).toBe(cause);
    });

    it.each([
        ['a server error', new Error('Internal server error')],
        ['a network failure', new TypeError('Failed to fetch')],
        ['a differently-named error', Object.assign(new Error('x'), { name: 'TimeoutError' })],
        ['null', null],
        ['undefined', undefined],
        ['a plain string', 'Import cancelled'],
        ['an unrelated object', { message: 'Import cancelled' }],
    ])('does not treat %s as cancellation', (_label, value) => {
        expect(isImportCancelled(value)).toBe(false);
    });

    it('does not depend on the message text', () => {
        // The whole point of the class: an error that merely *says* it was
        // cancelled is not a cancellation signal, and a real cancellation stays
        // recognizable regardless of what its message says.
        expect(isImportCancelled(new Error('Import cancelled'))).toBe(false);
        const real = new ImportCancelledError();
        real.message = 'Geannuleerd';
        expect(isImportCancelled(real)).toBe(true);
    });
});
