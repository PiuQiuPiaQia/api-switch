import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { NewApiBootstrap } from "../types";
import { ChatRuntime } from "./ChatRuntime";
import {
  createChatThread,
  defaultChatGroup,
  loadChatStore,
  messageTitle,
  saveChatStore,
  type ChatMessage,
  type ChatStore,
  type ChatThreadRecord,
} from "./storage";

interface ChatPageProps {
  bootstrap: NewApiBootstrap;
  preview: boolean;
  onEnsureTokens: (groupId: string) => Promise<NewApiBootstrap>;
}

function formatThreadTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(date);
}

function reconcileThread(
  thread: ChatThreadRecord,
  bootstrap: NewApiBootstrap,
): ChatThreadRecord {
  const fallbackGroup = defaultChatGroup(bootstrap);
  const group =
    bootstrap.groups.find((item) => item.id === thread.groupId) ??
    fallbackGroup;
  const model =
    group?.models.find((item) => item.id === thread.modelId) ??
    group?.models.find((item) => item.id === group.defaultModelId) ??
    group?.models[0];
  return {
    ...thread,
    groupId: group?.id ?? "",
    modelId: model?.id ?? "",
  };
}

export function ChatPage({
  bootstrap,
  preview,
  onEnsureTokens,
}: ChatPageProps) {
  const [store, setStore] = useState<ChatStore>(() =>
    loadChatStore(bootstrap.user.id, bootstrap),
  );
  const [query, setQuery] = useState("");
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [tokenState, setTokenState] = useState<{
    groupId: string;
    status: "idle" | "loading" | "error";
    error?: string;
  }>({ groupId: "", status: "idle" });

  useEffect(() => {
    saveChatStore(bootstrap.user.id, store);
  }, [bootstrap.user.id, store]);

  useEffect(() => {
    setStore((current) => {
      const nextThreads = current.threads.map((thread) =>
        reconcileThread(thread, bootstrap),
      );
      const changed = nextThreads.some(
        (thread, index) =>
          thread.groupId !== current.threads[index].groupId ||
          thread.modelId !== current.threads[index].modelId,
      );
      return changed ? { ...current, threads: nextThreads } : current;
    });
  }, [bootstrap]);

  const activeThread = useMemo(
    () =>
      store.threads.find((thread) => thread.id === store.activeThreadId) ??
      store.threads[0] ??
      null,
    [store.activeThreadId, store.threads],
  );

  const selectedGroup = useMemo(
    () =>
      bootstrap.groups.find((group) => group.id === activeThread?.groupId) ??
      defaultChatGroup(bootstrap),
    [activeThread?.groupId, bootstrap],
  );

  const selectedModel = useMemo(
    () =>
      selectedGroup?.models.find(
        (model) => model.id === activeThread?.modelId,
      ) ??
      selectedGroup?.models.find(
        (model) => model.id === selectedGroup.defaultModelId,
      ) ??
      selectedGroup?.models[0] ??
      null,
    [activeThread?.modelId, selectedGroup],
  );

  useEffect(() => {
    if (preview || !selectedGroup || selectedGroup.apiKey) {
      setTokenState({
        groupId: selectedGroup?.id ?? "",
        status: "idle",
      });
      return;
    }

    let cancelled = false;
    setTokenState({ groupId: selectedGroup.id, status: "loading" });
    void onEnsureTokens(selectedGroup.id)
      .then(() => {
        if (!cancelled) {
          setTokenState({ groupId: selectedGroup.id, status: "idle" });
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setTokenState({
          groupId: selectedGroup.id,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [onEnsureTokens, preview, selectedGroup]);

  const filteredThreads = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return [...store.threads]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter(
        (thread) =>
          !normalizedQuery ||
          thread.title.toLocaleLowerCase().includes(normalizedQuery),
      );
  }, [query, store.threads]);

  const updateThread = useCallback(
    (
      threadId: string,
      update: (thread: ChatThreadRecord) => ChatThreadRecord,
    ) => {
      setStore((current) => ({
        ...current,
        threads: current.threads.map((thread) =>
          thread.id === threadId ? update(thread) : thread,
        ),
      }));
    },
    [],
  );

  const createThread = useCallback(() => {
    const thread = createChatThread(bootstrap);
    setStore((current) => ({
      ...current,
      activeThreadId: thread.id,
      threads: [thread, ...current.threads],
    }));
    setQuery("");
  }, [bootstrap]);

  const deleteThread = useCallback(
    (threadId: string) => {
      if (!window.confirm("确定删除这条对话吗？此操作无法撤销。")) return;
      setStore((current) => {
        const remaining = current.threads.filter(
          (thread) => thread.id !== threadId,
        );
        if (remaining.length > 0) {
          return {
            ...current,
            activeThreadId:
              current.activeThreadId === threadId
                ? remaining[0].id
                : current.activeThreadId,
            threads: remaining,
          };
        }
        const replacement = createChatThread(bootstrap);
        return {
          version: 1,
          activeThreadId: replacement.id,
          threads: [replacement],
        };
      });
    },
    [bootstrap],
  );

  const beginRename = (thread: ChatThreadRecord) => {
    setEditingThreadId(thread.id);
    setEditingTitle(thread.title);
  };

  const commitRename = () => {
    if (!editingThreadId) return;
    const title = editingTitle.trim();
    if (title) {
      updateThread(editingThreadId, (thread) => ({
        ...thread,
        title,
        updatedAt: Date.now(),
      }));
    }
    setEditingThreadId(null);
  };

  const handleMessagesChange = useCallback(
    (threadId: string, messages: ChatMessage[]) => {
      updateThread(threadId, (thread) => {
        if (thread.messages === messages) return thread;
        const generatedTitle =
          thread.title === "新对话" ? messageTitle(messages) : null;
        return {
          ...thread,
          title: generatedTitle ?? thread.title,
          messages,
          updatedAt: Date.now(),
        };
      });
    },
    [updateThread],
  );

  const handleActiveMessagesChange = useCallback(
    (messages: ChatMessage[]) => {
      if (activeThread) handleMessagesChange(activeThread.id, messages);
    },
    [activeThread?.id, handleMessagesChange],
  );

  const tokenIsLoading =
    tokenState.groupId === selectedGroup?.id && tokenState.status === "loading";
  const tokenError =
    tokenState.groupId === selectedGroup?.id && tokenState.status === "error"
      ? tokenState.error
      : null;
  const canRun = Boolean(
    activeThread &&
      selectedGroup &&
      selectedModel &&
      selectedGroup.baseUrl &&
      selectedGroup.apiKey,
  );

  return (
    <section className="vv-chat-page">
      <aside className="vv-chat-history" aria-label="历史对话">
        <div className="vv-chat-history__header">
          <div>
            <span>对话</span>
            <small>{store.threads.length} 条历史记录</small>
          </div>
          <button type="button" onClick={createThread} title="新建对话">
            <Plus size={16} />
          </button>
        </div>

        <label className="vv-chat-history__search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索历史对话"
          />
        </label>

        <div className="vv-chat-history__list">
          {filteredThreads.length === 0 ? (
            <div className="vv-chat-history__empty">
              <MessageSquareText size={22} />
              <span>没有匹配的对话</span>
            </div>
          ) : (
            filteredThreads.map((thread) => (
              <div
                key={thread.id}
                className={`vv-chat-history__item ${
                  thread.id === activeThread?.id ? "is-active" : ""
                }`}
              >
                {editingThreadId === thread.id ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      commitRename();
                    }}
                  >
                    <input
                      autoFocus
                      value={editingTitle}
                      onChange={(event) => setEditingTitle(event.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setEditingThreadId(null);
                      }}
                    />
                    <button type="submit" aria-label="保存名称">
                      <Check size={13} />
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className="vv-chat-history__trigger"
                      onClick={() =>
                        setStore((current) => ({
                          ...current,
                          activeThreadId: thread.id,
                        }))
                      }
                    >
                      <MessageSquareText size={14} />
                      <span>
                        <strong>{thread.title}</strong>
                        <small>{formatThreadTime(thread.updatedAt)}</small>
                      </span>
                    </button>
                    <div className="vv-chat-history__actions">
                      <button
                        type="button"
                        title="重命名"
                        aria-label="重命名对话"
                        onClick={() => beginRename(thread)}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        title="删除"
                        aria-label="删除对话"
                        onClick={() => deleteThread(thread.id)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>

        <div className="vv-chat-history__footer">
          <MoreHorizontal size={15} />
          历史记录仅保存在当前设备
        </div>
      </aside>

      <div className="vv-chat-panel">
        <header className="vv-chat-panel__header">
          <div>
            <strong>{activeThread?.title ?? "新对话"}</strong>
            <small>使用中转站标准 OpenAI-compatible 接口</small>
          </div>
          <div className="vv-chat-panel__selectors">
            <label>
              <span>分组</span>
              <select
                value={selectedGroup?.id ?? ""}
                disabled={!activeThread || bootstrap.groups.length === 0}
                onChange={(event) => {
                  const group = bootstrap.groups.find(
                    (item) => item.id === event.target.value,
                  );
                  if (!group || !activeThread) return;
                  updateThread(activeThread.id, (thread) => ({
                    ...thread,
                    groupId: group.id,
                    modelId: group.defaultModelId ?? group.models[0]?.id ?? "",
                    updatedAt: Date.now(),
                  }));
                }}
              >
                {bootstrap.groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>模型</span>
              <select
                value={selectedModel?.id ?? ""}
                disabled={!activeThread || !selectedGroup?.models.length}
                onChange={(event) => {
                  if (!activeThread) return;
                  updateThread(activeThread.id, (thread) => ({
                    ...thread,
                    modelId: event.target.value,
                    updatedAt: Date.now(),
                  }));
                }}
              >
                {selectedGroup?.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name || model.id}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </header>

        <div className="vv-chat-panel__body">
          {tokenIsLoading ? (
            <div className="vv-chat-unavailable">
              <span className="vv-spin" />
              <strong>正在准备分组密钥</strong>
              <p>完成后即可开始对话。</p>
            </div>
          ) : tokenError ? (
            <div className="vv-chat-unavailable is-error">
              <strong>暂时无法准备分组密钥</strong>
              <p>{tokenError}</p>
            </div>
          ) : !canRun || !activeThread || !selectedGroup || !selectedModel ? (
            <div className="vv-chat-unavailable">
              <MessageSquareText size={28} />
              <strong>当前没有可用的对话模型</strong>
              <p>请先同步分组配置，或确认当前分组已配置模型和密钥。</p>
            </div>
          ) : (
            <ChatRuntime
              key={`${activeThread.id}:${selectedGroup.id}:${selectedModel.id}`}
              thread={activeThread}
              group={selectedGroup}
              model={selectedModel}
              onMessagesChange={handleActiveMessagesChange}
              onError={(message) =>
                toast.error("消息发送失败", { description: message })
              }
            />
          )}
        </div>
      </div>
    </section>
  );
}
