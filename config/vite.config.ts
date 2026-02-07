import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
    mode === 'development' && componentTagger(),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../apps/frontend/src"),
    },
  },
  root: path.resolve(__dirname, "../"),
  publicDir: path.resolve(__dirname, "../apps/frontend/public"),
  build: {
    outDir: path.resolve(__dirname, "../dist"),
  },
}));
