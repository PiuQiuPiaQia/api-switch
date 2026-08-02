# VV Code 成熟对话页方案结论

调研日期：2026-08-01。

## 决策

建议由 VV Code 自己掌控页面和数据，但不要自己实现聊天协议内核。首选组合是：

```text
assistant-ui（历史列表、消息流、输入框和消息 UI）
  + @assistant-ui/react-ai-sdk（UI runtime）
  + Vercel AI SDK v7（统一 UIMessage、流式状态和 Agent）
  + @ai-sdk/openai-compatible（标准 OpenAI-compatible 请求与响应）
  + VV Code 本地 SQLite（会话和消息持久化）
```

对当前项目，这比 iframe、完整开源聊天应用或 Ant Design X 更合适。它能让标准 OpenAI-compatible 模型共用一套消息协议，不再按模型手写请求字段和 SSE parser；同时 UI 仍可沿用现有 Tailwind、Radix 和产品样式。

## 对需求的覆盖

### 1. 左侧历史、右侧对话流

页面内部采用双栏：

```text
ChatPage
├── ThreadListSidebar（约 280px）
│   ├── 新建、搜索
│   └── 切换、重命名、归档、删除
└── ThreadPanel
    ├── 分组 / 模型选择
    ├── Thread 消息流
    └── Composer（附件、发送、停止）
```

assistant-ui 的 `ThreadList` primitives 已覆盖新建、切换、归档、恢复和删除等交互；`Thread`/`Composer` 负责消息流、编辑、重试、停止和输入区。默认 runtime 只有内存会话，因此应用仍需把 thread metadata 和消息接到本地 SQLite。

官方资料：

- https://www.assistant-ui.com/docs/primitives/thread-list
- https://www.assistant-ui.com/docs/runtimes/concepts/threads

### 2. 常见输入输出格式

首版建议正式支持：

- 文本、流式文本、Markdown、代码块；
- reasoning 折叠区；
- 图片输入和受控文件附件；
- tool call / tool result 的通用 fallback 卡片；
- 错误、中止、重试和重新生成。

AI SDK `UIMessage` 与 assistant-ui 的消息 parts 能承载 text、reasoning、file、source、tool 和 typed data。协议结构成熟，但非文本格式仍需应用选择具体 renderer；附件还需限制 MIME/大小并决定直接传输或先上传。

引用、音视频输出和供应商自定义 artifact 不应承诺为首版通用能力，因为 OpenAI Chat Completions 对这些没有统一 wire format。

### 3. 避免模型和字段适配

调用链建议为：

```text
useChatRuntime / useChat
  → DirectChatTransport
  → ToolLoopAgent
  → createOpenAICompatible({ baseURL, apiKey })
  → New API /v1/chat/completions
```

这样可以交给成熟库处理：

1. UI message 到 model message 的转换；
2. 标准 OpenAI-compatible 请求字段；
3. SSE/流式响应解析；
4. 标准文本、reasoning 和 tool parts 的流式状态。

VV Code 只需将当前分组的 `baseUrl`、`apiKey` 和 `modelId` 传给 provider，不需要为 Claude、GPT、Gemini 等模型分别写 adapter。前提是统一经过 New API 的标准 OpenAI-compatible Chat Completions 接口。

若某个上游返回私有字段，例如非标准 reasoning、citation 或文件结构，仍需一次网关级兼容或 AI SDK `metadataExtractor`/`transformRequestBody`；任何 SDK 都无法对任意私有协议做到绝对零适配。

官方资料：

- https://www.assistant-ui.com/docs/runtimes/ai-sdk/overview
- https://ai-sdk.dev/docs/reference/ai-sdk-ui/direct-chat-transport
- https://ai-sdk.dev/providers/openai-compatible-providers

## 仍需实现的薄接入层

这些不是按模型做字段适配，而是产品自身的数据和安全接入：

1. 分组/模型选择后重建 provider 与 Agent；
2. 本地 `RemoteThreadListAdapter` 与 `ThreadHistoryAdapter.withFormat`；
3. 附件读取、大小/MIME 限制和上传策略；
4. reasoning、source、file、tool 的通用 renderer/fallback；
5. CORS 不允许或不希望 key 留在 WebView 时，通过 Tauri/Rust 提供网络 bridge。

历史消息可按 AI SDK 的编码格式作为不透明 payload 存入 SQLite，数据库不必理解每一种 message part。

## 候选方案比较

| 方案 | 页面完成度 | 标准协议适配 | 本地历史 | 与当前 UI 契合 | 结论 |
| --- | --- | --- | --- | --- | --- |
| assistant-ui + AI SDK | 高 | 最强；标准 OpenAI-compatible 无需手写 SSE/字段映射 | 需薄 SQLite adapter | 最好，适合 Tailwind/Radix | **首选** |
| Ant Design X | 很高 | 纯文本强；通用 tool/reasoning/多模态仍需 parser/provider | 需自建 | 会引入 antd 6 第二套设计系统 | 备选 |
| Deep Chat | 中；主要是单聊天窗 | 特定 OpenAI preset 可少适配，通用 connect 是自有格式 | 历史侧栏需自建 | 尚可 | 只适合低范围 MVP |
| Open WebUI / LobeHub / LibreChat | 完整产品 | 自身接上游较成熟 | 自带，但属于另一套系统 | 差；需 iframe/fork/独立后端 | 不采用 |

Ant Design X 官方 `Conversations`、`Bubble`、`Sender` 和 `XMarkdown` 很成熟，但当前内置 OpenAI provider 主要覆盖文本 Chat Completions，且本项目尚未使用 antd。完整开源应用则不是稳定的 React 组件包，复用它们会重新引入 iframe/子 WebView、额外鉴权、数据库和升级成本。

相关资料：

- https://x.ant.design/components/conversations/
- https://x.ant.design/x-sdks/chat-provider-open-ai/
- https://x.ant.design/x-markdowns/introduce/

## 建议边界

首版按“标准聊天工作台”落地：本地多会话、分组/模型选择、文本/Markdown/代码、reasoning、图片附件、停止/重试和通用工具卡片。先不做服务端会话同步、音视频生成、任意供应商私有 artifact 和流重连。

依赖版本应锁定并做一个最小技术验证，重点验证 Tauri WebView 下的流式输出、停止、SQLite 重新载入、跨平台 CORS 和 Markdown 安全渲染。`DirectChatTransport` 可以中止当前流，但应用重载后不能续接同一条未完成的流。

## 分项材料

- `findings_assistant_stack.md`：assistant-ui、AI SDK、DirectChatTransport、OpenAI-compatible provider 和持久化边界。
- `findings_antd_x.md`：Ant Design X 页面组件、x-sdk 字段覆盖与设计系统成本。
- `findings_full_apps.md`：Open WebUI、LobeHub、LibreChat、Deep Chat 的嵌入与许可判断。
