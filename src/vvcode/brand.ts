import rawBrandConfig from "./brand.config.json";

export interface BrandConfig {
  readonly schemaVersion: number;
  readonly brand: {
    readonly name: string;
    readonly tagline: string;
    readonly description: string;
    readonly websiteUrl: string;
  };
  readonly distribution: {
    readonly packageName: string;
    readonly publisherName: string;
    readonly bundleIdentifier: string;
    readonly configDirName: string;
    readonly databaseFileName: string;
    readonly logFileName: string;
    readonly syncRoot: string;
    readonly themeStorageKey: string;
    readonly userAgent: string;
  };
  readonly service: {
    readonly defaultBaseUrl: string;
  };
  readonly repository: {
    readonly url: string;
    readonly issuesUrl: string;
    readonly releasesUrl: string;
    readonly githubReleasesApiUrl: string;
  };
  readonly upstream: {
    readonly name: string;
    readonly url: string;
  };
  readonly compatibility: {
    readonly managedProviderId: string;
  };
}

// JSON 是品牌配置的唯一事实源；类型检查负责阻止字段在代码侧悄悄漂移。
export const BRAND_CONFIG: BrandConfig = rawBrandConfig;

export function defaultConfigPath(homePrefix = "~"): string {
  return `${homePrefix}/${BRAND_CONFIG.distribution.configDirName}/config.json`;
}
