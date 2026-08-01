import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NewApiBootstrap, NewApiGroup } from "../types";
import { ChatPage } from "./ChatPage";

const modelFetchMock = vi.hoisted(() => ({
  fetchModelsForConfig: vi.fn(),
}));

vi.mock("@/lib/api/model-fetch", () => modelFetchMock);

vi.mock("./ChatRuntime", () => ({
  ChatRuntime: ({
    group,
    model,
  }: {
    group: NewApiGroup;
    model: { id: string };
  }) => <div data-testid="chat-runtime">{`${group.id}:${model.id}`}</div>,
}));

function group(
  id: string,
  options: { apiKey?: string; isDefault?: boolean } = {},
): NewApiGroup {
  return {
    id,
    name: `${id} 分组`,
    description: "",
    ratio: "1",
    baseUrl: `https://${id}.example.com/v1`,
    apiKey: options.apiKey ?? `sk-${id}`,
    defaultModelId: "",
    apiProvider: "newapi",
    ccProvider: "newapi",
    isDefault: options.isDefault ?? false,
    models: [],
  };
}

function bootstrap(groups: NewApiGroup[]): NewApiBootstrap {
  return {
    user: {
      id: 18,
      username: "chat-user",
      displayName: "Chat User",
      email: "chat@example.com",
      role: 1,
      status: 1,
      group: "default",
      quota: 100,
      usedQuota: 0,
      requestCount: 0,
    },
    groups,
    source: "desktop-v1",
  };
}

describe("ChatPage model loading", () => {
  beforeEach(() => {
    window.localStorage.clear();
    modelFetchMock.fetchModelsForConfig.mockReset();
  });

  it("automatically loads models for the initial and newly selected groups", async () => {
    const daily = group("daily", { isDefault: true });
    const coding = group("coding");
    modelFetchMock.fetchModelsForConfig.mockImplementation(
      async (baseUrl: string) => [
        {
          id: baseUrl.includes("daily") ? "daily-model" : "coding-model",
          ownedBy: null,
        },
      ],
    );

    render(
      <ChatPage
        bootstrap={bootstrap([daily, coding])}
        preview={false}
        onEnsureTokens={vi.fn()}
      />,
    );

    expect(await screen.findByTestId("chat-runtime")).toHaveTextContent(
      "daily:daily-model",
    );
    expect(modelFetchMock.fetchModelsForConfig).toHaveBeenCalledWith(
      daily.baseUrl,
      daily.apiKey,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "分组" }), {
      target: { value: coding.id },
    });

    await waitFor(() =>
      expect(screen.getByTestId("chat-runtime")).toHaveTextContent(
        "coding:coding-model",
      ),
    );
    expect(modelFetchMock.fetchModelsForConfig).toHaveBeenCalledWith(
      coding.baseUrl,
      coding.apiKey,
    );
  });

  it("waits for the group key before loading its models", async () => {
    const withoutKey = group("daily", { apiKey: "", isDefault: true });
    const withKey = { ...withoutKey, apiKey: "sk-prepared" };
    const initial = bootstrap([withoutKey]);
    const prepared = bootstrap([withKey]);
    const ensureTokens = vi.fn().mockResolvedValue(prepared);
    modelFetchMock.fetchModelsForConfig.mockResolvedValue([
      { id: "prepared-model", ownedBy: null },
    ]);

    function Harness() {
      const [data, setData] = useState(initial);
      return (
        <ChatPage
          bootstrap={data}
          preview={false}
          onEnsureTokens={async (groupId) => {
            const next = await ensureTokens(groupId);
            setData(next);
            return next;
          }}
        />
      );
    }

    render(<Harness />);

    await waitFor(() => expect(ensureTokens).toHaveBeenCalledWith("daily"));
    expect(await screen.findByTestId("chat-runtime")).toHaveTextContent(
      "daily:prepared-model",
    );
    expect(modelFetchMock.fetchModelsForConfig).toHaveBeenCalledOnce();
    expect(modelFetchMock.fetchModelsForConfig).toHaveBeenCalledWith(
      withKey.baseUrl,
      withKey.apiKey,
    );
  });

  it("allows a failed model request to be retried", async () => {
    const daily = group("daily", { isDefault: true });
    modelFetchMock.fetchModelsForConfig
      .mockRejectedValueOnce(new Error("HTTP 500"))
      .mockResolvedValueOnce([{ id: "retry-model", ownedBy: null }]);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    render(
      <ChatPage
        bootstrap={bootstrap([daily])}
        preview={false}
        onEnsureTokens={vi.fn()}
      />,
    );

    expect(await screen.findByText("模型列表加载失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新拉取" }));

    expect(await screen.findByTestId("chat-runtime")).toHaveTextContent(
      "daily:retry-model",
    );
    expect(modelFetchMock.fetchModelsForConfig).toHaveBeenCalledTimes(2);
  });
});
