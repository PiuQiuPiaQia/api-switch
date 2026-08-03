import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";
import brandConfig from "./src/vvcode/brand.config.json";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export default defineConfig(({ command }) => ({
  define: {
    __PRODUCT_RUNTIME_CONFIG__: JSON.stringify({
      name: brandConfig.brand.name,
      websiteUrl: brandConfig.brand.websiteUrl,
      configDirName: brandConfig.distribution.configDirName,
      syncRoot: brandConfig.distribution.syncRoot,
      userAgent: brandConfig.distribution.userAgent,
    }),
  },
  root: "src",
  envDir: "..",
  plugins: [
    {
      name: "product-brand-html",
      transformIndexHtml(html) {
        return html.replaceAll(
          "__PRODUCT_BRAND_NAME__",
          escapeHtml(brandConfig.brand.name),
        );
      },
    },
    command === "serve" &&
      codeInspectorPlugin({
        bundler: "vite",
      }),
    react(),
  ].filter(Boolean),
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
}));
