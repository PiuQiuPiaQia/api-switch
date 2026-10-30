import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types";
import { PRODUCT } from "../config";
import { buildManagedProvider } from "../configuration";
import type { NewApiGroup } from "../types";
import { ManagedProviderCoreForm } from "./ManagedProviderCoreForm";

const modelFetchMock = vi.hoisted(() => ({
  fetchModelsForConfig: vi.fn(),
  showFetchModelsError: vi.fn(),
}));

vi.mock("@/lib/api/model-fetch", () => modelFetchMock);

const group: NewApiGroup = {
  id: "daily",
  name: "日常组",
  description: "",
  ratio: "1",
  baseUrl: "https://api.example.com",
  apiKey: "sk-test",
  defaultModelId: "",
  apiProvider: "anthropic",
  ccProvider: "anthropic",
  isDefault: true,
  models: [],
};

function scenario(id: "claude" | "codex" | "openclaw" | "hermes" | "dsh") {
  return PRODUCT.scenarios.find((item) => item.id === id)!;
}

describe("ManagedProviderCoreForm", () => {
  beforeEach(() => {
    modelFetchMock.fetchModelsForConfig.mockReset();
    modelFetchMock.showFetchModelsError.mockReset();
  });

  it("keeps Claude routes empty by default and only writes explicit values", async () => {
    const claudeScenario = scenario("claude");
    const provider = buildManagedProvider(claudeScenario, group) as Provider;
    const onSubmit = vi.fn();

    render(
      <>
        <ManagedProviderCoreForm
          formId="managed-test"
          scenario={claudeScenario}
          group={group}
          provider={provider}
          hasApiKey={false}
          onSubmit={onSubmit}
        />
        <button type="submit" form="managed-test">
          应用
        </button>
      </>,
    );

    expect(screen.queryByText("Anthropic Messages")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "获取模型" })).toBeDisabled();
    const inputs = screen.getAllByPlaceholderText("留空则不覆盖");
    expect(inputs).toHaveLength(3);
    for (const input of inputs) expect(input).toHaveValue("");
    expect(screen.queryByText("认证字段")).not.toBeInTheDocument();
    expect(screen.queryByText("配置 JSON")).not.toBeInTheDocument();
    expect(screen.queryByText("API Key")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/客户端密钥正在自动准备/),
    ).not.toBeInTheDocument();

    fireEvent.change(inputs[0], { target: { value: "model-sonnet" } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const submitted = onSubmit.mock.calls[0][0] as Provider;
    expect(submitted.settingsConfig.env).toMatchObject({
      ANTHROPIC_DEFAULT_SONNET_MODEL: "model-sonnet",
    });
    expect(submitted.settingsConfig.env).not.toHaveProperty(
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
    );
    expect(submitted.settingsConfig.env).not.toHaveProperty(
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    );
  });

  it("fetches model suggestions only after clicking the fetch button", async () => {
    modelFetchMock.fetchModelsForConfig.mockResolvedValue([
      { id: "model-one", ownedBy: "Vendor" },
      { id: "model-two", ownedBy: null },
    ]);
    const claudeScenario = scenario("claude");

    render(
      <ManagedProviderCoreForm
        formId="managed-fetch"
        scenario={claudeScenario}
        group={group}
        provider={buildManagedProvider(claudeScenario, group)}
        hasApiKey
        onSubmit={() => undefined}
      />,
    );

    expect(modelFetchMock.fetchModelsForConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));

    await waitFor(() =>
      expect(modelFetchMock.fetchModelsForConfig).toHaveBeenCalledWith(
        group.baseUrl,
        group.apiKey,
      ),
    );
    // 上游把模型下拉重构为可搜索 Popover（aria-label「Select model」，
    // 测试环境 i18n 资源为空，取 defaultValue），Claude 场景下三个角色输入各对应一个。
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Select model" }),
      ).toHaveLength(3),
    );
  });

  it("keeps the Codex default model empty unless the user changes it", async () => {
    const codexScenario = scenario("codex");
    const onSubmit = vi.fn();

    render(
      <>
        <ManagedProviderCoreForm
          formId="managed-codex"
          scenario={codexScenario}
          group={group}
          provider={buildManagedProvider(codexScenario, group)}
          hasApiKey
          onSubmit={onSubmit}
        />
        <button type="submit" form="managed-codex">
          应用 Codex
        </button>
      </>,
    );

    expect(screen.queryByText("OpenAI Responses")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("留空则不覆盖")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "应用 Codex" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const submitted = onSubmit.mock.calls[0][0] as Provider;
    expect(submitted.settingsConfig.config).not.toContain("model =");
  });

  it.each(["openclaw", "hermes"] as const)(
    "uses the first model as the default model for %s",
    async (scenarioId) => {
      const agentScenario = scenario(scenarioId);
      const onSubmit = vi.fn();
      const provider = buildManagedProvider(agentScenario, group);
      provider.settingsConfig.models = [
        { id: "model-primary", name: "Primary" },
        { id: "model-secondary", name: "Secondary" },
      ];

      render(
        <>
          <ManagedProviderCoreForm
            formId={`managed-${scenarioId}`}
            scenario={agentScenario}
            group={group}
            provider={provider}
            hasApiKey
            onSubmit={onSubmit}
          />
          <button type="submit" form={`managed-${scenarioId}`}>
            应用
          </button>
        </>,
      );

      expect(screen.getByText("默认模型")).toBeInTheDocument();
      expect(
        screen.getByText(scenarioId === "openclaw" ? "回退模型" : "备选模型"),
      ).toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "默认模型" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "应用" }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
      const submitted = onSubmit.mock.calls[0][0] as Provider;
      expect(submitted.settingsConfig.models).toEqual([
        { id: "model-primary", name: "Primary" },
        { id: "model-secondary", name: "Secondary" },
      ]);
    },
  );
});

