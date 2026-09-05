import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Boot-time env validation (ADR-030): fail fast on misconfigured Vite vars.
import "./lib/env";
// Direct WOFF2-only self-hosted faces; the two critical body weights are also
// discovered from index.html before the application stylesheet loads.
import "./styles/fonts.css";
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
// Categories remain unconditional by design. Mirroring enough settings into
// localStorage to gate this safely would create a second settings authority;
// one occasionally unused request is the smaller and more reliable cost.
startCategoriesPreload();

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
