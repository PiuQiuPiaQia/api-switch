import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import brandConfig from "./src/vvcode/brand.config.json";

export default defineConfig({
  define: {
    __PRODUCT_RUNTIME_CONFIG__: JSON.stringify({
      name: brandConfig.brand.name,
      websiteUrl: brandConfig.brand.websiteUrl,
      configDirName: brandConfig.distribution.configDirName,
      syncRoot: brandConfig.distribution.syncRoot,
      userAgent: brandConfig.distribution.userAgent,
    }),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setupGlobals.ts", "./tests/setupTests.ts"],
    globals: true,
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
});