describe("ManagedProviderCoreForm · Dsh", () => {
  beforeEach(() => {
    modelFetchMock.fetchModelsForConfig.mockReset();
    modelFetchMock.showFetchModelsError.mockReset();
  });

  it("requires an explicit protocol before applying the Dsh configuration", async () => {
    const dshScenario = scenario("dsh");
    const onSubmit = vi.fn();

    render(
      <>
        <ManagedProviderCoreForm
          formId="managed-dsh"
          scenario={dshScenario}
          group={group}
          provider={buildManagedProvider(dshScenario, group)}
          hasApiKey
          onSubmit={onSubmit}
        />
        <button type="submit" form="managed-dsh">
          应用 Dsh
        </button>
      </>,
    );

    const protocolSelect = screen.getByLabelText(
      "Dsh 模型协议",
    ) as HTMLSelectElement;
    expect(protocolSelect).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "应用 Dsh" }));

    // The form refuses to submit a protocol-less Dsh provider.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(protocolSelect).toHaveValue("");
  });

  it("restores the saved protocol and models, then submits protected limits and the default model", async () => {
    const dshScenario = scenario("dsh");
    const onSubmit = vi.fn();
    const provider = buildManagedProvider(dshScenario, group);
    provider.settingsConfig.api = "anthropic-messages";
    provider.settingsConfig.models = {
      "claude-sonnet": {
        name: "Sonnet",
        limit: { context: 200_000, output: 64_000 },
      },
    };
    provider.settingsConfig.defaultModel = "claude-sonnet";

    render(
      <>
        <ManagedProviderCoreForm
          formId="managed-dsh-2"
          scenario={dshScenario}
          group={group}
          provider={provider}
          hasApiKey
          onSubmit={onSubmit}
        />
        <button type="submit" form="managed-dsh-2">
          应用 Dsh
        </button>
      </>,
    );

    // The saved choice initializes the selector instead of a guessed default.
    expect(screen.getByLabelText("Dsh 模型协议")).toHaveValue(
      "anthropic-messages",
    );
    // The model id input and the default model input both carry the value.
    expect(
      screen.getAllByDisplayValue("claude-sonnet").length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByDisplayValue("Sonnet")).toBeInTheDocument();
    expect(screen.getByDisplayValue("200000")).toBeInTheDocument();
    expect(screen.getByDisplayValue("64000")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("留空则不设置")).toHaveValue(
      "claude-sonnet",
    );

    // Switch to OpenAI Responses and add a second model with a
    // window-eating output limit.
    fireEvent.change(screen.getByLabelText("Dsh 模型协议"), {
      target: { value: "openai-responses" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    const idInputs = screen
      .getAllByPlaceholderText("模型 ID")
      .filter((input) => (input as HTMLInputElement).value === "");
    fireEvent.change(idInputs[0], { target: { value: "gpt-5.4" } });
    fireEvent.change(idInputs[0].parentElement!.nextElementSibling!, {
      target: { value: "GPT" },
    });
    const contextInputs = screen.getAllByPlaceholderText("如 128000");
    fireEvent.change(contextInputs[contextInputs.length - 1], {
      target: { value: "131072" },
    });
    const outputInputs = screen.getAllByPlaceholderText("如 8192");
    fireEvent.change(outputInputs[outputInputs.length - 1], {
      target: { value: "65536" },
    });

    fireEvent.click(screen.getByRole("button", { name: "应用 Dsh" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const submitted = onSubmit.mock.calls[0][0] as Provider;
    expect(submitted.settingsConfig.api).toBe("openai-responses");
    // The output limit is protected to max(131072/4, 131072/2 - 65536)=32768.
    expect(submitted.settingsConfig.models).toEqual({
      "claude-sonnet": {
        name: "Sonnet",
        limit: { context: 200_000, output: 50_000 },
      },
      "gpt-5.4": { name: "GPT", limit: { context: 131072, output: 32768 } },
    });
    expect(submitted.settingsConfig.defaultModel).toBe("claude-sonnet");
    expect(submitted.meta?.apiFormat).toBe("openai_responses");
  });

  it("fetches models for the resolved Dsh connection when a protocol is chosen", async () => {
    const dshScenario = scenario("dsh");
    modelFetchMock.fetchModelsForConfig.mockResolvedValue([
      { id: "deepseek-v4" },
    ]);

    render(
      <ManagedProviderCoreForm
        formId="managed-dsh-3"
        scenario={dshScenario}
        group={group}
        provider={buildManagedProvider(dshScenario, group)}
        hasApiKey
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    await waitFor(() =>
      expect(modelFetchMock.fetchModelsForConfig).toHaveBeenCalledOnce(),
    );
  });
});
