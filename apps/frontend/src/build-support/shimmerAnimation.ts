/** Shared by Tailwind configuration and the build-level contract test. */
export const shimmerKeyframes = {
    '0%': { transform: 'translate3d(-100%, 0, 0)' },
    '100%': { transform: 'translate3d(100%, 0, 0)' },
} as const;

export const shimmerAnimation = 'shimmer 2.4s linear infinite';
