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
    },
    css: {
        devSourcemap: mode === 'development',
    },
}));
