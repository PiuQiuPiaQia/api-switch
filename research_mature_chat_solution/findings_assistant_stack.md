# assistant-ui + Vercel AI SDK 调研结论

调研日期：2026-08-01。仅使用 assistant-ui、Vercel AI SDK 的官方文档/仓库及 npm 官方 registry。

## 结论先行

这套栈是当前最接近“成熟 UI + 不自己解析 OpenAI SSE、不自己维护消息字段转换”的方案，适合 VV Code 的 Tauri + Vite + React 18 页面：

```text
ThreadList + Thread（assistant-ui）
        ↓
useChatRuntime（@assistant-ui/react-ai-sdk）
        ↓
DirectChatTransport → ToolLoopAgent（AI SDK）
        ↓
createOpenAICompatible（@ai-sdk/openai-compatible）
        ↓
标准 OpenAI-compatible /v1/chat/completions
```

它可以省掉三层高维护工作：

1. `@assistant-ui/react-ai-sdk` 负责 assistant-ui runtime 与 AI SDK `UIMessage` 的转换。
2. `DirectChatTransport` 校验 UI messages、调用 `convertToModelMessages`、执行 Agent，并产出 `UIMessageChunk` 流。
3. `@ai-sdk/openai-compatible` 负责标准 OpenAI-compatible 请求、流式响应、工具调用及 reasoning 字段的协议转换。

因此，对**标准 OpenAI-compatible Chat Completions**，应用无需再手写模型消息字段映射或 SSE parser。这里的“免适配”不是任意供应商都零代码：会话持久化、附件、模型/分组选择、非标准供应商字段和 UI 渲染仍由应用负责，详见后文。

推荐新项目版本线为 `@assistant-ui/react-ai-sdk@^1.4 + ai@^7 + @ai-sdk/react@^4`；assistant-ui 官方明确把 AI SDK v5/v6 标为 legacy，新项目应使用 v7。

官方依据：

- https://www.assistant-ui.com/docs/runtimes/ai-sdk/overview
- https://www.assistant-ui.com/docs/runtimes/ai-sdk/v7
- https://ai-sdk.dev/docs/ai-sdk-ui/transport
- https://ai-sdk.dev/docs/reference/ai-sdk-ui/direct-chat-transport
- https://ai-sdk.dev/providers/openai-compatible-providers

## 1. 左侧历史列表与持久化

### 已有成熟能力

`ThreadListPrimitive` 已提供新建、列出、切换、重命名、归档、恢复和删除会话的交互原语，足以实现“左侧历史列表、右侧 Thread 对话流”。它是无样式/可组合原语，不会强迫项目引入另一套视觉设计系统。

- ThreadList UI：https://www.assistant-ui.com/docs/primitives/thread-list
- Threads runtime：https://www.assistant-ui.com/docs/runtimes/concepts/threads

多会话有三条官方路径：

- `AssistantCloud`：托管 thread metadata、消息持久化、同步和标题，应用适配代码最少，但引入外部服务/认证/数据治理问题。
- `useRemoteThreadListRuntime + RemoteThreadListAdapter`：接任意自有数据库；实现 list/initialize/rename/archive/unarchive/delete/fetch/generateTitle 等元数据操作。
- `ExternalStoreThreadListAdapter`：使用 Redux/Zustand 等外部 store 时自行持有会话与消息状态。

### 仍需自行实现

默认 runtime 只有内存会话，刷新会丢失。若 VV Code 要本地历史，至少需要：

1. 一个 thread metadata adapter，把 thread 列表映射到 Rust/SQLite、IndexedDB 或现有本地存储。
2. 一个 thread-scoped `ThreadHistoryAdapter` 保存每个 thread 的消息。

AI SDK v7 集成要求 history adapter 实现 `withFormat(fmt)`；`fmt.encode/decode` 会让存储层按不透明 payload 保存 AI SDK `UIMessage`，所以**数据库无需认识 text/reasoning/tool 等内部字段**。但 load/append/delete/列表等 I/O 仍要自己写。`RemoteThreadListAdapter` 本身只管元数据，消息持久化应通过它的 thread-scoped `unstable_Provider` 注入 history adapter。

- AI SDK history adapter 示例：https://www.assistant-ui.com/docs/runtimes/ai-sdk/v7#persisting-chat-history
- RemoteThreadList 与消息持久化：https://www.assistant-ui.com/docs/runtimes/concepts/threads#remote-thread-list-runtime-custom-database

判断：**ThreadList UI 开箱可用；本地持久化并非开箱即用，但 adapter 边界成熟，而且可把消息内容当不透明格式保存。**

## 2. 消息 parts / 常见格式

assistant-ui 的消息 pipeline 支持：

- modality：`text`、`image`、`file`；非图片二进制（音频、视频、PDF 等）统一走 file + MIME type。
- provider channel：`reasoning`、`source`、`tool-call`、`generative-ui`。
- extensibility：命名 `data` parts，用于应用自定义结构化 UI。

