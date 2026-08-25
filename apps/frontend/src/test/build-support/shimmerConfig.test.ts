import { describe, expect, it } from 'vitest';

import { shimmerAnimation, shimmerKeyframes } from '../../build-support/shimmerAnimation';

describe('shimmer animation contract', () => {
    it('animates only transform and keeps the established timing', () => {
        const frames: ReadonlyArray<Record<string, string>> = Object.values(shimmerKeyframes);

        expect(frames).not.toHaveLength(0);
        frames.forEach((frame) => {
            expect(frame).toHaveProperty('transform');
            expect(frame).not.toHaveProperty('backgroundPosition');
        });
        expect(shimmerAnimation).toBe('shimmer 2.4s linear infinite');
    });
});
