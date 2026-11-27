import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// SQLite's package also ships a worker for its own messaging API and a helper for its
// other OPFS mode; the console uses neither (it has its own worker and the sahpool VFS),
// so they are left out of the build (about 250 KB).
const dropUnusedSqliteHelpers = {
  name: "drop-unused-sqlite-helpers",
  writeBundle(options: { dir?: string }) {
    const assets = join(options.dir ?? "dist", "assets");
    if (!existsSync(assets)) return;
    for (const name of readdirSync(assets)) if (/^sqlite3-(worker1|opfs-async-proxy)-/.test(name)) rmSync(join(assets, name));
  },
};

// Relative base + hash routing lets the build run from any GitHub Pages path.
// `vite build --mode splunk` builds the page of the Splunk app instead: fixed entry
// names (the app's page template refers to them) written into splunk-app/.
export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react(), dropUnusedSqliteHelpers],
  // The SQL console's saved database belongs to one build: a new build fills it again.
  define: { __DELVECAT_BUILD__: JSON.stringify(new Date().toISOString()) },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
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
