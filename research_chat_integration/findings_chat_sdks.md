# React 对话 SDK / 组件调研

调研时间：2026-08-01。结论先行：**本仓库优先采用 `assistant-ui` 的 `@assistant-ui/react` + `useLocalRuntime`，自行实现一个很薄的 New API / OpenAI-compatible SSE 适配器；首版不要叠加 `@assistant-ui/react-ai-sdk`。** 它是四个候选中唯一同时满足“AI 对话状态与交互较完整”“不要求特定后端协议”“能复用现有 shadcn/Tailwind/Radix 视觉基础”的方案。

## 仓库约束

- 当前是 Tauri 2 + Vite + React 18.2 + Tailwind 3.4；已经有 `components.json`、shadcn 风格 CSS variables、Radix、Lucide、`cn()` 与明暗主题。
- New API OAuth `access_token` 保存在 Rust `StoredSession`，返回给 React 的 `NewApiSessionSummary` 明确不含 token。因此不应为了套 SDK 默认范式，把 OAuth token 或其它长期凭据搬进 WebView。
- OpenAI Chat Completions 原生 SSE 与 assistant-ui / Vercel AI SDK 的高级消息流协议并非同一种 wire format。无论选择哪一个，都应明确实现解析边界，并覆盖文本 delta、`finish_reason`、中止、错误以及后续的 tool-call delta。

## 高信号对比

