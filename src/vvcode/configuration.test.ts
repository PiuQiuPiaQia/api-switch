import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types";
import { PRODUCT } from "./config";
import {
  applyClaudeCoreModelRoutes,
  applyAgentModelCatalog,
  applyDshManagedSettings,
  applyDshManagedConfiguration,
  applyManagedDefaultModel,
  applyOpenCodeModelCatalog,
  buildManagedProvider,
  dshApiMode,
  dshScenarioFormat,
  parsePositiveLimit,
  protectedDshOutputLimit,
  resolveGroupConnection,
  resolveDshBaseUrl,
  validateManagedConnection,
} from "./configuration";
import type { NewApiGroup, NewApiModel, ProductScenario } from "./types";

const dshMocks = vi.hoisted(() => ({
  applyManagedProvider: vi.fn(),
}));

vi.mock("./api", () => ({
  dshApi: { applyManagedProvider: dshMocks.applyManagedProvider },
}));

const model: NewApiModel = {
  id: "model-primary",
  name: "Model Primary",
  description: "",
  vendor: "Vendor",
  quotaType: 0,
  modelRatio: 1,
  modelPrice: 0,
  completionRatio: 1,
};

const group: NewApiGroup = {
  id: "daily",
  name: "日常开发",
  description: "",
  ratio: "0.8",
  baseUrl: "https://fallback.example/v1",
  apiKey: "sk-fallback",
  defaultModelId: model.id,
  apiProvider: "openai",
  ccProvider: "openai",
  isDefault: true,
  models: [model],
  connections: {
    claude: {
      baseUrl: "https://claude.example",
      apiKey: "sk-claude",
      apiFormat: "anthropic",
    },
    codex: {
      baseUrl: "https://codex.example/v1",
      apiKey: "sk-codex",
      apiFormat: "openai_responses",
    },
  },
};

const openCodeScenario: ProductScenario = {
  id: "opencode",
  appId: "opencode",
  groupAppId: "opencode",
  tool: "opencode",
  name: "OpenCode",
  shortName: "OpenCode",
  description: "",
  accent: "#8b5cf6",
  icon: "opencode",
};

function scenario(id: ProductScenario["id"]): ProductScenario {
  if (id === "opencode") return openCodeScenario;
  return PRODUCT.scenarios.find((item) => item.id === id)!;
}

