import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { gainLossPreviewStyle } from './gainLossPreview';

const skinV2Css = readFileSync(new URL('../../../styles/skin-v2.css', import.meta.url), 'utf8');
const tokensCss = readFileSync(new URL('../../../styles/tokens.css', import.meta.url), 'utf8');

describe('gain/loss palette previews', () => {
    it('keeps the two option previews independent of the active palette', () => {
        expect(gainLossPreviewStyle('colorblind')).toEqual({
            backgroundColor: 'hsl(var(--loss-colorblind))',
        });
        expect(gainLossPreviewStyle('classic')).toEqual({
            backgroundColor: 'hsl(var(--destructive))',
        });
    });

    it('defines mode-correct colorblind loss tokens and uses them in skin v2', () => {
        expect(tokensCss).toMatch(/:root\s*{[\s\S]*--loss-colorblind:\s*24 85% 45%/);
        expect(tokensCss).toMatch(/\.dark\s*{[\s\S]*--loss-colorblind:\s*24 90% 62%/);
        expect(skinV2Css.match(/--loss:\s*var\(--loss-colorblind\)/g)).toHaveLength(2);
    });
});
