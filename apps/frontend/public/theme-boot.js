// Sets the light/dark class on <html> before first paint, so the boot
// placeholder and the shell open in the user's theme with no flash.
//
// This is an external classic script on purpose: the packaged app's CSP
// (`script-src 'self'`, packaging/electron/main.ts) blocks inline scripts, and
// a `type="module"` script is deferred into the main bundle, which runs too
// late. A plain <script src> in <head> runs synchronously before <body> paints.
//
// Keep in sync with ThemeHydration.tsx, which writes these localStorage keys:
//   vision_theme        resolved theme of the last run ("light" | "dark")
//   vision_theme_mode   appearance setting; "system" re-resolves here, because
//                       macOS may have switched appearance since the last run
//   vision_boot_palette placeholder colors for the theme it was saved under
(function () {
  var root = document.documentElement;
  var theme = "dark";
  try {
    if (localStorage.getItem("vision_theme_mode") === "system") {
      theme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    } else if (localStorage.getItem("vision_theme") === "light") {
      theme = "light";
    }
  } catch (e) {
    /* localStorage unavailable: dark is the app default. */
  }
  root.classList.toggle("dark", theme === "dark");
  try {
    var bootPalette = JSON.parse(
      localStorage.getItem("vision_boot_palette") || "null",
    );
    var hsl = /^\d{1,3}(?:\.\d+)?\s+\d{1,3}(?:\.\d+)?%\s+\d{1,3}(?:\.\d+)?%$/;
    if (
      bootPalette &&
      bootPalette.theme === theme &&
      hsl.test(bootPalette.base) &&
      hsl.test(bootPalette.foreground) &&
      hsl.test(bootPalette.glow)
    ) {
      root.style.setProperty("--vision-boot-bg", bootPalette.base);
      root.style.setProperty("--vision-boot-fg", bootPalette.foreground);
      root.style.setProperty("--vision-boot-glow", bootPalette.glow);
    }
  } catch (e) {
    /* Invalid optional boot palette: keep the selected base theme. */
  }
})();
