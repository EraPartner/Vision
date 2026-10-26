import { describe, it, expect } from 'vitest';
import { alternateProgress, auroraBlobs, easeInOutQuart } from '@/components/layout/auroraBlobs';

// 1440x900 viewport, 16px rem: 55vw = 792px > 34rem, 48vw = 691.2px > 30rem.
const viewport = { width: 1440, height: 900, rem: 16 };

describe('auroraBlobs', () => {
    it('matches the CSS blob geometry at rest', () => {
        const { a, b } = auroraBlobs(viewport, 0, false);
        // ::before: left -12%, top -18%, 792px square, fade at 72% of half side.
        expect(a.x).toBeCloseTo(-172.8 + 396);
        expect(a.y).toBeCloseTo(-162 + 396);
        expect(a.radius).toBeCloseTo(396 * 0.72);
        // ::after: right -10%, bottom -22%, 691.2px square, no transform at rest.
        expect(b.x).toBeCloseTo(1440 * 1.1 - 345.6);
        expect(b.y).toBeCloseTo(900 * 1.22 - 345.6);
        expect(b.radius).toBeCloseTo(345.6 * 0.72);
    });

    it('uses the rem minimum on narrow windows', () => {
        const { a } = auroraBlobs({ width: 800, height: 600, rem: 16 }, 0, false);
        expect(a.radius).toBeCloseTo((34 * 16 / 2) * 0.72);
    });

    it('reaches the keyframe end points of the drift', () => {
        // aurora-drift-a ends at translate(14vw, 9vh) scale(1.18) after 64s.
        const start = auroraBlobs(viewport, 0, true);
        const end = auroraBlobs(viewport, 64, true);
        expect(end.a.x - start.a.x).toBeCloseTo(14 * 14.4);
        expect(end.a.y - start.a.y).toBeCloseTo(9 * 9);
        expect(end.a.radius / start.a.radius).toBeCloseTo(1.18);
        // aurora-drift-b starts at scale(1.12) while drifting.
        expect(start.b.radius).toBeCloseTo(345.6 * 0.72 * 1.12);
    });

    it('alternates direction like `animation-direction: alternate`', () => {
        expect(alternateProgress(64, 64)).toBeCloseTo(1);
        expect(alternateProgress(128, 64)).toBeCloseTo(0);
        expect(alternateProgress(96, 64)).toBeCloseTo(alternateProgress(32, 64));
    });

    it('follows --ease-in-out-quart', () => {
        expect(easeInOutQuart(0)).toBe(0);
        expect(easeInOutQuart(1)).toBe(1);
        // The sampled CSS keyframes of aurora-drift-a (x of 14vw at 25%, 50%,
        // 75%) are this curve.
        expect(easeInOutQuart(0.25)).toBeCloseTo(0.74 / 14, 3);
        expect(easeInOutQuart(0.5)).toBeCloseTo(8.34 / 14, 3);
        expect(easeInOutQuart(0.75)).toBeCloseTo(13.39 / 14, 3);
    });
});
