import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig(({ mode }) => ({
    server: {
        host: "::",
        port: 8080,
        strictPort: false,  // auto-pick next free port if 8080 is taken
        proxy: {
            '/api': {
                target: process.env.VITE_API_URL || 'http://localhost:3002',
                changeOrigin: true,
                secure: false,
            },
        },
    },
    plugins: [
        react(),
    ],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
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
                 *  router         — react-router-dom
                 *  query          — TanStack Query
                 *  tanstack       — TanStack Table + Virtual
                 *  charts         — recharts (largest single dep)
                 *  radix-ui       — all @radix-ui/* primitives
                 *  date-utils     — date-fns
                 *  form           — react-hook-form
                 *  icons          — lucide-react
                 */
                manualChunks(id: string) {
                    // Normalise: strip bun cache hash suffix so we can match cleanly
                    const norm = id.replace(/\+[a-f0-9]{8,}[^/]*/g, '');

                    if (norm.includes('/react/') || norm.includes('/react-dom/') ||
                        norm.includes('+react@') || norm.includes('+react-dom@')) {
                        return 'react-vendor';
                    }
                    if (norm.includes('/react-router') || norm.includes('+react-router')) {
                        return 'router';
                    }
                    if (norm.includes('@tanstack/react-query') || norm.includes('@tanstack+react-query')) {
                        return 'query';
                    }
                    if (norm.includes('@tanstack/react-table') || norm.includes('@tanstack+react-table') ||
                        norm.includes('@tanstack/react-virtual') || norm.includes('@tanstack+react-virtual')) {
                        return 'tanstack';
                    }
                    if (norm.includes('/recharts') || norm.includes('+recharts')) {
                        return 'charts';
                    }
                    if (norm.includes('@radix-ui/') || norm.includes('@radix-ui+')) {
                        return 'radix-ui';
                    }
                    if (norm.includes('/date-fns') || norm.includes('+date-fns')) {
                        return 'date-utils';
                    }
                    if (norm.includes('/react-hook-form') || norm.includes('+react-hook-form')) {
                        return 'form';
                    }
                    if (norm.includes('/lucide-react') || norm.includes('+lucide-react')) {
                        return 'icons';
                    }
                },
            },
        },
    },
    css: {
        devSourcemap: mode === 'development',
    },
}));
