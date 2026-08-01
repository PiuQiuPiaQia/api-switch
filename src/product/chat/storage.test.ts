import { describe, expect, it, vi } from "vitest";
import type { NewApiBootstrap } from "../types";
import {
  chatStorageKey,
  createChatThread,
  messageTitle,
  parseChatStore,
  type ChatMessage,
} from "./storage";

const bootstrap: NewApiBootstrap = {
  user: {
    id: 7,
    username: "tester",
    displayName: "Tester",
    email: "tester@example.com",
    role: 1,
    status: 1,
    group: "default",
    quota: 100,
    usedQuota: 0,
    requestCount: 0,
  },
  source: "preview",
  groups: [
    {
      id: "performance",
      name: "性能",
      description: "",
      ratio: "1",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-test",
      defaultModelId: "model-b",
      apiProvider: "newapi",
      ccProvider: "newapi",
      isDefault: true,
      models: [
        {
          id: "model-b",
          name: "Model B",
          description: "",
          vendor: "test",
          quotaType: 0,
          modelRatio: 1,
          modelPrice: 0,
          completionRatio: 1,
        },
      ],
    },
  ],
};

describe("chat storage", () => {
  it("creates a thread from the default group", () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    const thread = createChatThread(bootstrap, 100);
    expect(thread).toMatchObject({
      id: "00000000-0000-4000-8000-000000000001",
      groupId: "performance",
      modelId: "model-b",
      createdAt: 100,
      updatedAt: 100,
      title: "新对话",
    });
  });

  it("falls back to a fresh thread for corrupted data", () => {
    const parsed = parseChatStore("{not-json", bootstrap);
    expect(parsed.version).toBe(1);
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.activeThreadId).toBe(parsed.threads[0].id);
  });

  it("uses the first user text as a compact title", () => {
    const messages: ChatMessage[] = [
      {
        id: "message-1",
        role: "user",
        parts: [{ type: "text", text: "  帮我写一个  TypeScript  示例  " }],
      },
    ];
    expect(messageTitle(messages)).toBe("帮我写一个 TypeScript 示例");
  });

  it("isolates history by user", () => {
    expect(chatStorageKey(7)).toBe("vv-code.chat.v1.7");
    expect(chatStorageKey(8)).not.toBe(chatStorageKey(7));
  });
});
