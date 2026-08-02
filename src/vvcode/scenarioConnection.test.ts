import { describe, expect, it } from "vitest";
import { PRODUCT } from "./config";
import {
  resolveGroupConnection,
  resolveScenarioBaseUrl,
} from "./scenarioConnection";
import type { NewApiGroup, ProductScenario } from "./types";

const group: NewApiGroup = {
  id: "default",
  name: "Default",
  description: "",
  ratio: "1",
  baseUrl: "https://vvcode.top",
  apiKey: "sk-test",
  defaultModelId: "",
  apiProvider: "openai",
  ccProvider: "openai",
  isDefault: true,
  models: [],
};

const openCodeScenario: ProductScenario = {
  id: "opencode",
  appId: "opencode",
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

describe("scenario connection resolution", () => {
  it("adds /v1 to origin-only Codex and OpenAI-compatible OpenCode routes", () => {
    expect(resolveGroupConnection(scenario("codex"), group).baseUrl).toBe(
      "https://vvcode.top/v1",
    );
    expect(resolveGroupConnection(scenario("opencode"), group).baseUrl).toBe(
      "https://vvcode.top/v1",
    );
    expect(resolveGroupConnection(scenario("openclaw"), group).baseUrl).toBe(
      "https://vvcode.top/v1",
    );
    expect(resolveGroupConnection(scenario("hermes"), group).baseUrl).toBe(
      "https://vvcode.top/v1",
    );
  });

  it("keeps Anthropic and Gemini native routes origin-only", () => {
    expect(resolveGroupConnection(scenario("claude"), group).baseUrl).toBe(
      "https://vvcode.top",
    );
    expect(resolveGroupConnection(scenario("gemini"), group).baseUrl).toBe(
      "https://vvcode.top",
    );
    expect(
      resolveGroupConnection(scenario("claude-desktop"), group).baseUrl,
    ).toBe("https://vvcode.top");
  });

  it("lets Claude Desktop override or inherit the Claude connection", () => {
    const withConnections: NewApiGroup = {
      ...group,
      connections: {
        claude: {
          baseUrl: "https://claude.example",
          apiKey: "sk-claude",
          apiFormat: "anthropic",
        },
      },
    };

    expect(
      resolveGroupConnection(scenario("claude-desktop"), withConnections),
    ).toMatchObject({
      baseUrl: "https://claude.example",
      apiKey: "sk-claude",
      apiFormat: "anthropic",
    });

    withConnections.connections!["claude-desktop"] = {
      baseUrl: "https://desktop.example/v1",
      apiKey: "sk-desktop",
      apiFormat: "openai-chat",
    };
    expect(
      resolveGroupConnection(scenario("claude-desktop"), withConnections),
    ).toMatchObject({
      baseUrl: "https://desktop.example/v1",
      apiKey: "sk-desktop",
      apiFormat: "openai_chat",
    });
  });

  it("moves the scenario path to the selected route origin", () => {
    const withConnections: NewApiGroup = {
      ...group,
      connections: {
        codex: {
          baseUrl: "https://vvcode.top/v1",
          apiKey: "sk-codex",
          apiFormat: "openai_responses",
        },
        claude: {
          baseUrl: "https://vvcode.top/api/anthropic",
          apiKey: "sk-claude",
          apiFormat: "anthropic",
        },
      },
    };

    expect(
      resolveGroupConnection(
        scenario("codex"),
        withConnections,
        "https://cf.vvcode.top",
      ).baseUrl,
    ).toBe("https://cf.vvcode.top/v1");
    expect(
      resolveGroupConnection(
        scenario("claude"),
        withConnections,
        "https://hk.vvcode.top",
      ).baseUrl,
    ).toBe("https://hk.vvcode.top/api/anthropic");
  });

  it("preserves a route prefix without duplicating /v1", () => {
    expect(
      resolveScenarioBaseUrl(
        "https://vvcode.top/v1",
        "https://gateway.example/api",
        "openai_responses",
      ),
    ).toBe("https://gateway.example/api/v1");
    expect(
      resolveScenarioBaseUrl(
        "https://vvcode.top/v1",
        "https://gateway.example/v1",
        "openai_responses",
      ),
    ).toBe("https://gateway.example/v1");
  });

  it("uses explicit connection formats before scenario defaults", () => {
    const anthropicOpenCode: NewApiGroup = {
      ...group,
      connections: {
        opencode: {
          baseUrl: "https://vvcode.top",
          apiKey: "sk-anthropic",
          apiFormat: "anthropic",
        },
      },
    };

    const connection = resolveGroupConnection(
      scenario("opencode"),
      anthropicOpenCode,
      "https://cf.vvcode.top",
    );
    expect(connection.baseUrl).toBe("https://cf.vvcode.top");
    expect(connection.apiFormat).toBe("anthropic");
  });

  it("canonicalizes common API format aliases before resolving paths", () => {
    const chatCodex: NewApiGroup = {
      ...group,
      connections: {
        codex: {
          baseUrl: "https://vvcode.top",
          apiKey: "sk-chat",
          apiFormat: "chat-completions",
        },
      },
    };

    const connection = resolveGroupConnection(scenario("codex"), chatCodex);
    expect(connection.apiFormat).toBe("openai_chat");
    expect(connection.baseUrl).toBe("https://vvcode.top/v1");
  });
});
