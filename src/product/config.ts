import type { ProductScenario } from "./types";

function envString(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

export const PRODUCT = {
  brand: {
    name: "VV Code",
    tagline: "一个账号，连接你的 AI 开发工作流",
    websiteUrl: "https://vvcode.top/",
  },
  billing: {
    currency: "USD",
    quotaPerUnit: 500_000,
    rechargePath: "/wallet",
  },
  newApiBaseUrl: envString(import.meta.env.VITE_NEWAPI_BASE_URL),
  managedProviderId: "vv-code-managed",
  scenarios: [
    {
      id: "claude",
      appId: "claude",
      tool: "claude",
      name: "Claude Code",
      shortName: "Claude",
      description: "适合复杂代码理解、重构与代理式开发",
      accent: "#d97757",
      icon: "spark",
    },
    {
      id: "codex",
      appId: "codex",
      tool: "codex",
      name: "Codex CLI",
      shortName: "Codex",
      description: "面向工程任务的高效终端编码助手",
      accent: "#10a37f",
      icon: "terminal",
    },
    {
      id: "gemini",
      appId: "gemini",
      tool: "gemini",
      name: "Gemini CLI",
      shortName: "Gemini",
      description: "长上下文与多模态能力驱动的开发体验",
      accent: "#5b7cfa",
      icon: "gem",
    },
    {
      id: "opencode",
      appId: "opencode",
      tool: "opencode",
      name: "OpenCode",
      shortName: "OpenCode",
      description: "开放灵活的多模型终端智能体",
      accent: "#8b5cf6",
      icon: "blocks",
    },
  ] satisfies ProductScenario[],
} as const;

export const IS_PRODUCT_PREVIEW_AVAILABLE =
  import.meta.env.DEV || import.meta.env.MODE === "qa";
