export interface ProductRuntimeConfig {
  readonly name: string;
  readonly websiteUrl: string;
  readonly configDirName: string;
  readonly syncRoot: string;
  readonly userAgent: string;
}

// 中性构建扩展点：值由发行层的 Vite 配置注入，共享代码无需依赖 vvcode。
export const PRODUCT_RUNTIME: ProductRuntimeConfig = __PRODUCT_RUNTIME_CONFIG__;