AI SDK `UIMessage` 原生定义了 text、reasoning、tool、source URL、source document、file、typed data 和 step-start parts。

- assistant-ui Message parts：https://www.assistant-ui.com/docs/primitives/message#part-types
- AI SDK UIMessage：https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message

端到端能力边界：

| 格式 | 结构/流支持 | 是否真正零适配 |
|---|---|---|
| 文本、流式文本 | assistant-ui + AI SDK + OpenAI-compatible provider 完整支持 | 是 |
| Markdown / 代码块 | 作为 text part 传输；需要选用/配置 Markdown 与代码 renderer | 协议层是，展示层需配置 |
| Reasoning | AI SDK 和 assistant-ui 都有 reasoning part；OpenAI-compatible provider 官方列为支持能力 | 标准 `reasoning_content` 路径基本是；非标准字段可能需 metadata extractor |
| 图片/文件输入 | attachment adapter 转成 AI SDK file/image content；是否被模型接受取决于 provider/model | 否，需要 attachment adapter，且要做大小/MIME/上传策略 |
| 文件/音频/视频输出 | UI 有 file renderer 结构 | OpenAI Chat Completions 没有统一文件输出协议，通常需供应商适配 |
| Tool calls/results | AI SDK、DirectChatTransport、assistant-ui tool parts/UI 均支持，可流式、多轮 | 协议结构是；工具定义、执行权限与具体卡片 renderer 仍需写 |
| Sources / citations | assistant-ui 与 AI SDK 有 source parts；DirectChatTransport 有 `sendSources` | 普通 OpenAI-compatible Chat Completions 没有统一 sources 字段，不能保证零适配 |
| 自定义卡片 | typed data / generative UI | 必须定义 schema 与 renderer |

重要细节：`MessagePrimitive.Parts` 默认只对 text/image 有可见的基础渲染；tool call 若没注册 Tool UI 会不显示，reasoning/source/file/audio 默认也不显示。因此“格式结构已支持”不等于“所有格式已有成品视觉组件”，项目仍需组合官方 registry 组件或提供 fallback renderer。

附件官方示例要求 adapter 的 `send` 返回 AI SDK 形状的 file/image content；AI SDK 再交给支持多模态的 provider。assistant-ui 文档也明确提醒 file converter 的 adapter coverage 并不完全一致。

- Attachments：https://www.assistant-ui.com/docs/runtimes/ai-sdk/v7#attachments
- Tool UI：https://www.assistant-ui.com/docs/tools/tool-ui
- Reasoning UI：https://www.assistant-ui.com/docs/ui/reasoning

## 3. `@assistant-ui/react-ai-sdk` 的角色

当前官方推荐 `useChatRuntime`，它包装 AI SDK `useChat`，并增加 assistant-ui 的 adapters、thread/cloud 支持和默认 `AssistantChatTransport`。相比之下，`useAISDKRuntime` 是拿已有 `useChat` 实例接入的低层方案。

对 VV Code 可以直接给 `useChatRuntime` 传一个 AI SDK `ChatTransport`。如果传 `DirectChatTransport`，就可以在桌面 renderer 内直接运行 `ToolLoopAgent`，不需要 Next.js `/api/chat` route。

但 `DirectChatTransport` 不是 `AssistantChatTransport` 的子类，因此会失去后者额外提供的 assistant-ui system-message / frontend-tool 自动转发。解决办法有两种：

- 固定 system instruction 和工具直接定义在 `ToolLoopAgent` 中（最简单）。
- 若需要 assistant-ui 动态 frontend tools/system forwarding，继续使用 `AssistantChatTransport` + 自有 AI SDK backend route，或写一层 transport bridge。

官方明确说明，自定义 transport 若不继承 `AssistantChatTransport`，这些自动转发能力需要应用自行控制：
https://www.assistant-ui.com/docs/runtimes/ai-sdk/v7#custom-transport

## 4. DirectChatTransport + OpenAI-compatible provider

`DirectChatTransport` 是 AI SDK v7 官方提供的 in-process transport，文档明确把 single-process desktop/CLI app 列为适用场景。它会：

1. 校验 UI messages；
2. 调用 `convertToModelMessages`；
3. 调用 Agent 的 `stream()`；
4. 转为 UI message stream。

它可配置 `sendReasoning` 和 `sendSources`；不支持 stream reconnection，`reconnectToStream()` 永远返回 `null`。停止/abort 当前请求可用，但应用重载后不能续接原流。

- Transport 指南：https://ai-sdk.dev/docs/ai-sdk-ui/transport#direct-agent-transport
- API reference：https://ai-sdk.dev/docs/reference/ai-sdk-ui/direct-chat-transport
- 源码：https://github.com/vercel/ai/blob/main/packages/ai/src/ui/direct-chat-transport.ts