| 方案 | 许可证与维护 | React / 集成重量 | 传输与后端约束 | Markdown / code | 附件 / tool calls | 对本仓库判断 |
|---|---|---|---|---|---|---|
| **assistant-ui** (`@assistant-ui/react`) | MIT；npm 最新 `0.15.1`，React `^18 || ^19`；GitHub 约 11.3k stars，2026-08-01 仍有提交。活跃，但 `0.x` 意味着要锁版本并预留迁移成本。[仓库](https://github.com/assistant-ui/assistant-ui) · [npm](https://www.npmjs.com/package/@assistant-ui/react) | 核心 npm 包解包约 2.39 MB；可选 Markdown 包约 0.13 MB（这是 registry 的 `dist.unpackedSize`，不是浏览器 gzip）。组件以可编辑的 shadcn 源码加入项目，依赖 Radix/Zustand 等；与本仓库已有栈重合度最高。 | `LocalRuntime` 只要求实现一个 `ChatModelAdapter.run`；`async *` 可流式 yield 累积消息，支持 cancellation、编辑、重试、分支。无需 Next.js、Vercel 或 Assistant Cloud；Cloud 仅可选。也能接 AI SDK，但本项目没有必要先引入第二套 runtime。[LocalRuntime](https://www.assistant-ui.com/docs/runtimes/custom/local-runtime) | Thread 默认可加入 `@assistant-ui/react-markdown` / `react-markdown`；代码高亮需另加 `react-shiki` 或 syntax-highlighter，且官方文档提示完整 Shiki bundle 要主动优化。[Markdown](https://www.assistant-ui.com/docs/ui/markdown) · [代码高亮](https://www.assistant-ui.com/docs/ui/syntax-highlighting) | 完整 attachment adapter、拖放/粘贴/预览 UI；tool-call 有 running/result/error/approval 与 fallback/custom React renderer。使用 LocalRuntime 时需要在适配器内把 OpenAI tool delta 累积成 assistant-ui parts。[附件](https://www.assistant-ui.com/docs/guides/attachments) · [Tool UI](https://www.assistant-ui.com/docs/tools/tool-ui) | **推荐。** 采用 primitives/runtime，按 VV Code 风格裁剪 registry 组件；首版只装核心、thread、Markdown，图片附件和 tools 按需求渐进开启。 |
| **Vercel AI SDK UI** (`@ai-sdk/react` + `ai`；可选 AI Elements) | Apache-2.0；当前 `@ai-sdk/react 4.0.50` / `ai 7.0.47`，React peer 支持 18；GitHub 约 25.9k stars，2026-08-01 活跃。[仓库](https://github.com/vercel/ai) · [许可证](https://github.com/vercel/ai/blob/main/LICENSE) | `@ai-sdk/react` 解包约 0.30 MB，但其 `ai` 依赖约 6.57 MB；OpenAI-compatible provider 另约 0.40 MB。实际浏览器产物会 tree-shake，不能把这些数当 bundle 大小。SDK 本身偏 headless，UI 实现工作量大。 | 框架无关，不强制 Vercel/Next。默认 `DefaultChatTransport` 请求 `/api/chat` 并消费 AI SDK UI Message SSE；原生 OpenAI SSE 不能直接冒充它。可写任意 `ChatTransport`，也有面向 desktop/CLI 单进程的 `DirectChatTransport`。若直接使用 `createOpenAICompatible`，应在 Rust/可信服务侧持有凭据。[Transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport) · [OpenAI-compatible provider](https://ai-sdk.dev/providers/openai-compatible-providers) | SDK 不提供消息视觉或 Markdown renderer，官方示例只是逐个渲染 `message.parts`。AI Elements 可补 message/code UI，但以 shadcn 源码安装，MessageResponse 会再引入 Streamdown 插件，官方 README 仍把 Next.js 列为前置条件，Vite 下需要人工适配。[AI Elements](https://github.com/vercel/ai-elements) | `UIMessage.parts` 原生表达 file、reasoning、source、typed/dynamic tool、审批和结果；FileList 会转 data URL。但视觉、上传生命周期与每种 tool UI 仍要自行实现或选装 AI Elements。[附件](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot#attachments) · [tools](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage) | **第二选择。** 如果服务端将来正式输出 AI SDK UI Message Stream，或项目本来就要采用 AI SDK agent/tool 模型，则价值很高；仅为当前原生 OpenAI SSE 对话页引入它，协议转换与 UI 工作都不会更少。 |
| **Ant Design X** (`@ant-design/x`, `x-sdk`, `x-markdown`) | MIT；三包均为 `2.9.0`，React `>=18`，2026-07-28 发布，仓库约 4.7k stars且 2026-08-01 活跃。[仓库](https://github.com/ant-design/x) | `@ant-design/x` 解包约 19.8 MB，并要求 `antd >=6.1.1`；`x-markdown` 约 5.92 MB，`x-sdk` 约 3.30 MB。组件包还带 Ant 图标、CSS-in-JS、Mermaid、syntax-highlighter。这里同样是安装体积代理，但足以说明它会引入第二套完整设计系统。 | `XRequest` / `XStream` 支持 endpoint、headers、transformer、自定义流协议，`x-sdk` 有 OpenAI chat provider；不强制自家后端。[x-sdk](https://github.com/ant-design/x/tree/main/packages/x-sdk) | `x-markdown` 明确面向流式 Markdown，支持公式、代码高亮、Mermaid。[x-markdown](https://github.com/ant-design/x/tree/main/packages/x-markdown) | 有成熟 Attachments、Sender、Bubble 等原子 UI。工具结果可通过自定义 Bubble/message 内容或可选 A2UI XCard 表达，但不像 assistant-ui 那样在基础 runtime 中提供统一的 typed tool lifecycle。[Attachments](https://github.com/ant-design/x/tree/main/packages/x/components/attachments) | 功能完整且维护积极，**但不适合本仓库**：会并存 Ant Design 与现有 shadcn/Radix，两套主题、图标、CSS-in-JS 和交互语言的代价明显。若产品全面迁移到 Ant Design 才考虑。 |
| **Chatscope Chat UI Kit React** | MIT；`2.1.1` 支持 React 18/19，但最后一次代码发布/推送为 2025-05-15，至本次调研已约 15 个月无代码更新。[仓库](https://github.com/chatscope/chat-ui-kit-react) · [npm](https://www.npmjs.com/package/@chatscope/chat-ui-kit-react) | 组件约 0.72 MB、样式约 0.50 MB（解包体积），另带 FontAwesome 与自有整套 CSS；会与本仓库 Lucide/Tailwind 重复。 | 完全 transport-neutral，也完全不处理 AI stream/state；所有 SSE、消息归并、retry/abort/history 都由应用实现。 | 无内建 Markdown 或 code rendering；可用 `Message.CustomContent` 嵌入第三方 renderer。默认 Message type 是 HTML，源码使用 `dangerouslySetInnerHTML`，绝不能直接把模型输出喂给它。[Message 源码](https://github.com/chatscope/chat-ui-kit-react/blob/master/src/components/Message/Message.jsx) · [HTML renderer](https://github.com/chatscope/chat-ui-kit-react/blob/master/src/components/Message/MessageHtmlContent.jsx) | `AttachmentButton` 只是 `onAttachClick` 按钮，没有上传/消息 attachment lifecycle；没有 tool-call 数据模型或 renderer。 | 只适合传统 messenger 外壳。对 AI 对话要补的核心能力太多，维护节奏也落后，**不建议**。 |

### 未列为主候选：NLUX

NLUX 的 API 曾经很贴题（React 18、custom streaming adapter、Markdown/highlighter、零 UI 依赖），但 npm 最新 `2.17.1` 停在 2024-08；之后仓库仅见一次 2025-11 的文档提交。更重要的是它声称 MPL-2.0，却在许可证中另加了 AI 训练与代码翻译限制，已不是无修改的标准 MPL 文本。对长期维护和许可证审查都不如上述选项，故不进入推荐短名单。[NLUX 仓库与许可证说明](https://github.com/nlkitai/nlux)

## 建议的最小实现边界

1. UI 层使用 `@assistant-ui/react` 的 `AssistantRuntimeProvider`、Thread/Message/Composer primitives；从 registry 只取所需组件并改成现有 VV Code 样式，不直接照搬完整 starter。
2. Runtime 使用 `useLocalRuntime(chatAdapter)`。`chatAdapter.run` 将 assistant-ui messages 映射为 OpenAI Chat Completions 请求，并把 New API SSE 累积为 assistant-ui 的完整 content state；官方要求每次 yield **累计状态而不是 delta**。
3. 凭据与网络边界保持现状：优先让 Rust command / 本地受控 proxy 发出请求并把 chunk 送给适配器；若选择已有 group-scoped API key 直接从 WebView 请求，也要明确这是不同于 OAuth access token 的暴露面，并验证 Tauri CSP、CORS、日志脱敏和撤销能力。
4. 首版范围控制为 text streaming、stop、retry、Markdown、copy code、model selector、local conversation state。代码高亮用按语言动态加载的 Shiki web/custom bundle，避免全量语言与主题。
5. 第二阶段再接图片 attachments 与 tool calls；在进入第二阶段前先保存原始 SSE fixture，为 content delta、reasoning、并行 tool calls、半截 JSON 参数、错误结束和用户中止建立解析测试。

## 可验证原型的通过条件

- React 18 + Vite production build 无 SSR/Next 假设和 peer dependency 冲突。
- 100 次以上小 chunk 流式输出不明显卡顿，停止操作能真正取消 Rust/HTTP 请求，而不只是停止 UI 更新。
- Markdown 默认不允许原始不可信 HTML；链接采取安全的外部打开策略；代码块可复制且不会把完整 Shiki bundle打进首屏。
- API key / OAuth token 不出现在前端日志、错误 toast、DevTools console 或持久化 conversation JSON 中。
- OpenAI-compatible 基础文本正常；不支持的 reasoning/tool/attachment part 会安全降级显示，而不是丢失整条消息。

## 数据口径

版本、peerDependencies、许可证和 `dist.unpackedSize` 取自 npm registry；仓库活跃度取自 GitHub repository/release metadata。解包体积只用于比较依赖/安装面，不等同于 Vite 最终的 minified/gzip browser bundle；真实取舍应由最小原型构建后的 chunk report 决定。
