/// <reference types="vite/client" />

declare global {
  const __PRODUCT_RUNTIME_CONFIG__: Readonly<{
    name: string;
    websiteUrl: string;
    configDirName: string;
    syncRoot: string;
    userAgent: string;
  }>;
}

export {};
