import type { i18n } from "i18next";
import { BRAND_CONFIG } from "./brand";

export function applyProductBranding(i18nInstance: i18n): void {
  if (typeof document !== "undefined") {
    document.title = BRAND_CONFIG.brand.name;
  }

  const interpolation = i18nInstance.options.interpolation;
  i18nInstance.options.interpolation = {
    ...(typeof interpolation === "object" ? interpolation : {}),
    defaultVariables: {
      brandName: BRAND_CONFIG.brand.name,
      packageName: BRAND_CONFIG.distribution.packageName,
      upstreamName: BRAND_CONFIG.upstream.name,
      configDirName: BRAND_CONFIG.distribution.configDirName,
      databaseFileName: BRAND_CONFIG.distribution.databaseFileName,
      logFileName: BRAND_CONFIG.distribution.logFileName,
      syncRoot: BRAND_CONFIG.distribution.syncRoot,
    },
  };
}
