import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "path";

const host = process.env.TAURI_DEV_HOST;
const require = createRequire(import.meta.url);

async function preparePdfJsAssets() {
  const packageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const targetRoot = path.resolve(__dirname, "public/vendor/pdfjs");
  await fs.rm(targetRoot, { force: true, recursive: true });
  await fs.mkdir(targetRoot, { recursive: true });
  await Promise.all(
    ["cmaps", "iccs", "standard_fonts", "wasm"].map((directory) =>
      fs.cp(
        path.join(packageRoot, directory),
        path.join(targetRoot, directory),
        {
          recursive: true,
        },
      ),
    ),
  );
  await fs.copyFile(
    path.join(packageRoot, "LICENSE"),
    path.join(targetRoot, "LICENSE"),
  );
}

export default defineConfig(async () => {
  await preparePdfJsAssets();
  return {
    plugins: [
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        routesDirectory: "./src/routes",
        generatedRouteTree: "./src/routeTree.gen.ts",
      }),
      paraglideVitePlugin({
        project: "./project.inlang",
        outdir: "./src/paraglide",
      }),
      tailwindcss(),
      react(),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    optimizeDeps: {
      exclude: ["@silurus/ooxml"],
    },
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
