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

function scenario(id: "claude" | "codex") {
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

    expect(screen.getByText("Anthropic Messages")).toBeInTheDocument();
    expect(screen.getByText("默认")).toBeInTheDocument();
    const inputs = screen.getAllByPlaceholderText("留空则不覆盖");
    expect(inputs).toHaveLength(3);
    for (const input of inputs) expect(input).toHaveValue("");
    expect(screen.queryByText("认证字段")).not.toBeInTheDocument();
    expect(screen.queryByText("配置 JSON")).not.toBeInTheDocument();
    expect(screen.queryByText("API Key")).not.toBeInTheDocument();
    expect(screen.getByText(/客户端密钥正在自动准备/)).toBeInTheDocument();

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
    const modelMenus = screen
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-haspopup") === "menu");
    expect(modelMenus).toHaveLength(3);
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

    expect(screen.getByText("OpenAI Responses")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("留空则不覆盖")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "应用 Codex" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const submitted = onSubmit.mock.calls[0][0] as Provider;
    expect(submitted.settingsConfig.config).not.toContain("model =");
  });
});