describe("managed provider configuration", () => {
  it("uses the scenario-specific connection before the group fallback", () => {
    expect(resolveGroupConnection(scenario("claude"), group)).toEqual(
      group.connections?.claude,
    );
    expect(resolveGroupConnection(scenario("gemini"), group)).toMatchObject({
      baseUrl: group.baseUrl,
      apiKey: group.apiKey,
    });
    expect(resolveGroupConnection(scenario("claude-desktop"), group)).toEqual(
      group.connections?.claude,
    );
  });

  it("overrides every scenario with the selected global Base URL", () => {
    expect(
      resolveGroupConnection(
        scenario("claude"),
        group,
        "https://cf.vvcode.top",
      ),
    ).toEqual({
      ...group.connections?.claude,
      baseUrl: "https://cf.vvcode.top",
    });

    const provider = buildManagedProvider(
      scenario("codex"),
      group,
      null,
      "https://hk.vvcode.top",
    );
    expect(provider.settingsConfig.config).toContain(
      'base_url = "https://hk.vvcode.top/v1"',
    );
    expect(provider.settingsConfig.auth.OPENAI_API_KEY).toBe("sk-codex");
  });

  it("builds Claude Code environment variables from the selected group", () => {
    const provider = buildManagedProvider(scenario("claude"), group);
    expect(provider.id).toBe(PRODUCT.managedProviderId);
    expect(provider.settingsConfig.env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://claude.example",
      ANTHROPIC_AUTH_TOKEN: "sk-claude",
    });
    expect(provider.settingsConfig.env).not.toHaveProperty("ANTHROPIC_MODEL");
  });

  it("builds an independent Claude Desktop direct profile", () => {
    const provider = buildManagedProvider(scenario("claude-desktop"), group);

    expect(provider.settingsConfig.env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://claude.example",
      ANTHROPIC_AUTH_TOKEN: "sk-claude",
    });
    expect(provider.meta).toMatchObject({
      claudeDesktopMode: "direct",
      apiFormat: "anthropic",
      claudeDesktopModelRoutes: {},
    });
  });

  it("builds Codex auth and custom provider TOML without forcing a model", () => {
    const provider = buildManagedProvider(scenario("codex"), group);
    expect(provider.settingsConfig.auth.OPENAI_API_KEY).toBe("sk-codex");
    expect(provider.settingsConfig.config).toContain(
      'base_url = "https://codex.example/v1"',
    );
    expect(provider.settingsConfig.config).not.toContain("model =");
    expect(provider.settingsConfig.config).toContain('wire_api = "responses"');
  });

  it("maps a Codex chat connection to the matching wire API", () => {
    const chatGroup: NewApiGroup = {
      ...group,
      connections: {
        ...group.connections,
        codex: {
          baseUrl: "https://chat.example/v1",
          apiKey: "sk-chat",
          apiFormat: "openai_chat",
        },
      },
    };
    const provider = buildManagedProvider(scenario("codex"), chatGroup);
    expect(provider.settingsConfig.config).toContain('wire_api = "chat"');
  });

  it("updates an existing Codex provider when the connection protocol changes", () => {
    const existing = buildManagedProvider(scenario("codex"), group);
    const chatGroup: NewApiGroup = {
      ...group,
      connections: {
        ...group.connections,
        codex: {
          baseUrl: "https://chat.example/v1",
          apiKey: "sk-chat",
          apiFormat: "openai_chat",
        },
      },
    };

    const provider = buildManagedProvider(
      scenario("codex"),
      chatGroup,
      existing,
    );
    expect(provider.settingsConfig.config).toContain('wire_api = "chat"');
    expect(provider.meta?.apiFormat).toBe("openai_chat");
  });

  it("rejects unsafe inference endpoints before writing local config", () => {
    expect(() =>
      validateManagedConnection({
        baseUrl: "http://gateway.example/v1",
        apiKey: "sk-test",
      }),
    ).toThrow("必须使用 HTTPS");
    expect(() =>
      validateManagedConnection({
        baseUrl: "file:///tmp/gateway",
        apiKey: "sk-test",
      }),
    ).toThrow("HTTP(S)");
  });

  it("builds Gemini and OpenCode credentials without forcing model config", () => {
    const gemini = buildManagedProvider(scenario("gemini"), group);
    expect(gemini.settingsConfig.env).toMatchObject({
      GOOGLE_GEMINI_BASE_URL: group.baseUrl,
      GEMINI_API_KEY: group.apiKey,
    });
    expect(gemini.settingsConfig.env).not.toHaveProperty("GEMINI_MODEL");

    const opencode = buildManagedProvider(scenario("opencode"), group);
    expect(opencode.settingsConfig.options).toMatchObject({
      baseURL: group.baseUrl,
      apiKey: group.apiKey,
    });
    expect(opencode.settingsConfig.models).toEqual({});
  });

  it("builds OpenClaw and Hermes providers with their native config shapes", () => {
    const openclaw = buildManagedProvider(scenario("openclaw"), group);
    expect(openclaw.settingsConfig).toMatchObject({
      baseUrl: group.baseUrl,
      apiKey: group.apiKey,
      api: "openai-completions",
      models: [],
    });

    const hermes = buildManagedProvider(scenario("hermes"), group);
    expect(hermes.settingsConfig).toMatchObject({
      name: PRODUCT.managedProviderId,
      base_url: group.baseUrl,
      api_key: group.apiKey,
      api_mode: "chat_completions",
      models: [],
    });
  });

  it("maps Anthropic connections for OpenClaw and Hermes", () => {
    const anthropicGroup: NewApiGroup = {
      ...group,
      connections: {
        ...group.connections,
        openclaw: {
          baseUrl: "https://anthropic.example",
          apiKey: "sk-claw",
          apiFormat: "anthropic",
        },
        hermes: {
          baseUrl: "https://anthropic.example",
          apiKey: "sk-hermes",
          apiFormat: "anthropic",
        },
      },
    };

    expect(
      buildManagedProvider(scenario("openclaw"), anthropicGroup).settingsConfig,
    ).toMatchObject({
      baseUrl: "https://anthropic.example",
      api: "anthropic-messages",
    });
    expect(
      buildManagedProvider(scenario("hermes"), anthropicGroup).settingsConfig,
    ).toMatchObject({
      base_url: "https://anthropic.example",
      api_mode: "anthropic_messages",
    });
  });

  it("forces the managed Claude protocol defaults while preserving other settings", () => {
    const existing = buildManagedProvider(
      scenario("claude"),
      group,
    ) as Provider;
    existing.settingsConfig = {
      ...existing.settingsConfig,
      attribution: { commit: "", pr: "" },
      env: {
        ...existing.settingsConfig.env,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "model-fast",
        ENABLE_TOOL_SEARCH: "true",
      },
    };
    existing.meta = {
      ...existing.meta,
      apiFormat: "openai_chat",
      apiKeyField: "ANTHROPIC_API_KEY",
      customUserAgent: "vv-code-test",
    };

    const rebased = buildManagedProvider(scenario("claude"), group, existing);

    expect(rebased.settingsConfig.attribution).toEqual({
      commit: "",
      pr: "",
    });
    expect(rebased.settingsConfig.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "sk-claude",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "model-fast",
      ENABLE_TOOL_SEARCH: "true",
    });
    expect(rebased.settingsConfig.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(rebased.meta).toMatchObject({
      apiFormat: "anthropic",
      apiKeyField: "ANTHROPIC_AUTH_TOKEN",
      customUserAgent: "vv-code-test",
    });
  });

  it("applies core Claude routes without changing hidden Switch settings", () => {
    const provider = buildManagedProvider(
      scenario("claude"),
      group,
    ) as Provider;
    provider.settingsConfig.env = {
      ...provider.settingsConfig.env,
      ANTHROPIC_DEFAULT_FABLE_MODEL: "model-old",
      CLAUDE_CODE_SUBAGENT_MODEL: "model-old",
      ANTHROPIC_SMALL_FAST_MODEL: "model-fast-old",
    };

    const configured = applyClaudeCoreModelRoutes(provider, {
      sonnet: "model-sonnet",
      opus: "model-opus",
      haiku: "model-haiku",
    });

    expect(configured.settingsConfig.env).toMatchObject({
      ANTHROPIC_DEFAULT_SONNET_MODEL: "model-sonnet",
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "model-sonnet",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "model-opus",
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "model-opus",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "model-haiku",
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "model-haiku",
    });
    expect(configured.settingsConfig.env).toMatchObject({
      ANTHROPIC_DEFAULT_FABLE_MODEL: "model-old",
      CLAUDE_CODE_SUBAGENT_MODEL: "model-old",
      ANTHROPIC_SMALL_FAST_MODEL: "model-fast-old",
    });
  });

  it("keeps optional model fields empty until the user configures them", () => {
    const claude = applyClaudeCoreModelRoutes(
      buildManagedProvider(scenario("claude"), group),
      { sonnet: "", opus: "", haiku: "" },
    );
    const codex = applyManagedDefaultModel(
      scenario("codex"),
      buildManagedProvider(scenario("codex"), group),
      "",
    );
    const gemini = applyManagedDefaultModel(
      scenario("gemini"),
      buildManagedProvider(scenario("gemini"), group),
      "",
    );
    const opencode = applyOpenCodeModelCatalog(
      buildManagedProvider(scenario("opencode"), group),
      [],
    );

    expect(claude.settingsConfig.env).not.toHaveProperty(
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
    );
    expect(codex.settingsConfig.config).not.toContain("model =");
    expect(gemini.settingsConfig.env).not.toHaveProperty("GEMINI_MODEL");
    expect(opencode.settingsConfig.models).toEqual({});
  });

  it("applies the optional model configuration only after explicit input", () => {
    const codex = applyManagedDefaultModel(
      scenario("codex"),
      buildManagedProvider(scenario("codex"), group),
      "model-codex",
    );
    const gemini = applyManagedDefaultModel(
      scenario("gemini"),
      buildManagedProvider(scenario("gemini"), group),
      "model-gemini",
    );
    const opencode = applyOpenCodeModelCatalog(
      buildManagedProvider(scenario("opencode"), group),
      [{ id: "model-open", name: "Open" }],
    );

    expect(codex.settingsConfig.config).toContain('model = "model-codex"');
    expect(gemini.settingsConfig.env.GEMINI_MODEL).toBe("model-gemini");
    expect(opencode.settingsConfig.models).toEqual({
      "model-open": { name: "Open" },
    });

    const openclaw = applyAgentModelCatalog(
      scenario("openclaw"),
      buildManagedProvider(scenario("openclaw"), group),
      [{ id: "model-claw", name: "Claw" }],
    );
    const hermes = applyAgentModelCatalog(
      scenario("hermes"),
      buildManagedProvider(scenario("hermes"), group),
      [{ id: "model-hermes", name: "Hermes" }],
    );
    expect(openclaw.settingsConfig.models).toEqual([
      { id: "model-claw", name: "Claw" },
    ]);
    expect(hermes.settingsConfig.models).toEqual([
      { id: "model-hermes", name: "Hermes" },
    ]);
  });
});

