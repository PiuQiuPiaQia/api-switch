import { createInstance } from "i18next";
import zh from "@/i18n/locales/zh.json";
import { BRAND_CONFIG, defaultConfigPath } from "./brand";
import { applyProductBranding } from "./branding";

describe("product branding", () => {
  it("injects the configured brand into document metadata and translations", async () => {
    const i18n = createInstance();
    await i18n.init({
      lng: "zh",
      resources: { zh: { translation: zh } },
      interpolation: { escapeValue: false },
    });
    applyProductBranding(i18n);

    expect(document.title).toBe(BRAND_CONFIG.brand.name);
    expect(i18n.t("app.title")).toBe(BRAND_CONFIG.brand.name);
    expect(i18n.t("settings.launchOnStartupDescription")).toContain(
      BRAND_CONFIG.brand.name,
    );
  });

  it("derives the default config path from the configured directory", () => {
    expect(defaultConfigPath()).toBe(
      `~/${BRAND_CONFIG.distribution.configDirName}/config.json`,
    );
  });
});
