import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Loader2,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { newApiApi } from "../api";
import type { NewApiBootstrap, NewApiGroup } from "../types";
import { ChatRuntime, type ChatRuntimeModel } from "./ChatRuntime";
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

interface GroupModelState {
  connectionKey: string;
  requestKey: string;
  status: "loading" | "ready" | "error";
  models: ChatRuntimeModel[];
  error?: string;
}

function groupConnectionKey(group: NewApiGroup): string {
  return group.id;
}

function bootstrapModels(group: NewApiGroup): ChatRuntimeModel[] {
  return group.models.map((model) => ({ id: model.id, name: model.name }));
}

function normalizeFetchedModels(
  group: NewApiGroup,
  models: string[],
): ChatRuntimeModel[] {
  const cachedNames = new Map(
    group.models.map((model) => [model.id, model.name] as const),
  );
  const seen = new Set<string>();
  const normalized: ChatRuntimeModel[] = [];
  for (const model of models) {
    const id = model.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push({ id, name: cachedNames.get(id) || id });
  }
  return normalized;
}

export function resolveChatModelId(
  currentModelId: string,
  defaultModelId: string,
  models: ChatRuntimeModel[],
): string {
  if (models.some((model) => model.id === currentModelId)) {
    return currentModelId;
  }
  if (models.some((model) => model.id === defaultModelId)) {
    return defaultModelId;
  }
  return models[0]?.id ?? "";
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
  const existingGroup = bootstrap.groups.find(
    (item) => item.id === thread.groupId,
  );
  if (existingGroup) return thread;

  const model =
    fallbackGroup?.models.find(
      (item) => item.id === fallbackGroup.defaultModelId,
    ) ?? fallbackGroup?.models[0];
  return {
    ...thread,
    groupId: fallbackGroup?.id ?? "",
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
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [tokenState, setTokenState] = useState<{
    groupId: string;
    status: "idle" | "loading" | "error";
    error?: string;
  }>({ groupId: "", status: "idle" });
  const [modelStates, setModelStates] = useState<
    Record<string, GroupModelState>
  >({});
  const [modelRefreshVersion, setModelRefreshVersion] = useState(0);
  const inFlightModelRequests = useRef(new Map<string, Promise<string[]>>());

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

  const selectedModelState = selectedGroup
    ? modelStates[selectedGroup.id]
    : undefined;
  const selectedConnectionKey = selectedGroup
    ? groupConnectionKey(selectedGroup)
    : "";
  const currentModelState =
    selectedModelState?.connectionKey === selectedConnectionKey
      ? selectedModelState
      : undefined;
  const availableModels = useMemo(() => {
    if (!selectedGroup) return [];
    if (preview || currentModelState?.status !== "ready") {
      return bootstrapModels(selectedGroup);
    }
    return currentModelState.models;
  }, [currentModelState, preview, selectedGroup]);

  const selectedModel = useMemo(() => {
    if (!selectedGroup) return null;
    return (
      availableModels.find((model) => model.id === activeThread?.modelId) ??
      availableModels.find(
        (model) => model.id === selectedGroup.defaultModelId,
      ) ??
      availableModels[0] ??
      null
    );
  }, [activeThread?.modelId, availableModels, selectedGroup]);

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

  useEffect(() => {
    if (preview || !selectedGroup?.id) return;

    const group = selectedGroup;
    const connectionKey = groupConnectionKey(group);
    const requestKey = `${connectionKey}\u0000${modelRefreshVersion}`;
    setModelStates((current) => ({
      ...current,
      [group.id]: {
        connectionKey,
        requestKey,
        status: "loading",
        models: [],
      },
    }));

    let request = inFlightModelRequests.current.get(requestKey);
    if (!request) {
      request = newApiApi.getGroupModels(group.id);
      inFlightModelRequests.current.set(requestKey, request);
      void request.then(
        () => inFlightModelRequests.current.delete(requestKey),
        () => inFlightModelRequests.current.delete(requestKey),
      );
    }

    let cancelled = false;
    void request
      .then((models) => {
        if (cancelled) return;
        const normalized = normalizeFetchedModels(group, models);
        setModelStates((current) => {
          if (current[group.id]?.requestKey !== requestKey) return current;
          return {
            ...current,
            [group.id]: {
              connectionKey,
              requestKey,
              status: "ready",
              models: normalized,
            },
          };
        });
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn("[VV Code] Failed to fetch chat models:", error);
        setModelStates((current) => {
          if (current[group.id]?.requestKey !== requestKey) return current;
          return {
            ...current,
            [group.id]: {
              connectionKey,
              requestKey,
              status: "error",
              models: [],
              error: error instanceof Error ? error.message : String(error),
            },
          };
        });
      });

    return () => {
      cancelled = true;
    };
  }, [modelRefreshVersion, preview, selectedGroup?.id]);

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

  useEffect(() => {
    if (!activeThread || !selectedGroup || availableModels.length === 0) return;
    const modelId = resolveChatModelId(
      activeThread.modelId,
      selectedGroup.defaultModelId,
      availableModels,
    );
    if (modelId === activeThread.modelId) return;
    updateThread(activeThread.id, (thread) => ({
      ...thread,
      modelId,
      updatedAt: Date.now(),
    }));
  }, [activeThread, availableModels, selectedGroup, updateThread]);

  const createThread = useCallback(() => {
    const thread = createChatThread(bootstrap);
    setStore((current) => ({
      ...current,
      activeThreadId: thread.id,
      threads: [thread, ...current.threads],
    }));
    setQuery("");
  }, [bootstrap]);

  const confirmDeleteThread = useCallback(() => {
    if (!pendingDelete) return;
    const threadId = pendingDelete.id;
    setPendingDelete(null);
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
  }, [bootstrap, pendingDelete]);

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
  const modelsAreLoading = currentModelState?.status === "loading";
  const modelError =
    currentModelState?.status === "error" ? currentModelState.error : null;
  const modelsLoadedEmpty =
    currentModelState?.status === "ready" && availableModels.length === 0;
  const refreshModels = useCallback(() => {
    setModelRefreshVersion((current) => current + 1);
  }, []);
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
                        onClick={() =>
                          setPendingDelete({
                            id: thread.id,
                            title: thread.title,
                          })
                        }
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
                disabled={!activeThread || availableModels.length === 0}
                onChange={(event) => {
                  if (!activeThread) return;
                  updateThread(activeThread.id, (thread) => ({
                    ...thread,
                    modelId: event.target.value,
                    updatedAt: Date.now(),
                  }));
                }}
              >
                {modelsAreLoading && availableModels.length === 0 && (
                  <option value="">正在拉取模型…</option>
                )}
                {modelError && availableModels.length === 0 && (
                  <option value="">模型加载失败</option>
                )}
                {modelsLoadedEmpty && <option value="">暂无模型</option>}
                {availableModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name || model.id}
                  </option>
                ))}
              </select>
            </label>
            {!preview && (
              <button
                type="button"
                className="vv-chat-model-refresh"
                onClick={refreshModels}
                disabled={modelsAreLoading || !selectedGroup?.id}
                title="重新拉取模型"
                aria-label="重新拉取模型"
              >
                {modelsAreLoading ? (
                  <Loader2 className="vv-spin" size={13} />
                ) : (
                  <RefreshCw size={13} />
                )}
              </button>
            )}
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
          ) : modelsAreLoading && availableModels.length === 0 ? (
            <div className="vv-chat-unavailable">
              <span className="vv-spin" />
              <strong>正在拉取模型列表</strong>
              <p>正在读取网站为当前分组启用的可用模型。</p>
            </div>
          ) : modelError && availableModels.length === 0 ? (
            <div className="vv-chat-unavailable is-error">
              <strong>模型列表加载失败</strong>
              <p>{modelError}</p>
              <button type="button" onClick={refreshModels}>
                <RefreshCw size={13} /> 重新拉取
              </button>
            </div>
          ) : modelsLoadedEmpty ? (
            <div className="vv-chat-unavailable">
              <MessageSquareText size={28} />
              <strong>当前分组没有返回可用模型</strong>
              <p>请确认网站已为该分组启用模型，或重新拉取模型列表。</p>
              <button type="button" onClick={refreshModels}>
                <RefreshCw size={13} /> 重新拉取
              </button>
            </div>
          ) : !canRun || !activeThread || !selectedGroup || !selectedModel ? (
            <div className="vv-chat-unavailable">
              <MessageSquareText size={28} />
              <strong>当前没有可用的对话模型</strong>
              <p>请先同步分组配置，或确认当前分组已配置密钥。</p>
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
      <ConfirmDialog
        isOpen={pendingDelete !== null}
        title="删除对话"
        message={`确定删除“${pendingDelete?.title ?? "这条对话"}”吗？此操作无法撤销。`}
        confirmText="确认删除"
        cancelText="取消"
        onConfirm={confirmDeleteThread}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
