import { useEffect, useRef, useState } from "react";

/**
 * Animates a number from 0 (or previous value) to the target value.
 * Returns the current display value as a number.
 */
export function useCountUp(target: number, duration = 600): number {
    const [current, setCurrent] = useState(0);
    const prevTarget = useRef(0);
    const rafRef = useRef<number | null>(null);

    useEffect(() => {
        const from = prevTarget.current;
        prevTarget.current = target;

        if (from === target) {
            setCurrent(target);
            return;
        }

        const startTime = performance.now();

        const tick = (now: number) => {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1);
            // ease-out cubic
            const eased = 1 - Math.pow(1 - progress, 3);
            const value = from + (target - from) * eased;
            setCurrent(value);

            if (progress < 1) {
                rafRef.current = requestAnimationFrame(tick);
            } else {
                setCurrent(target);
            }
        };

        rafRef.current = requestAnimationFrame(tick);

        return () => {
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        };
    }, [target, duration]);

    return current;
}