describe("dsh managed provider", () => {
  const dshGroup: NewApiGroup = {
    ...group,
    connections: {
      dsh: {
        baseUrl: "https://dsh.example/v1",
        apiKey: "sk-dsh",
        apiFormat: "openai_responses",
      },
    },
  };

  beforeEach(() => {
    dshMocks.applyManagedProvider.mockReset();
  });

  it("maps each explicit scenario protocol to its Dsh wire protocol", () => {
    expect(dshApiMode("openai_chat")).toBe("openai-completions");
    expect(dshApiMode("openai_responses")).toBe("openai-responses");
    expect(dshApiMode("anthropic")).toBe("anthropic-messages");
    expect(dshApiMode(undefined)).toBeNull();

    expect(dshScenarioFormat("openai-completions")).toBe("openai_chat");
    expect(dshScenarioFormat("openai-responses")).toBe("openai_responses");
    expect(dshScenarioFormat("anthropic-messages")).toBe("anthropic");
  });

  it("builds a Dsh provider from an explicit protocol connection", () => {
    const provider = buildManagedProvider(scenario("dsh"), dshGroup);
    expect(provider.id).toBe(PRODUCT.managedProviderId);
    expect(provider.settingsConfig.api).toBe("openai-responses");
    expect(provider.settingsConfig.options).toEqual({
      baseURL: "https://dsh.example/v1",
      apiKey: "sk-dsh",
    });
    expect(provider.meta?.apiFormat).toBe("openai_responses");
  });

  it("does not guess a Dsh protocol when the website group omits one", () => {
    const provider = buildManagedProvider(scenario("dsh"), group);
    expect(provider.settingsConfig.api).toBeUndefined();
    expect(provider.settingsConfig.options.baseURL).toBe(
      "https://fallback.example/v1",
    );
    expect(provider.meta?.apiFormat).toBeUndefined();
  });

  it("preserves the user-selected Dsh protocol across rebuilds", () => {
    // The group exposes no protocol; the previous saved choice must survive
    // a rebuild instead of being reset to an inferred default.
    const applied = buildManagedProvider(scenario("dsh"), group, {
      id: PRODUCT.managedProviderId,
      name: `${PRODUCT.brand.name} · ${group.name}`,
      settingsConfig: {
        api: "anthropic-messages",
        options: {
          baseURL: "https://fallback.example/v1",
          apiKey: "sk-fallback",
        },
        models: { "claude-sonnet": { name: "Sonnet" } },
        defaultModel: "claude-sonnet",
      },
    });
    expect(applied.settingsConfig.api).toBe("anthropic-messages");
    expect(applied.settingsConfig.models).toEqual({
      "claude-sonnet": { name: "Sonnet" },
    });
    expect(applied.settingsConfig.defaultModel).toBe("claude-sonnet");
    expect(applied.meta?.apiFormat).toBe("anthropic");
  });

  it("applies form state as a single-protocol catalog with a default model", () => {
    const base = buildManagedProvider(scenario("dsh"), dshGroup);
    const provider = applyDshManagedSettings(
      base,
      "anthropic-messages",
      [
        { id: "claude-sonnet", name: "  ", context: "200000", output: "64000" },
        { id: "  ", name: "dropped", context: "1", output: "1" },
        {
          id: "claude-opus",
          name: "Opus",
          context: "not-a-number",
          output: "-5",
        },
      ],
      "claude-sonnet",
    );

    expect(provider.settingsConfig.api).toBe("anthropic-messages");
    // Invalid ids are dropped; blank names fall back to the model id; invalid
    // limits are ignored rather than invented. Output 64000 on a 200000
    // window is protected down to window/4 = 50000.
    expect(provider.settingsConfig.models).toEqual({
      "claude-sonnet": {
        name: "claude-sonnet",
        limit: { context: 200000, output: 50000 },
      },
      "claude-opus": { name: "Opus" },
    });
    expect(provider.settingsConfig.defaultModel).toBe("claude-sonnet");
    // Dsh's Anthropic SDK appends /v1/messages itself, so a standard /v1
    // suffix on the connection is stripped instead of being doubled.
    expect(provider.settingsConfig.options.baseURL).toBe(
      "https://dsh.example",
    );
    expect(provider.settingsConfig.options.apiKey).toBe("sk-dsh");
    expect(provider.meta?.apiFormat).toBe("anthropic");
  });

  it("adds the conventional /v1 path when an OpenAI protocol has none", () => {
    const originOnlyGroup: NewApiGroup = {
      ...group,
      baseUrl: "https://dsh.example",
      connections: {
        dsh: {
          baseUrl: "https://dsh.example",
          apiKey: "sk-dsh",
          apiFormat: "openai_chat",
        },
      },
    };
    const base = buildManagedProvider(scenario("dsh"), originOnlyGroup);
    const provider = applyDshManagedSettings(
      base,
      "openai-completions",
      [],
      "",
    );
    expect(provider.settingsConfig.options.baseURL).toBe(
      "https://dsh.example/v1",
    );
    expect(provider.settingsConfig.models).toEqual({});
    expect("defaultModel" in provider.settingsConfig).toBe(false);
  });

  it("requires a protocol and a catalog-listed default model", () => {
    const base = buildManagedProvider(scenario("dsh"), dshGroup);
    expect(() =>
      applyDshManagedSettings(
        base,
        "",
        [{ id: "m", name: "", context: "", output: "" }],
        "",
      ),
    ).toThrow("请先为 Dsh 托管供应商选择模型协议");
    expect(() =>
      applyDshManagedSettings(
        base,
        "openai-responses",
        [{ id: "m", name: "", context: "", output: "" }],
        "missing-model",
      ),
    ).toThrow("默认模型不在模型列表中");
  });

  it("keeps the protocol endpoint when rebuilding and reapplying an origin-only group", async () => {
    const originGroup = { ...group, connections: undefined, baseUrl: "https://gateway.example" };
    const base = buildManagedProvider(scenario("dsh"), originGroup);
    const applied = applyDshManagedSettings(base, "openai-responses", [{ id: "test", name: "Test", context: "", output: "" }], "test");
    const rebuilt = buildManagedProvider(scenario("dsh"), originGroup, applied);
    expect(rebuilt.settingsConfig.options.baseURL).toBe("https://gateway.example/v1");
    dshMocks.applyManagedProvider.mockResolvedValue({profileNames:["web"], conflicts:[], warnings:[]});
    await applyDshManagedConfiguration(rebuilt);
    expect(dshMocks.applyManagedProvider.mock.calls[0][0].settingsConfig.options.baseURL).toBe("https://gateway.example/v1");
  });

  it("switches standard SDK paths without stripping custom prefixes", () => {
    expect(resolveDshBaseUrl("https://gateway.example/v1", "anthropic-messages")).toBe("https://gateway.example");
    expect(resolveDshBaseUrl("https://gateway.example/team/v1", "anthropic-messages")).toBe("https://gateway.example/team");
    expect(resolveDshBaseUrl("https://gateway.example/anthropic", "anthropic-messages")).toBe("https://gateway.example/anthropic");
    expect(resolveDshBaseUrl("https://gateway.example", "openai-completions")).toBe("https://gateway.example/v1");
    expect(resolveDshBaseUrl("https://gateway.example/api/paas/v4", "openai-responses")).toBe("https://gateway.example/api/paas/v4");
  });

  it("caps output limits to keep Dsh compaction budget", () => {
    // Magpie-derived protection: min(output, max(1, max(window/4,
    // window/2 - 65536))) — only with a real context figure.
    expect(protectedDshOutputLimit(500_000, 393_216)).toBe(184_464);
    expect(protectedDshOutputLimit(131_072, 65_536)).toBe(32_768);
    expect(protectedDshOutputLimit(1_000_000, 393_216)).toBe(393_216);
    // No context figure: never invent one, keep the entered limit as-is.
    expect(protectedDshOutputLimit(undefined, 8_192)).toBe(8_192);
    expect(protectedDshOutputLimit(undefined, undefined)).toBeUndefined();
    // Context without an output limit still reserves a protected budget.
    expect(protectedDshOutputLimit(100_000, undefined)).toBe(25_000);
  });

  it("parses only positive finite limits from user input", () => {
    expect(parsePositiveLimit(" 4096 ")).toBe(4096);
    expect(parsePositiveLimit("12.9")).toBeUndefined();
    expect(parsePositiveLimit("0.5")).toBeUndefined();
    expect(parsePositiveLimit(2048)).toBe(2048);
    expect(parsePositiveLimit("0")).toBeUndefined();
    expect(parsePositiveLimit("-3")).toBeUndefined();
    expect(parsePositiveLimit("abc")).toBeUndefined();
    expect(parsePositiveLimit("")).toBeUndefined();
  });

  it("applies through the dedicated backend command, never providers add/switch", async () => {
    const status = {
      profileNames: ["default", "work"],
      conflicts: [],
      warnings: [],
      managed: true,
    };
    dshMocks.applyManagedProvider.mockResolvedValue(status);
    const provider = applyDshManagedSettings(
      buildManagedProvider(scenario("dsh"), dshGroup),
      "openai-responses",
      [{ id: "gpt-5.4", name: "GPT", context: "400000", output: "128000" }],
      "gpt-5.4",
    );

    const result = await applyDshManagedConfiguration(provider);

    expect(result).toEqual(status);
    expect(dshMocks.applyManagedProvider).toHaveBeenCalledOnce();
    expect(dshMocks.applyManagedProvider.mock.calls[0][0]).toBe(provider);
  });

  it("rejects invalid payloads locally before reaching the backend", async () => {
    // The website group exposes no protocol and the form never applied one.
    const provider = buildManagedProvider(scenario("dsh"), group);
    await expect(applyDshManagedConfiguration(provider)).rejects.toThrow(
      "Dsh 托管配置缺少有效的模型协议",
    );

    const wrongId = applyDshManagedSettings(
      buildManagedProvider(scenario("dsh"), dshGroup),
      "openai-responses",
      [{ id: "m", name: "", context: "", output: "" }],
      "",
    );
    await expect(
      applyDshManagedConfiguration({ ...wrongId, id: "other-provider" }),
    ).rejects.toThrow("托管供应商标识无效");
    expect(dshMocks.applyManagedProvider).not.toHaveBeenCalled();
  });
});
