import { describe, expect, it } from 'vitest';

import { safeHref } from '@/utils/safeHref';

describe('safeHref', () => {
    describe('accepts plain web links', () => {
        it.each([
            'https://example.com/article',
            'http://example.com/article',
            'HTTPS://EXAMPLE.COM/Article',
            'https://example.com/a?b=c#d',
        ])('%s', (url) => {
            expect(safeHref(url)).toBe(url);
        });

        it('trims surrounding whitespace', () => {
            expect(safeHref('  https://example.com  ')).toBe('https://example.com');
        });
    });

    describe('resolves protocol-relative URLs against https', () => {
        // Common in RSS/news payloads. These used to be rejected, which turned
        // legitimate articles into dead cards.
        it('upgrades //host/path', () => {
            expect(safeHref('//cdn.example.com/article')).toBe('https://cdn.example.com/article');
        });

        it('upgrades a bare //host', () => {
            expect(safeHref('//cdn.example.com')).toBe('https://cdn.example.com');
        });
    });

    describe('rejects everything that is not an http(s) link', () => {
        it.each([
            ['javascript scheme', 'javascript:alert(1)'],
            ['uppercase javascript scheme', 'JavaScript:alert(1)'],
            ['javascript split by a newline', 'java\nscript:alert(1)'],
            ['javascript split by a tab', 'java\tscript:alert(1)'],
            ['leading whitespace before the scheme', '  javascript:alert(1)'],
            ['data scheme', 'data:text/html,<script>alert(1)</script>'],
            ['vbscript scheme', 'vbscript:msgbox(1)'],
            ['file scheme', 'file:///etc/passwd'],
            ['relative path', '/dashboard'],
            ['bare word', 'example.com'],
            ['empty string', ''],
            ['whitespace only', '   '],
        ])('%s', (_label, url) => {
            expect(safeHref(url)).toBeUndefined();
        });

        it.each([[null], [undefined], [123 as unknown as string], [{} as unknown as string]])(
            'non-string input %s',
            (value) => {
                expect(safeHref(value as string | null | undefined)).toBeUndefined();
            },
        );
    });
});
