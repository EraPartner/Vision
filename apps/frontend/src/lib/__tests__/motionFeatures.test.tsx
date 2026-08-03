// @vitest-environment jsdom
/**
 * Guards the LazyMotion wiring that keeps the Framer Motion engine out of the
 * boot-preload graph (see lib/motionFeatures.ts and the <LazyMotion> provider
 * in App.tsx).
 *
 * The load-bearing assertion is `layout`: the app shell animates two
 * shared-layout ("magic move") elements — AppSidebar's `layoutId`
 * "sidebar-active-rail" and the `layoutId` pill in components/ui/tabs — and the
 * `layout` feature ships only in `domMax`, not `domAnimation`. Swapping the
 * bundle down to `domAnimation` to shave bytes would silently stop both
 * animations, which ADR-105 protects. This test fails loudly if that happens.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { LazyMotion, m, motion } from "framer-motion";
import { describe, expect, it, vi } from "vitest";

import { loadMotionFeatures } from "@/lib/motionFeatures";

describe("motion feature bundle", () => {
    it("provides every feature the app's motion call sites rely on", async () => {
        const bundle = await loadMotionFeatures();

        // A renderer is what lets `m` components create visual elements at all.
        expect(typeof bundle.renderer).toBe("function");

        // animation  — PageTransition's initial/animate, every chart's draw-in
        // exit       — AnimatePresence in DonutChart / ChartTooltip
        // layout     — layoutId rails/pills in AppSidebar and ui/tabs (domMax only)
        for (const feature of ["animation", "exit", "layout"] as const) {
            expect(bundle, `missing "${feature}" feature`).toHaveProperty(feature);
        }
    });

    it("memoizes the import so every LazyMotion consumer shares one chunk", () => {
        expect(loadMotionFeatures()).toBe(loadMotionFeatures());
    });

    it("renders `m` components under a strict LazyMotion, and animates once features land", async () => {
        render(
            <LazyMotion features={loadMotionFeatures} strict>
                <m.div data-testid="shell-motion" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    shell
                </m.div>
            </LazyMotion>,
        );

        // Static first frame: the `initial` styles are applied while the feature
        // chunk is still in flight, so nothing flashes at its final state.
        expect(screen.getByTestId("shell-motion")).toHaveStyle({ opacity: "0" });

        // Once features land framer replays the entrance (manuallyAnimateOnMount)
        // rather than snapping, so the element ends up at its `animate` state.
        await waitFor(() => {
            expect(screen.getByTestId("shell-motion")).toHaveStyle({ opacity: "1" });
        });
    });

    it("makes a stray `motion.*` component in a strict tree fail loudly", () => {
        // The whole point of `strict`: a `motion` import anywhere under the
        // provider would pull a second copy of the engine into its chunk. Framer
        // turns that into a dev-time invariant rather than a silent size
        // regression. Console noise from React's error logging is expected here.
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            expect(() =>
                render(
                    <LazyMotion features={loadMotionFeatures} strict>
                        <motion.div />
                    </LazyMotion>,
                ),
            ).toThrow(/LazyMotion/);
        } finally {
            consoleError.mockRestore();
        }
    });
});
