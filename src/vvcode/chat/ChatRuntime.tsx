import { useEffect, useMemo } from "react";
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  ComposerPrimitive,
  CompositeAttachmentAdapter,
  ErrorPrimitive,
  MessagePrimitive,
  SimpleImageAttachmentAdapter,
  SimpleTextAttachmentAdapter,
  ThreadPrimitive,
  useAuiState,
  type AttachmentAdapter,
  type EmptyMessagePartProps,
  type FileMessagePartProps,
  type ImageMessagePartProps,
  type ReasoningMessagePartProps,
  type SourceMessagePartProps,
  type TextMessagePartProps,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { useChat } from "@ai-sdk/react";
import {
  ArrowDown,
  Bot,
  Brain,
  CircleAlert,
  Copy,
  ExternalLink,
  FileText,
  Loader2,
  Paperclip,
  RefreshCw,
  Send,
  Square,
  User,
  Wrench,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DirectChatTransport, ToolLoopAgent } from "ai";
import { BRAND_CONFIG } from "../brand";
import type { NewApiGroup } from "../types";
import type { ChatMessage, ChatThreadRecord } from "./storage";

export interface ChatRuntimeModel {
  id: string;
  name: string;
}

interface ChatRuntimeProps {
  thread: ChatThreadRecord;
  group: NewApiGroup;
  model: ChatRuntimeModel;
  onMessagesChange: (messages: ChatMessage[]) => void;
  onError: (message: string) => void;
}

const baseAttachmentAdapter = new CompositeAttachmentAdapter([
  new SimpleImageAttachmentAdapter(),
  new SimpleTextAttachmentAdapter(),
]);

const attachmentAdapter: AttachmentAdapter = {
  accept: baseAttachmentAdapter.accept,
  add({ file }) {
    const limit = file.type.startsWith("image/") ? 2_000_000 : 512_000;
    if (file.size > limit) {
      return Promise.reject(
        new Error(
          file.type.startsWith("image/")
            ? "图片不能超过 2 MB"
            : "文本文件不能超过 512 KB",
        ),
      );
    }
    return baseAttachmentAdapter.add({ file });
  },
  remove(attachment) {
    return baseAttachmentAdapter.remove(attachment);
  },
  send(attachment) {
    return baseAttachmentAdapter.send(attachment);
  },
};

