import type { UIMessage } from "ai";
import type { NewApiBootstrap, NewApiGroup } from "../types";
import { BRAND_CONFIG } from "../brand";

const CHAT_STORAGE_PREFIX = `${BRAND_CONFIG.distribution.packageName}.chat.v1`;

export interface ChatThreadRecord {
  id: string;
  title: string;
  groupId: string;
  modelId: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export type ChatMessage = UIMessage<unknown, never, Record<never, never>>;

export interface ChatStore {
  version: 1;
  activeThreadId: string;
  threads: ChatThreadRecord[];
}

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function defaultChatGroup(
  bootstrap: NewApiBootstrap,
): NewApiGroup | null {
  return (
    bootstrap.groups.find((group) => group.isDefault) ??
    bootstrap.groups[0] ??
    null
  );
}

export function createChatThread(
  bootstrap: NewApiBootstrap,
  now: number = Date.now(),
): ChatThreadRecord {
  const group = defaultChatGroup(bootstrap);
  return {
    id: createId(),
    title: "新对话",
    groupId: group?.id ?? "",
    modelId: group?.defaultModelId ?? group?.models[0]?.id ?? "",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function isUIMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<UIMessage>;
  return (
    typeof message.id === "string" &&
    (message.role === "user" ||
      message.role === "assistant" ||
      message.role === "system") &&
    Array.isArray(message.parts)
  );
}

function isThread(value: unknown): value is ChatThreadRecord {
  if (!value || typeof value !== "object") return false;
  const thread = value as Partial<ChatThreadRecord>;
  return (
    typeof thread.id === "string" &&
    typeof thread.title === "string" &&
    typeof thread.groupId === "string" &&
    typeof thread.modelId === "string" &&
    typeof thread.createdAt === "number" &&
    typeof thread.updatedAt === "number" &&
    Array.isArray(thread.messages) &&
    thread.messages.every(isUIMessage)
  );
}

export function parseChatStore(
  raw: string | null,
  bootstrap: NewApiBootstrap,
): ChatStore {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ChatStore>;
      const threads = Array.isArray(parsed.threads)
        ? parsed.threads.filter(isThread)
        : [];
      if (parsed.version === 1 && threads.length > 0) {
        const activeThreadId = threads.some(
          (thread) => thread.id === parsed.activeThreadId,
        )
          ? (parsed.activeThreadId as string)
          : threads[0].id;
        return {
          version: 1,
          activeThreadId,
          threads: threads.sort((a, b) => b.updatedAt - a.updatedAt),
        };
      }
    } catch {
      // Corrupted local chat history falls back to a fresh thread.
    }
  }

  const thread = createChatThread(bootstrap);
  return { version: 1, activeThreadId: thread.id, threads: [thread] };
}

export function chatStorageKey(userId: number): string {
  return `${CHAT_STORAGE_PREFIX}.${userId}`;
}

export function loadChatStore(
  userId: number,
  bootstrap: NewApiBootstrap,
): ChatStore {
  if (typeof window === "undefined") return parseChatStore(null, bootstrap);
  return parseChatStore(
    window.localStorage.getItem(chatStorageKey(userId)),
    bootstrap,
  );
}

export function saveChatStore(userId: number, store: ChatStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(chatStorageKey(userId), JSON.stringify(store));
  } catch (error) {
    console.warn(
      `[${BRAND_CONFIG.brand.name}] Failed to persist chat history:`,
      error,
    );
  }
}

export function messageTitle(messages: readonly ChatMessage[]): string | null {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) return null;

  const text = firstUserMessage.parts
    .filter(
      (
        part,
      ): part is Extract<
        (typeof firstUserMessage.parts)[number],
        { type: "text" }
      > => part.type === "text",
    )
    .map((part) => part.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return null;
  return text.length > 32 ? `${text.slice(0, 32)}…` : text;
}
