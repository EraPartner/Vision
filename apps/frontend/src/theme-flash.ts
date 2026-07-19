import { applyThemePalette, isThemeVariant } from '@/styles/themes';

/**
 * Apply the saved theme palette VARIANT (accent / jewel colors).
 *
 * The light/dark base class — the one that causes a flash-of-light if applied
 * late — is set pre-paint by the plain inline script in index.html. This module
 * is bundled into the deferred main graph, so it only runs after boot; that is
 * fine for the palette variant (it tweaks accent CSS variables, not the base
 * background) but would be too late for the dark/light class, which is why that
 * lives inline. We read the base theme back off the class the inline script set.
 */
(function () {
    const theme: 'light' | 'dark' =
        document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    try {
        const v = localStorage.getItem('vision_theme_variant');
        const variant = isThemeVariant(v) ? v : 'default';
        applyThemePalette(variant, theme);
    } catch {
        applyThemePalette('default', theme);
    }
})();
