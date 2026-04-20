import { applyThemePalette, isThemeVariant } from '@/styles/themes';

(function () {
    let theme: 'light' | 'dark' = 'dark';
    try {
        const t = localStorage.getItem('vision_theme');
        if (t === 'light') {
            document.documentElement.classList.remove('dark');
            theme = 'light';
        } else {
            document.documentElement.classList.add('dark');
            theme = 'dark';
        }
    } catch {
        document.documentElement.classList.add('dark');
    }

    try {
        const v = localStorage.getItem('vision_theme_variant');
        const variant = isThemeVariant(v) ? v : 'default';
        applyThemePalette(variant, theme);
    } catch {
        applyThemePalette('default', theme);
    }
})();
