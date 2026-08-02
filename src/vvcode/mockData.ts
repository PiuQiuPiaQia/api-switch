import type { NewApiBootstrap, NewApiInfoRoute, NewApiSession } from "./types";

const model = (
  id: string,
  vendor: string,
  modelRatio: number,
  description: string,
) => ({
  id,
  name: id,
  description,
  vendor,
  quotaType: 0,
  modelRatio,
  modelPrice: 0,
  completionRatio: 1,
});

export const previewSession: NewApiSession = {
  serverUrl: "https://vvcode.top",
  userId: 1024,
  username: "preview",
  displayName: "体验用户",
  role: 1,
  createdAt: Math.floor(Date.now() / 1000),
};

export const previewApiInfoRoutes: NewApiInfoRoute[] = [
  {
    id: "1",
    route: "默认线路",
    description: "默认",
    url: "https://vvcode.top",
    color: "green",
  },
  {
    id: "2",
    route: "CF全球加速",
    description: "CF全球加速",
    url: "https://cf.vvcode.top",
    color: "orange",
  },
  {
    id: "3",
    route: "香港节点",
    description: "香港节点",
    url: "https://hk.vvcode.top",
    color: "red",
  },
];

export const previewBootstrap: NewApiBootstrap = {
  source: "preview",
  user: {
    id: 1024,
    username: "preview",
    displayName: "体验用户",
    email: "preview@vvcode.top",
    role: 1,
    status: 1,
    group: "pro",
    quota: 12_500_000,
    usedQuota: 3_720_000,
    requestCount: 1842,
  },
  groups: [
    {
      id: "daily",
      name: "日常开发",
      description: "均衡速度与成本，适合日常编码任务",
      ratio: "1.0",
      baseUrl: "https://vvcode.top/v1",
      apiKey: "sk-preview-daily-not-a-real-key",
      defaultModelId: "claude-sonnet-4-6",
      apiProvider: "anthropic",
      ccProvider: "anthropic",
      isDefault: true,
      models: [
        model("claude-sonnet-4-6", "Anthropic", 1, "编码与推理的均衡选择"),
        model("gpt-5.4", "OpenAI", 1.15, "通用工程与工具调用"),
        model("gemini-3.1-pro", "Google", 0.9, "超长上下文与多模态"),
      ],
    },
    {
      id: "performance",
      name: "高性能",
      description: "优先质量与稳定性，适合复杂代理任务",
      ratio: "1.5",
      baseUrl: "https://vvcode.top/v1",
      apiKey: "sk-preview-performance-not-a-real-key",
      defaultModelId: "claude-opus-4-6",
      apiProvider: "anthropic",
      ccProvider: "anthropic",
      isDefault: false,
      models: [
        model("claude-opus-4-6", "Anthropic", 2.5, "复杂推理与大型重构"),
        model("gpt-5.4-pro", "OpenAI", 2.2, "高精度工程任务"),
      ],
    },
    {
      id: "economy",
      name: "经济优先",
      description: "高性价比，适合高频轻量任务",
      ratio: "0.45",
      baseUrl: "https://vvcode.top/v1",
      apiKey: "sk-preview-economy-not-a-real-key",
      defaultModelId: "deepseek-v4",
      apiProvider: "openai",
      ccProvider: "openai",
      isDefault: false,
      models: [
        model("deepseek-v4", "DeepSeek", 0.35, "快速编码与批量处理"),
        model("gemini-3.1-flash", "Google", 0.25, "低延迟长文本任务"),
      ],
    },
  ],
};
