import { describe, it, expect } from 'vitest';
import { resolveAuroraMode } from '@/components/layout/shaderAuroraMode';

const base = {
    contextLost: false,
    reducedMotion: false,
    staticAtmosphere: false,
    hidden: false,
    focused: true,
};

describe('resolveAuroraMode', () => {
    it('loops when visible, focused, and unconstrained', () => {
        expect(resolveAuroraMode(base)).toBe('loop');
    });

    it('holds a static frame under prefers-reduced-motion', () => {
        expect(resolveAuroraMode({ ...base, reducedMotion: true })).toBe('static');
    });

    it('holds a static frame under fx-static-atmosphere (ADR-075 large-display mitigation)', () => {
        expect(resolveAuroraMode({ ...base, staticAtmosphere: true })).toBe('static');
    });

    it('static atmosphere still renders the aurora — never "stopped" while drawable', () => {
        // The mitigation freezes the atmosphere; it must not blank it.
        expect(resolveAuroraMode({ ...base, staticAtmosphere: true })).not.toBe('stopped');
    });

    it('stops (keeping the last frame) when the window is blurred', () => {
        expect(resolveAuroraMode({ ...base, focused: false })).toBe('stopped');
    });

    it('stops when the document is hidden', () => {
        expect(resolveAuroraMode({ ...base, hidden: true })).toBe('stopped');
    });

    it('static outranks the idle pause — a held frame stays correct while blurred', () => {
        expect(resolveAuroraMode({ ...base, staticAtmosphere: true, focused: false })).toBe('static');
        expect(resolveAuroraMode({ ...base, staticAtmosphere: true, hidden: true })).toBe('static');
        expect(resolveAuroraMode({ ...base, reducedMotion: true, focused: false })).toBe('static');
    });

    it('a lost context stops everything — no draw calls, CSS blobs are the fallback', () => {
        expect(resolveAuroraMode({ ...base, contextLost: true })).toBe('stopped');
        expect(resolveAuroraMode({ ...base, contextLost: true, staticAtmosphere: true })).toBe('stopped');
        expect(resolveAuroraMode({ ...base, contextLost: true, reducedMotion: true })).toBe('stopped');
    });

    it('resumes the loop when static atmosphere clears (window moved to a smaller display)', () => {
        expect(resolveAuroraMode({ ...base, staticAtmosphere: true })).toBe('static');
        expect(resolveAuroraMode({ ...base, staticAtmosphere: false })).toBe('loop');
    });

    it('resumes from a restored context according to the current motion state', () => {
        expect(resolveAuroraMode({ ...base, contextLost: false })).toBe('loop');
        expect(resolveAuroraMode({ ...base, contextLost: false, staticAtmosphere: true })).toBe('static');
    });
});
