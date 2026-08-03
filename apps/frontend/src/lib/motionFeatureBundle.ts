/**
 * The Framer Motion feature bundle, isolated in its own module so it lands in
 * its own async chunk.
 *
 * `LazyMotion` (see lib/motionFeatures.ts) loads this on demand, which is the
 * whole point: the `m` components in the always-loaded app shell
 * (PageTransition, AppSidebar's active rail, the Tabs pill) only need the
 * ~small component core at boot; the animation/gesture/layout engine arrives
 * off the critical path.
 *
 * Why `domMax` and not `domAnimation`: `domAnimation` covers animations,
 * variants, exit animations and hover/tap/focus gestures — but NOT layout
 * animations. AppSidebar's `layoutId="sidebar-active-rail"` and the Tabs
 * `layoutId` pill are shared-layout (magic-move) animations, which live in the
 * `layout` feature that only `domMax` includes. Downgrading to `domAnimation`
 * would silently kill both magic-move animations (ADR-105 protects them).
 * `domMax` also drags in pointer `drag` support, which nothing here uses — that
 * is the price of `layout` not being separately exported.
 */
import { domMax } from "framer-motion";

export default domMax;
