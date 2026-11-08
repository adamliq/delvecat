import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base + hash routing lets the build run from any GitHub Pages path.
// `vite build --mode splunk` builds the page of the Splunk app instead: fixed entry
// names (the app's page template refers to them) written into splunk-app/.
export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react()],
  build:
    mode === "splunk"
      ? {
          outDir: "../splunk-app/delvecat/appserver/static/build",
          emptyOutDir: true,
          copyPublicDir: false, // not the demo catalog; the Makefile adds reference/
          rollupOptions: {
            output: {
              entryFileNames: "delvecat.js",
              chunkFileNames: "chunks/[name]-[hash].js",
              assetFileNames: (info: { names?: string[] }) =>
                info.names?.some((n) => n.endsWith(".css")) ? "delvecat.css" : "assets/[name]-[hash][extname]",
            },
          },
        }
      : undefined,
}));
