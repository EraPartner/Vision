import { useEffect, useRef, useState } from "react";

/**
 * Animates a number from the currently-visible value to the target value.
 * Returns the current display value as a number.
 */
export function useCountUp(target: number, duration = 600): number {
    const [current, setCurrent] = useState(0);
    // Mirror of `current` for synchronous reads inside the effect — using the
    // `current` state directly would force it into the dep array and restart
    // the animation every frame.
    const currentRef = useRef(0);
    const rafRef = useRef<number | null>(null);

    useEffect(() => {
        // Animate from what's actually on screen right now, not from the
        // previous target. On a rapid value change mid-animation, starting
        // from the old target produced a visible jump.
        const from = currentRef.current;

        const apply = (value: number) => {
            currentRef.current = value;
            setCurrent(value);
        };

        if (from === target) {
            apply(target);
            return;
        }

        // startTime is captured from the *first rAF timestamp*, not
        // performance.now(): the rAF callback's `now` and performance.now()
        // can run on slightly different clocks (notably under jsdom + coverage
        // instrumentation), yielding a negative `elapsed` that drove the
        // eased value negative and stalled the animation.
        let startTime: number | null = null;

        const tick = (now: number) => {
            if (startTime === null) startTime = now;
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1);
            // ease-out cubic
            const eased = 1 - Math.pow(1 - progress, 3);
            apply(from + (target - from) * eased);

            if (progress < 1) {
                rafRef.current = requestAnimationFrame(tick);
            } else {
                apply(target);
            }
        };

        rafRef.current = requestAnimationFrame(tick);

        return () => {
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        };
    }, [target, duration]);

    return current;
}
