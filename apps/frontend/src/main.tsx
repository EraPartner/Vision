import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Boot-time env validation (ADR-030): fail fast on misconfigured Vite vars.
import "./lib/env";
// Self-hosted fonts — imported here (not via CSS @import) so Vite tracks the
// woff2/woff binaries through its module graph. Tailwind v4's PostCSS plugin
// inlines @import contents but doesn't rebase url() refs, leaving Vite unable
// to bundle font binaries when imported from index.css.
import "@fontsource/fraunces/latin-400.css";
import "@fontsource/fraunces/latin-600.css";
import "@fontsource/fraunces/latin-700.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
// Apply the visual skin (skin-v2) class before first paint to avoid a flash.
import { applySkinV2Class } from "./lib/skin";
import { startSettingsPreload } from "./lib/settingsPreload";
import { startCategoriesPreload } from "./lib/categoriesPreload";
import App from "./App";
import "./index.css";

applySkinV2Class();
// Kick off the two fetches that gate the first dashboard numbers before React
// mounts, so both round trips overlap the remaining JS execution + mount instead
// of queueing after them. They are independent of each other and run in
// parallel; SettingsPreloadProvider and useExcludedIds await these same shared
// promises, so neither request is duplicated.
startSettingsPreload();
startCategoriesPreload();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
