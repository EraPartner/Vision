import { cn } from "@/lib/utils";

interface VisionMarkProps {
    className?: string;
    /**
     * Give the mark an accessible name (e.g. on a surface where it is the only
     * identification). Omitted → decorative, `aria-hidden`.
     */
    title?: string;
}

/**
 * The Vision brand mark: the rising "V" growth stroke with the aperture / eye
 * in its notch.
 *
 * Geometry is lifted verbatim from the packaged app icon
 * (`packaging/electron/build/icon.svg`) — same path, same coordinates, same
 * 1024-unit space, cropped to a square that frames the glyph. This is the
 * product's one identity; do not redraw it here.
 *
 * Two things the packaged icon has that this does NOT:
 *   - the obsidian glass body, aurora washes and glass edge highlight. Every
 *     identity moment in the app already sits inside its own tinted tile
 *     (the sidebar's primary→accent gradient, onboarding's primary square,
 *     404's primary wash), so a second background would fight the first.
 *   - the emerald→champagne gradient and the champagne aperture ring. The mark
 *     renders in `currentColor` so it inherits whatever the host tile sets
 *     (`text-primary-foreground`, `text-primary`, …). At 16px — the sidebar
 *     and onboarding size — a 6-unit ring stroke resolves to under a fifth of
 *     a pixel and a three-stop gradient collapses to a single muddy tone, so
 *     the aperture is drawn as one solid disc sized between the packaged
 *     icon's ring and its pupil. Same identity, one ink, legible at 16px.
 * Full-fidelity renderings of the mark (body, aurora, gradient, ring) live at
 * the surfaces with room for them: `apps/frontend/public/favicon.svg` and the
 * packaged icon itself.
 */
export function VisionMark({ className, title }: VisionMarkProps) {
    return (
        <svg
            viewBox="262 296 500 500"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            role={title ? "img" : undefined}
            aria-hidden={title ? undefined : true}
            aria-label={title}
            className={cn("h-4 w-4", className)}
        >
            {title && <title>{title}</title>}
            {/* The V: a rising growth stroke that reads as the letter V */}
            <path
                d="M 268 300 L 512 792 L 756 300 L 656 300 L 512 596 L 368 300 Z"
                fill="currentColor"
                strokeLinejoin="round"
            />
            {/* Eye / aperture — the Vision mark */}
            <circle cx="512" cy="444" r="40" fill="currentColor" />
        </svg>
    );
}
