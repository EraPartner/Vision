/**
 * Async loader for the Framer Motion feature bundle used by <LazyMotion> at the
 * root of App.tsx.
 *
 * Background: `motion.*` components statically pull the entire animation,
 * gesture and layout-projection engine into whatever chunk imports them. Three
 * of those live in the always-loaded shell (PageTransition, AppSidebar,
 * components/ui/tabs), so the engine shipped in the boot-preload graph on every
 * cold load regardless of route. Swapping every call site to the tree-shaken
 * `m` API under one <LazyMotion> provider moves the engine into the async chunk
 * built from ./motionFeatureBundle. `m` renders identically to `motion` once
 * the features have loaded — no timing, easing or spring change (ADR-105).
 *
 * First-frame preservation: <LazyMotion> only calls this from a mount effect,
 * so an un-warmed dynamic import would leave the shell sitting on its `initial`
 * frame (PageTransition starts at opacity 0) for a whole network round trip on
 * cold boot. We therefore kick the import off at module-evaluation time. The
 * request is issued off the main thread while React does its synchronous first
 * render, so it costs no hydration-critical CPU, and the chunk is normally
 * resolved by the time LazyMotion's effect asks for it. Framer's own
 * `manuallyAnimateOnMount` path (motion/utils/use-visual-element) covers the
 * remainder: if features do land after mount, the entrance animation is
 * replayed in full rather than snapped to its end state.
 *
 * This is deliberately NOT a `<link rel="modulepreload">` in index.html — that
 * would put the bytes straight back into the blocking boot graph the
 * check-bundle-size.mjs guard measures.
 */
import type { FeatureBundle } from "framer-motion";

let bundlePromise: Promise<FeatureBundle> | undefined;

export function loadMotionFeatures(): Promise<FeatureBundle> {
    bundlePromise ??= import("./motionFeatureBundle").then((mod) => mod.default);
    return bundlePromise;
}

// Warm the chunk as soon as the entry chunk evaluates (see the note above).
// The no-op catch is only here so a failed fetch during warm-up doesn't surface
// as an unhandled rejection; LazyMotion still awaits the same promise and
// retains framer's own failure behaviour.
loadMotionFeatures().catch(() => {});
