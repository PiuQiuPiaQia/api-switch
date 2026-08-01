import { describe, expect, it } from "vitest";
import type { Provider } from "@/types";
import { PRODUCT } from "./config";
import {
  applyClaudeCoreModelRoutes,
  applyManagedDefaultModel,
  applyOpenCodeModelCatalog,
  buildManagedProvider,
  resolveGroupConnection,
  validateManagedConnection,
} from "./configuration";
import type { NewApiGroup, NewApiModel, ProductScenario } from "./types";

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

function scenario(id: ProductScenario["id"]): ProductScenario {
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
  });
});