function MarkdownText({ text }: TextMessagePartProps) {
  return (
    <div className="vv-chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          code: ({ children, className }) => (
            <code className={className}>{children}</code>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function ReasoningPart({ text, status }: ReasoningMessagePartProps) {
  return (
    <details className="vv-chat-reasoning" open={status.type === "running"}>
      <summary>
        <Brain size={14} />
        {status.type === "running" ? "正在思考" : "查看思考过程"}
      </summary>
      <div>{text}</div>
    </details>
  );
}

function SourcePart(props: SourceMessagePartProps) {
  const label =
    props.title || (props.sourceType === "url" ? props.url : "来源");
  if (props.sourceType === "url") {
    return (
      <a
        className="vv-chat-source"
        href={props.url}
        target="_blank"
        rel="noreferrer noopener"
      >
        <ExternalLink size={12} /> {label}
      </a>
    );
  }
  return (
    <span className="vv-chat-source">
      <FileText size={12} /> {label}
    </span>
  );
}

function ImagePart({ image, filename }: ImageMessagePartProps) {
  return (
    <figure className="vv-chat-image">
      <img src={image} alt={filename || "对话图片"} />
      {filename && <figcaption>{filename}</figcaption>}
    </figure>
  );
}

function FilePart({ filename, data, mimeType }: FileMessagePartProps) {
  return (
    <a
      className="vv-chat-file"
      href={data}
      download={filename}
      aria-label={`下载 ${filename || "文件"}`}
    >
      <FileText size={15} />
      <span>
        <strong>{filename || "文件"}</strong>
        <small>{mimeType}</small>
      </span>
    </a>
  );
}

function ToolFallback({
  toolName,
  args,
  result,
  status,
  isError,
}: ToolCallMessagePartProps) {
  const running = status.type === "running";
  return (
    <details className={`vv-chat-tool ${isError ? "is-error" : ""}`}>
      <summary>
        {running ? (
          <Loader2 className="vv-spin" size={14} />
        ) : (
          <Wrench size={14} />
        )}
        <span>{toolName}</span>
        <small>{running ? "执行中" : isError ? "失败" : "已完成"}</small>
      </summary>
      <div>
        <strong>参数</strong>
        <pre>{JSON.stringify(args, null, 2)}</pre>
        {result !== undefined && (
          <>
            <strong>结果</strong>
            <pre>
              {typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2)}
            </pre>
          </>
        )}
      </div>
    </details>
  );
}

export function shouldShowMessageLoading(
  status: EmptyMessagePartProps["status"],
): boolean {
  return status.type === "running";
}

function EmptyPart({ status }: EmptyMessagePartProps) {
  if (!shouldShowMessageLoading(status)) return null;

  return (
    <span className="vv-chat-message__loading">
      <i /> <i /> <i />
    </span>
  );
}

const MESSAGE_PARTS = {
  Text: MarkdownText,
  Reasoning: ReasoningPart,
  Source: SourcePart,
  Image: ImagePart,
  File: FilePart,
  Empty: EmptyPart,
  tools: { Fallback: ToolFallback },
};

function MessageAttachments() {
  return (
    <MessagePrimitive.Attachments>
      {() => (
        <AttachmentPrimitive.Root className="vv-chat-attachment vv-chat-attachment--message">
          <FileText size={14} />
          <AttachmentPrimitive.Name />
        </AttachmentPrimitive.Root>
      )}
    </MessagePrimitive.Attachments>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="vv-chat-message vv-chat-message--user">
      <span className="vv-chat-message__avatar">
        <User size={14} />
      </span>
      <div className="vv-chat-message__body">
        <MessageAttachments />
        <div className="vv-chat-message__bubble">
          <MessagePrimitive.Parts components={MESSAGE_PARTS} />
        </div>
        <ActionBarPrimitive.Root
          className="vv-chat-message__actions"
          autohide="not-last"
          autohideFloat="always"
        >
          <ActionBarPrimitive.Copy title="复制消息" aria-label="复制消息">
            <Copy size={13} />
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const hasError = useAuiState((state) => {
    const status = state.message.status;
    return status?.type === "incomplete" && status.reason === "error";
  });

  return (
    <MessagePrimitive.Root className="vv-chat-message vv-chat-message--assistant">
      <span className="vv-chat-message__avatar">
        <Bot size={14} />
      </span>
      <div className="vv-chat-message__body">
        <MessageAttachments />
        <div className="vv-chat-message__bubble">
          <MessagePrimitive.Parts components={MESSAGE_PARTS} />
          <MessagePrimitive.Error>
            <div className="vv-chat-message__error" role="alert">
              <CircleAlert size={15} aria-hidden />
              <div className="vv-chat-message__error-content">
                <strong>消息生成失败</strong>
                <ErrorPrimitive.Message className="vv-chat-message__error-detail" />
              </div>
            </div>
          </MessagePrimitive.Error>
        </div>
        <ActionBarPrimitive.Root
          className="vv-chat-message__actions"
          hideWhenRunning
          autohide="not-last"
          autohideFloat="always"
        >
          <ActionBarPrimitive.Copy title="复制消息" aria-label="复制消息">
            <Copy size={13} />
          </ActionBarPrimitive.Copy>
          <ActionBarPrimitive.Reload
            className={hasError ? "vv-chat-message__retry is-error" : undefined}
            title="重新生成"
            aria-label="重新生成"
          >
            <RefreshCw size={13} />
            {hasError && <span>重新生成</span>}
          </ActionBarPrimitive.Reload>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

function ComposerAttachment() {
  return (
    <AttachmentPrimitive.Root className="vv-chat-attachment">
      <FileText size={13} />
      <AttachmentPrimitive.Name />
      <AttachmentPrimitive.Remove title="移除附件" aria-label="移除附件">
        <X size={12} />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

function ComposerSubmit() {
  const running = useAuiState((state) => state.thread.isRunning);
  return running ? (
    <ComposerPrimitive.Cancel
      className="vv-chat-composer__submit is-cancel"
      title="停止生成"
      aria-label="停止生成"
    >
      <Square size={14} fill="currentColor" />
    </ComposerPrimitive.Cancel>
  ) : (
    <ComposerPrimitive.Send
      className="vv-chat-composer__submit"
      title="发送消息"
      aria-label="发送消息"
    >
      <Send size={15} />
    </ComposerPrimitive.Send>
  );
}

function ChatThread() {
  return (
    <ThreadPrimitive.Root className="vv-chat-thread">
      <ThreadPrimitive.Viewport className="vv-chat-thread__viewport" autoScroll>
        <ThreadPrimitive.Empty>
          <div className="vv-chat-empty">
            <span>
              <Bot size={22} />
            </span>
            <h2>开始一段新对话</h2>
            <p>可以提问、粘贴代码，或添加图片和文本文件。</p>
            <div>
              <ThreadPrimitive.Suggestion
                prompt="帮我解释这段代码的作用"
                send={false}
              >
                解释一段代码
              </ThreadPrimitive.Suggestion>
              <ThreadPrimitive.Suggestion
                prompt="帮我整理一个实现方案"
                send={false}
              >
                整理实现方案
              </ThreadPrimitive.Suggestion>
            </div>
          </div>
        </ThreadPrimitive.Empty>

        <ThreadPrimitive.Messages
          components={{ UserMessage, AssistantMessage }}
        />

        <ThreadPrimitive.ScrollToBottom
          className="vv-chat-scroll-bottom"
          title="滚动到底部"
          aria-label="滚动到底部"
        >
          <ArrowDown size={15} />
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.Viewport>

      <div className="vv-chat-composer-wrap">
        <ComposerPrimitive.Root className="vv-chat-composer">
          <ComposerPrimitive.Attachments
            components={{ Attachment: ComposerAttachment }}
          />
          <div className="vv-chat-composer__row">
            <ComposerPrimitive.AddAttachment
              multiple
              className="vv-chat-composer__attach"
              title="添加图片或文本文件"
              aria-label="添加附件"
            >
              <Paperclip size={16} />
            </ComposerPrimitive.AddAttachment>
            <ComposerPrimitive.Input
              className="vv-chat-composer__input"
              placeholder="输入消息，Enter 发送，Shift + Enter 换行"
              rows={1}
            />
            <ComposerSubmit />
          </div>
        </ComposerPrimitive.Root>
        <small className="vv-chat-composer__hint">
          AI 可能会产生不准确的信息，请核对重要内容。
        </small>
      </div>
    </ThreadPrimitive.Root>
  );
}

export function resolveChatApiBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) return "";

  try {
    const url = new URL(normalized);
    const path = url.pathname.replace(/\/+$/, "");
    if (!/\/v1$/i.test(path)) {
      url.pathname = `${path}/v1`;
    }
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
  }
}

export function ChatRuntime({
  thread,
  group,
  model,
  onMessagesChange,
  onError,
}: ChatRuntimeProps) {
  const transport = useMemo(() => {
    const provider = createOpenAICompatible({
      name: BRAND_CONFIG.distribution.packageName,
      baseURL: resolveChatApiBaseUrl(group.baseUrl),
      apiKey: group.apiKey,
      includeUsage: true,
    });
    const agent = new ToolLoopAgent({ model: provider(model.id) });
    return new DirectChatTransport({
      agent,
      sendReasoning: true,
      sendSources: true,
    });
  }, [group.apiKey, group.baseUrl, model.id]);

  const chat = useChat<ChatMessage>({
    id: thread.id,
    messages: thread.messages,
    transport,
    throttle: 32,
    onError: (error) => onError(error.message),
  });
  const runtime = useAISDKRuntime(chat, {
    adapters: { attachments: attachmentAdapter },
  });

  useEffect(() => {
    const timer = window.setTimeout(
      () => onMessagesChange(chat.messages),
      chat.status === "streaming" ? 180 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [chat.messages, chat.status, onMessagesChange]);

  useEffect(
    () => () => {
      void chat.stop();
    },
    [chat.stop],
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatThread />
    </AssistantRuntimeProvider>
  );
}
