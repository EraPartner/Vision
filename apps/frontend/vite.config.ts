/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { readFileSync } from "node:fs";
import { createLiveContractSkipBannerReporter } from "./src/test/live-contracts/liveContractSkipBanner";
import { defaultRoutePreloadPlugin } from "./src/build-support/defaultRoutePreload";

const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

function liveContractSkipBannerPlugin() {
  return {
    name: "vision:live-contract-skip-banner",
    configureVitest({
      vitest,
    }: {
      vitest?: { config?: { reporters?: unknown[] } };
    }) {
      const reporters = vitest?.config?.reporters;
      if (!Array.isArray(reporters)) {
        process.stdout.write(
          "[live-contract-skip-banner] could not attach to vitest reporters -- " +
            "live-contract skips will NOT be announced. Fix liveContractSkipBanner.ts.\n",
        );
        return;
      }
      if (
        reporters.some(
          (reporter) =>
            typeof reporter === "object" &&
            reporter !== null &&
            "isLiveContractSkipBanner" in reporter,
        )
      )
        return;
      reporters.push(createLiveContractSkipBannerReporter());
    },
  };
}

export default defineConfig(({ mode }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(rootPackage.version),
  },
  server: {
    host: "::",
    port: 8080,
    strictPort: false, // auto-pick next free port if 8080 is taken
    proxy: {
      "/api": {
        target: process.env.VITE_API_URL || "http://localhost:3002",
        changeOrigin: true,
        secure: false,
      },
    },
  },
  plugins: [
    react(),
    defaultRoutePreloadPlugin(),
    liveContractSkipBannerPlugin(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // decimal.js is imported both directly (src/utils/currency.ts) and
    // transitively via @vision/shared-utils, which declares its own copy.
    // Without deduping, Rollup emits two full copies (~12-13 KB gz each) into
    // separate chunks (money-*.js and AIChatPage-*.js). Force a single module id.
    dedupe: ["decimal.js"],
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        /**
         * Manual chunk splitting — keeps frequently unchanged vendor code in
         * stable, separately-cacheable files so the browser doesn't re-download
         * the entire bundle when only app code changes.
         *
         * NOTE: bun resolves packages from the flat .bun cache, so module IDs
         * look like: .../node_modules/.bun/@tanstack+react-query@5.x+<hash>/...
         * We match on the package name segment rather than the exact path so
         * this works identically under both bun and npm/yarn/pnpm.
         *
         * Chunks:
         *  react-vendor   — React + React DOM (core runtime, almost never changes)
         *  router         — react-router
         *  query          — TanStack Query
         *  tanstack       — TanStack Table + Virtual
         *  charts         — recharts (largest single dep)
         *  radix-ui       — all @radix-ui/* primitives
         *  date-utils     — date-fns
         *  icons          — lucide-react
         */
        manualChunks(id: string) {
          // Normalise: strip bun cache hash suffix so we can match cleanly
          const norm = id.replace(/\+[a-f0-9]{8,}[^/]*/g, "");

          if (
            norm.includes("/react/") ||
            norm.includes("/react-dom/") ||
            norm.includes("+react@") ||
            norm.includes("+react-dom@")
          ) {
            return "react-vendor";
          }
          if (
            norm.includes("/react-router") ||
            norm.includes("+react-router")
          ) {
            return "router";
          }
          if (
            norm.includes("@tanstack/react-query") ||
            norm.includes("@tanstack+react-query")
          ) {
            return "query";
          }
          if (
            norm.includes("@tanstack/react-virtual") ||
            norm.includes("@tanstack+react-virtual")
          ) {
            return "tanstack";
          }
          // recharts is used by exactly one component (ToolResultCard),
          // reachable only through the lazy-loaded AIChatPage. Forcing it
          // into a named chunk dragged it (114 kB gz) into the initial
          // modulepreload graph via a shared module. Leaving it unnamed
          // lets Rollup keep it inside the AIChatPage async chunk so it
          // loads only when /ai-chat is opened.
          if (norm.includes("@radix-ui/") || norm.includes("@radix-ui+")) {
            return "radix-ui";
          }
          if (norm.includes("/date-fns") || norm.includes("+date-fns")) {
            return "date-utils";
          }
          if (
            norm.includes("/lucide-react") ||
            norm.includes("+lucide-react")
          ) {
            return "icons";
          }
          // decimal.js is imported by two independent lazy chunks (the
          // shared-utils money chunk and AIChatPage). resolve.dedupe
          // collapses them to one module id, but Rollup still inlines a
          // full copy (~12-13 KB gz) into EACH async chunk rather than
          // pay an extra request for a shared one. A named chunk forces a
          // single shared copy; neither parent is in the boot graph, so
          // this loads on demand and never enters the initial preload.
          if (norm.includes("/decimal.js") || norm.includes("+decimal.js")) {
            return "decimal";
          }
        },
      },
    },
  },
  css: {
    devSourcemap: mode === "development",
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./src/test-setup.ts"],
    // Silence the app's debug/info logger during tests. The api client logs
    // every request at debug level; those console writes fire from inside
    // request promises that can resolve during worker teardown, which
    // intermittently trips Vitest's "Closing rpc while onUserConsoleLog was
    // pending" teardown race. warn/error still emit so the suite's
    // console.error/warn spies keep working.
    env: {
      VITE_LOG_LEVEL: "warn",
    },
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**"],
    environmentMatchGlobs: [
      ["src/**/*.test.tsx", "jsdom"],
      ["src/**/*.spec.tsx", "jsdom"],
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary", "json"],
      include: [
        "src/components/**/*.{ts,tsx}",
        "src/hooks/**/*.{ts,tsx}",
        "src/lib/**/*.{ts,tsx}",
        "src/pages/**/*.{ts,tsx}",
        "src/utils/**/*.{ts,tsx}",
        "src/features/**/*.{ts,tsx}",
        "src/contexts/**/*.{ts,tsx}",
        "src/stores/**/*.{ts,tsx}",
        "src/App.tsx",
      ],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        "**/__tests__/**",
        "**/test/**",
        "src/**/*.d.ts",
        // Boot-only side-effect entrypoints: main mounts the complete
        // application; theme-flash mutates the pre-paint document as
        // soon as it is imported. Their dependencies are measured,
        // but executing these modules is an E2E responsibility.
        "src/main.tsx",
        "src/theme-flash.ts",
      ],
      // Ratchet gate — tracks current actual coverage so regressions are
      // caught immediately. Bump after each phase adds meaningful tests;
      // never lower these values. Set a 2-3 pt buffer below the measured
      // figure to absorb v8 line-attribution variance between runs
      // (convention: floor(measured) minus 2).
      // Last measured (2026-08-25, 2.5k-test suite, after adding the
      // tested src/stores/** tree and App.tsx to the include list):
      //   statements 64.28 % | branches 53.93 % | functions 56.11 % | lines 66.67 %
      thresholds: {
        statements: 62,
        branches: 51,
        functions: 54,
        lines: 64,
      },
    },
  },
}));
