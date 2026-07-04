/**
 * Skin-v2 — the "dense fintech" visual redesign toggle.
 *
 * The entire redesign lives in CSS scoped under the `.skin-v2` root class
 * (`styles/skin-v2.css`). With the class absent the legacy skin renders
 * byte-for-byte unchanged, so rollback is simply removing the class / flipping
 * the flag — no branch, instant, per-user.
 *
 * The skin is active when the build-time flag (`VITE_SKIN_V2`) is on, OR a
 * localStorage override is set. The override lets us compare before/after live
 * without a rebuild: in dev, `window.__setSkinV2(true|false|undefined)`.
 */
import { isSkinV2Default } from '@/lib/env';

const STORAGE_KEY = 'vision_skin_v2';
const ROOT_CLASS = 'skin-v2';

/** Resolve the effective skin: localStorage override wins over the build flag. */
export function isSkinV2Active(): boolean {
    try {
        const override = localStorage.getItem(STORAGE_KEY);
        if (override === 'true') return true;
        if (override === 'false') return false;
    } catch {
        /* localStorage unavailable (SSR/private mode) — fall through to flag */
    }
    return isSkinV2Default;
}

/** Add/remove the `.skin-v2` class on <html> to match the effective skin. */
export function applySkinV2Class(): void {
    const root = document.documentElement;
    root.classList.toggle(ROOT_CLASS, isSkinV2Active());
}

/**
 * Set (or clear) the runtime override and re-apply. Pass `undefined` to drop
 * the override and fall back to the build flag.
 */
export function setSkinV2(on: boolean | undefined): void {
    try {
        if (on === undefined) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, String(on));
    } catch {
        /* ignore persistence failures */
    }
    applySkinV2Class();
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
    (window as unknown as { __setSkinV2?: typeof setSkinV2 }).__setSkinV2 = setSkinV2;
}
