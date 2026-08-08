import type { ProductScenario } from "./types";
import { BRAND_CONFIG } from "./brand";

function envString(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

export const PRODUCT = {
  brand: BRAND_CONFIG.brand,
  distribution: BRAND_CONFIG.distribution,
  repository: BRAND_CONFIG.repository,
  upstream: BRAND_CONFIG.upstream,
  billing: {
    currency: "USD",
    quotaPerUnit: 500_000,
    rechargePath: "/wallet",
  },
  newApiBaseUrl:
    envString(import.meta.env.VITE_NEWAPI_BASE_URL) ||
    envString(BRAND_CONFIG.service.defaultBaseUrl),
  managedProviderId: BRAND_CONFIG.compatibility.managedProviderId,
  scenarios: [
    {
      id: "claude",
      appId: "claude",
      groupAppId: "claude-code",
      tool: "claude",
      name: "Claude Code",
      shortName: "Claude",
      description: "在终端中完成代码理解、重构与复杂开发任务",
      accent: "#d97757",
      icon: "claude",
    },
    {
      id: "claude-desktop",
      appId: "claude-desktop",
      groupAppId: "claude-desktop",
      tool: null,
      name: "Claude Desktop",
      shortName: "Claude 客户端",
      description: "在桌面会话中使用 Claude，连接模型与 MCP 工具",
      accent: "#b85f3f",
      icon: "claude",
    },
    {
      id: "codex",
      appId: "codex",
      groupAppId: "codex",
      tool: "codex",
      name: "Codex（桌面端 / CLI）",
      shortName: "Codex",
      description: "在桌面端或终端中并行开发、审查代码与管理任务",
      desktopDownload: {
        label: "下载桌面端",
        url: "https://chatgpt.com/download/",
      },
      accent: "#10a37f",
      icon: "openai",
    },
    {
      id: "gemini",
      appId: "gemini",
      groupAppId: "gemini-cli",
      tool: "gemini",
      name: "Gemini CLI",
      shortName: "Gemini",
      description: "在终端中使用长上下文与多模态能力辅助开发",
      accent: "#5b7cfa",
      icon: "gemini",
    },
    {
      id: "openclaw",
      appId: "openclaw",
      groupAppId: "openclaw",
      tool: "openclaw",
      name: "OpenClaw（龙虾）",
      shortName: "龙虾",
      description: "连接本地工具与消息渠道，执行自动化智能体任务",
      accent: "#f97316",
      icon: "openclaw",
    },
    {
      id: "hermes",
      appId: "hermes",
      groupAppId: "hermes",
      tool: "hermes",
      name: "Hermes",
      shortName: "Hermes",
      description: "通过多模型、工具调用与长期记忆运行通用智能体",
      accent: "#0f9f8f",
      icon: "hermes",
    },
  ] satisfies ProductScenario[],
} as const;

export const IS_PRODUCT_PREVIEW_AVAILABLE =
  import.meta.env.DEV || import.meta.env.MODE === "qa";
