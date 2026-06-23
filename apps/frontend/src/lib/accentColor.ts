/**
 * macOS system-accent → design-token conversion. Electron's
 * systemPreferences.getAccentColor() yields RRGGBB(AA) hex; theme tokens are
 * raw HSL component strings ("h s% l%") so hsl(var(--token) / a) keeps
 * composing opacity (see styles/themes.ts).
 */

function parseHex(hex: string): { r: number; g: number; b: number } | null {
    const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** "RRGGBBAA" → "h s% l%" token components, or null for unparseable input. */
export function hexToHslComponents(hex: string): string | null {
    const rgb = parseHex(hex);
    if (!rgb) return null;
    const r = rgb.r / 255;
    const g = rgb.g / 255;
    const b = rgb.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0;
    let s = 0;
    if (d !== 0) {
        s = d / (1 - Math.abs(2 * l - 1));
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
    const lin = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Foreground token to pair with the accent as a fill (WCAG contrast pick
 * between near-white and near-black). Yellow/green accents need dark text.
 */
export function accentForegroundComponents(hex: string): string {
    const rgb = parseHex(hex);
    if (!rgb) return '0 0% 100%';
    const lum = relativeLuminance(rgb);
    const contrastWithWhite = 1.05 / (lum + 0.05);
    const contrastWithBlack = (lum + 0.05) / 0.05;
    return contrastWithWhite >= contrastWithBlack ? '0 0% 100%' : '224 47% 10%';
}
