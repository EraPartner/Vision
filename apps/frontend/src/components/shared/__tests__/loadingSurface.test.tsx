// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { Skeleton } from "@/components/ui/skeleton";
import { loadingSurfaceProps } from "@/lib/loadingSurface";
import { ResearchAnalystTab } from "@/components/research/ResearchAnalystTab";
import { renderWithApp } from "@/test/renderWithApp";

/**
 * The loading-surface contract (WP: skeleton a11y):
 *   - every `Skeleton` is a decorative bone, hidden from the a11y tree;
 *   - exactly ONE element per loading surface carries role="status", so a grid
 *     of twelve bones announces once instead of twelve times.
 */
describe("loading surface a11y", () => {
    it("Skeleton is decorative by default", () => {
        // Arrange + Act
        const { container } = render(<Skeleton className="h-4 w-full" />);

        // Assert — the bone itself never reaches a screen reader
        const bone = container.firstElementChild!;
        expect(bone).toHaveAttribute("aria-hidden", "true");
        expect(bone).not.toHaveAttribute("role");
    });

    it("a multi-skeleton surface exposes exactly one status and no visible bones", () => {
        // Arrange + Act — SectionLoader is the canonical surface (3 bones)
        const { container } = render(<SectionLoader />);

        // Assert — one announcer…
        const statuses = screen.getAllByRole("status");
        expect(statuses).toHaveLength(1);
        expect(statuses[0]).toHaveAttribute("aria-busy", "true");
        expect(statuses[0]).toHaveAccessibleName("Loading");

        // …and every bone inside it is hidden
        const bones = container.querySelectorAll(".animate-shimmer");
        expect(bones.length).toBeGreaterThan(1);
        bones.forEach((bone) => expect(bone).toHaveAttribute("aria-hidden", "true"));
    });

    it("a lone Skeleton that IS the surface announces instead of hiding", () => {
        // Arrange + Act — loadingSurfaceProps must cancel Skeleton's aria-hidden,
        // or the announcing element would be hidden from the a11y tree.
        render(<Skeleton {...loadingSurfaceProps} className="h-[320px]" />);

        // Assert
        const status = screen.getByRole("status");
        expect(status).not.toHaveAttribute("aria-hidden");
        expect(status).toHaveAttribute("aria-busy", "true");
        expect(status).toHaveAccessibleName("Loading");
    });

    it("a real loading surface announces once for all of its bones", () => {
        // Arrange + Act — five bones in one early-return branch. Asserted
        // synchronously: the fetch resolves on a later tick, so this is the
        // loading frame.
        const { container } = renderWithApp(<ResearchAnalystTab symbol="AAPL" enabled />);

        // Assert
        expect(screen.getAllByRole("status")).toHaveLength(1);
        const bones = container.querySelectorAll(".animate-shimmer");
        expect(bones.length).toBe(5);
        bones.forEach((bone) => expect(bone).toHaveAttribute("aria-hidden", "true"));
    });
});