`createOpenAICompatible` 接收 `name`、`baseURL`、`apiKey`、headers、query params、自定义 fetch，并提供 chat model。官方列出的 chat 能力包括 text、streaming、tool calling、structured outputs、reasoning、system messages 和 provider-dependent multimodal inputs。

- Provider 文档：https://ai-sdk.dev/providers/openai-compatible-providers
- 官方包 README：https://github.com/vercel/ai/blob/main/packages/openai-compatible/README.md

它也暴露 `transformRequestBody` 与 `metadataExtractor`，这同时说明边界：如果某网关只是“部分兼容”或用了自定义 reasoning/citation 字段，仍可能要少量供应商配置；不存在对所有 OpenAI-like API 的绝对零适配保证。

## 5. React 18 / Vite / Tauri 可行性

2026-08-01 npm registry 当前版本与 peer/engine：

| 包 | 当前版本 | 关键约束 |
|---|---:|---|
| `@assistant-ui/react` | 0.15.1 | React/React DOM `^18 || ^19` |
| `@assistant-ui/react-ai-sdk` | 1.4.2 | React `^18 || ^19` |
| `@ai-sdk/react` | 4.0.50 | React 18/19；Node `>=22`（安装/构建环境） |
| `ai` | 7.0.47 | Node `>=22`；Zod 3.25/4.1 |
| `@ai-sdk/openai-compatible` | 3.0.20 | Node `>=22`；Zod 3.25/4.1 |

npm：

- https://www.npmjs.com/package/@assistant-ui/react
- https://www.npmjs.com/package/@assistant-ui/react-ai-sdk
- https://www.npmjs.com/package/@ai-sdk/react
- https://www.npmjs.com/package/ai
- https://www.npmjs.com/package/@ai-sdk/openai-compatible

当前仓库是 React 18.2、Zod 4.1、Node 22.22，满足这条版本线。assistant-ui 是 React primitives，并不要求 Next.js；Vite/Tauri 可以使用。

### Tauri / browser 特有风险

1. **CORS**：provider 默认使用 WebView 的 global `fetch`。目标网关必须允许 Tauri origin 的跨域请求；当前 `tauri.conf.json` 的 `connect-src` 已允许 http/https，但 CSP 放行不等于服务端 CORS 放行。
2. **密钥边界**：renderer 直连意味着 API key 会进入 WebView JavaScript 内存。若必须让密钥只存在 Rust/服务端，就不能用纯 renderer DirectChatTransport；需要 app-owned backend route、sidecar，或 Tauri IPC/custom fetch/transport bridge。
3. **高权限 renderer 安全复核**：本仓库现有安全注释把 renderer 视为可信，并把“渲染网络富文本/HTML/SVG”列为需要重新审视 IPC 安全边界的触发条件。模型输出必须视为不可信内容；Markdown 禁止 raw HTML/脚本，链接安全打开，工具卡片不得执行模型提供的代码。
4. **流恢复**：DirectChatTransport 不支持 reload reconnection。可以保存已完成/增量历史，但无法在窗口重载后续接同一网络流。
5. **大附件**：base64/data URL 会放大内存占用；桌面端应限制大小/MIME，较大文件先上传或存本地并显式决定是否允许模型访问。
6. **Node engine**：当前 AI SDK v7 包声明 Node `>=22`；这主要影响 Vite 安装/构建工具链，当前工作区已满足。最终运行在 WebView 的代码仍应做一次 macOS WKWebView 与 Windows WebView2 的真实流式 smoke test。

## 6. 建议落地边界

首版最省定制的组合：

- UI：assistant-ui `ThreadList` + `Thread`/composer primitives，沿用现有 Tailwind/Radix 视觉。
- Runtime：`useChatRuntime`。
- 模型链：`DirectChatTransport` + `ToolLoopAgent` + `createOpenAICompatible`。
- 本地历史：自有 `RemoteThreadListAdapter` + `ThreadHistoryAdapter.withFormat`，消息 payload 不透明落盘。
- 首版格式：text/Markdown/code、reasoning、图片附件、工具 fallback；sources 和通用文件输出只在后端确实提供标准 parts 时开启。

仍需 VV Code 写的适配层，按必要性排序：

1. 分组/Base URL/API key/model id → provider/agent/transport 的选择与重建。
2. thread metadata + history 存储 adapter。
3. attachment adapter（读取、MIME、大小、安全及上传策略）。
4. reasoning/source/file/tool 的 UI renderer 与 fallback。
5. CORS 或密钥不进 renderer 时的网络 bridge。
6. 个别“非完全 OpenAI-compatible”供应商的 request transform / metadata extraction。

最终判断：**可以把“模型请求字段、标准流式 SSE、AI SDK 消息到 UI 消息”的适配交给成熟库；不能把“业务模型选择、本地历史、附件安全、非标准供应商字段、具体展示卡片”也当成自动完成。**
