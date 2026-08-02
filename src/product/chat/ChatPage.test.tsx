import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NewApiBootstrap, NewApiGroup } from "../types";
import { ChatPage } from "./ChatPage";
import { saveChatStore } from "./storage";

const newApiMock = vi.hoisted(() => ({
  getGroupModels: vi.fn(),
}));

vi.mock("../api", () => ({ newApiApi: newApiMock }));

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
    newApiMock.getGroupModels.mockReset();
  });

  it("automatically loads website models for each selected group", async () => {
    const daily = group("daily", { isDefault: true });
    const coding = group("coding");
    newApiMock.getGroupModels.mockImplementation(async (groupId: string) => [
      groupId === "daily" ? "daily-model" : "coding-model",
    ]);

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
    expect(newApiMock.getGroupModels).toHaveBeenCalledWith(daily.id);

    fireEvent.change(screen.getByRole("combobox", { name: "分组" }), {
      target: { value: coding.id },
    });

    await waitFor(() =>
      expect(screen.getByTestId("chat-runtime")).toHaveTextContent(
        "coding:coding-model",
      ),
    );
    expect(newApiMock.getGroupModels).toHaveBeenCalledWith(coding.id);
  });

  it("loads the model list without waiting for the group chat key", async () => {
    const daily = group("daily", { apiKey: "", isDefault: true });
    const data = bootstrap([daily]);
    const ensureTokens = vi.fn(() => new Promise<NewApiBootstrap>(() => {}));
    newApiMock.getGroupModels.mockResolvedValue(["prepared-model"]);

    render(
      <ChatPage
        bootstrap={data}
        preview={false}
        onEnsureTokens={ensureTokens}
      />,
    );

    await waitFor(() => expect(ensureTokens).toHaveBeenCalledWith("daily"));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "模型" })).toHaveValue(
        "prepared-model",
      ),
    );
    expect(screen.getByRole("combobox", { name: "模型" })).toBeEnabled();
    expect(newApiMock.getGroupModels).toHaveBeenCalledWith("daily");
    expect(screen.queryByTestId("chat-runtime")).not.toBeInTheDocument();
  });

  it("allows a failed website model request to be retried", async () => {
    const daily = group("daily", { isDefault: true });
    newApiMock.getGroupModels
      .mockRejectedValueOnce(new Error("HTTP 500"))
      .mockResolvedValueOnce(["retry-model"]);
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
    expect(newApiMock.getGroupModels).toHaveBeenCalledTimes(2);
  });

  it("keeps a conversation until the delete dialog is confirmed", async () => {
    const daily = group("daily", { isDefault: true });
    const data = bootstrap([daily]);
    saveChatStore(data.user.id, {
      version: 1,
      activeThreadId: "thread-one",
      threads: [
        {
          id: "thread-one",
          title: "第一条对话",
          groupId: daily.id,
          modelId: "",
          messages: [],
          createdAt: 1,
          updatedAt: 2,
        },
        {
          id: "thread-two",
          title: "第二条对话",
          groupId: daily.id,
          modelId: "",
          messages: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    render(<ChatPage bootstrap={data} preview onEnsureTokens={vi.fn()} />);

    const history = screen.getByRole("complementary", { name: "历史对话" });
    const firstItem = within(history)
      .getByText("第一条对话")
      .closest(".vv-chat-history__item");
    expect(firstItem).not.toBeNull();
    fireEvent.click(
      within(firstItem as HTMLElement).getByRole("button", {
        name: "删除对话",
      }),
    );

    expect(within(history).getByText("第一条对话")).toBeInTheDocument();
    expect(screen.getByText(/确定删除“第一条对话”/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(within(history).getByText("第一条对话")).toBeInTheDocument();

    fireEvent.click(
      within(firstItem as HTMLElement).getByRole("button", {
        name: "删除对话",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() =>
      expect(within(history).queryByText("第一条对话")).not.toBeInTheDocument(),
    );
    expect(within(history).getByText("第二条对话")).toBeInTheDocument();
  });
});
