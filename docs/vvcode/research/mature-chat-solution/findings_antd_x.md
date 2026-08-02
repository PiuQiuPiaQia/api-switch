# Ant Design X 2.x 调研结论

调研日期：2026-08-01。官网与仓库当前版本为 `2.9.0`。

## 结论先行

**Ant Design X 是成熟的“聊天页面 UI + 内存态数据流”工具箱，但不是端到端、零字段适配的聊天运行时。** 它很适合快速拼出“左侧历史列表、右侧对话流”的完整视觉页面；对于标准 OpenAI Chat Completions 的纯文本 SSE，可以直接连接 New API。可一旦需求包含附件/图片消息、tool calls、通用 reasoning、引用、usage 等常见结构，仍必须实现上传链路、消息 parts、provider/parser 或自定义渲染。它因此不能兑现“无需专门模型或字段适配”这一强要求。

对 VV Code 的另一项明显成本是：当前项目使用 Tailwind + Radix，未使用 Ant Design；Ant Design X 2.9 强制引入 `antd ^6.1.1`，会成为第二套设计系统。若项目本来就用 antd，我会把它列为强候选；对本项目则是 **UI 完成度高、协议抽象较弱、集成成本中等偏高** 的备选。

## 1. 页面布局与组件覆盖

- `Conversations` 就是历史会话列表组件，支持选中、分组/折叠、新建入口、菜单、快捷键和无限加载示例；但 `items`/`activeKey` 仍由应用提供，它不是自带数据库的会话侧栏。[Conversations 官方文档](https://x.ant.design/components/conversations/)
- `Bubble.List` 提供角色样式、流式状态、自动滚动、loading/error/abort 状态，以及 header/footer/avatar/extra/edit 等插槽。[Bubble 官方文档](https://x.ant.design/components/bubble/)
- `Sender` 支持受控文本、发送/取消、语音入口、粘贴文件、结构化 slot/skill 输入和可插拔头尾区域。[Sender 官方文档](https://x.ant.design/components/sender/)
- `Attachments` 基于 antd `Upload`，支持选择、拖放、预览/列表和与 `Sender.Header` 组合。[Attachments 官方文档](https://x.ant.design/components/attachments/)
- 因此左右双栏页面不需要自造底层交互组件，但仍要编写页面 shell、宽度/响应式、空态、会话标题与 CRUD 业务逻辑。它是组件套件和示例模板，不是一个传入 endpoint 就完成全部功能的单一 `ChatPage`。

## 2. 常见输入输出格式

### 输出

`@ant-design/x-markdown` 适合 LLM 流式文本：基于 `marked`，默认 GFM，声明兼容 CommonMark/GFM，内置 DOMPurify 防护，能处理流式未闭合的链接、图片、表格、行内代码等。代码高亮、Mermaid、`Think` 可通过组件映射接入；LaTeX 通过插件接入。它支持自定义 Markdown/HTML 标签，因此扩展卡片是可行的。[XMarkdown 介绍](https://x.ant.design/x-markdowns/introduce/)、[API 与示例](https://x.ant.design/x-markdowns/examples/)、[流式渲染](https://x.ant.design/x-markdowns/streaming/)、[组件扩展](https://x.ant.design/x-markdowns/components/)

边界：`Bubble` 的 `content` 本质是字符串/对象/ReactNode，XMarkdown 只负责 Markdown。图片二进制、音频、文件卡片、引用、tool result、artifact 等没有统一的“消息 parts 自动渲染器”，需要在 `useXChat.parser`/`Bubble.contentRender` 中自行映射。

### 输入

`Sender + Attachments` 把文本、语音入口、文件选择/拖放 UI 做好了，但 `Attachments` 官方定义是展示/上传文件列表，继承 antd Upload。它不会自动把 `File` 上传到 New API，也不会转换成 OpenAI `image_url`、`input_audio` 或其他 content parts；这些仍是应用层职责。

## 3. x-sdk、OpenAI 兼容与流式能力

- `XRequest` 支持 `application/json` 与标准 `text/event-stream`，默认 POST JSON，提供 abort、超时、重试、自定义 fetch 和自定义 stream transformer。[XRequest 源码](https://raw.githubusercontent.com/ant-design/x/main/packages/x-sdk/src/x-request/index.ts)、[XStream 源码](https://raw.githubusercontent.com/ant-design/x/main/packages/x-sdk/src/x-stream/index.ts)
- `useXChat` 管理单会话消息状态、流式更新、停止、重试、错误占位和历史初始化；`parser` 明确用于把 provider 消息转换为 Bubble 消费的格式。[useXChat 官方文档](https://x.ant.design/x-sdks/use-x-chat/)
- `OpenAIChatProvider` 会把内存中的历史消息组装到 `messages`，并能解析 OpenAI Chat Completions 的 JSON/SSE；所以对于 New API 的 `/v1/chat/completions` + `choices[].delta.content` 纯文本流，通常不需协议适配。[OpenAIChatProvider 文档](https://x.ant.design/x-sdks/chat-provider-open-ai/)

但官方当前实现的 `transformMessage` **只累计** `choices[].delta.content` / `choices[].message.content`，最终只保留 `{ role, content }`。它没有累计/暴露 `tool_calls`、`function_call`、`reasoning_content`、`annotations`、`usage`、`finish_reason`、response id 等字段。[OpenAIChatProvider 2.9 源码](https://raw.githubusercontent.com/ant-design/x/main/packages/x-sdk/src/chat-providers/OpenAIChatProvider.ts)

更强的源码证据：`XModelParams` 虽列出 `tool_choice`、`parallel_tool_calls`、`reasoning_effort`，但 `tools` 定义当前仍被注释；响应类型虽然写了 `reasoning_content` 与 `finish_reason: 'tool_calls'`，上述 OpenAI provider 并不消费它们。[模型类型源码](https://raw.githubusercontent.com/ant-design/x/main/packages/x-sdk/src/chat-providers/types/model.ts)

推理输出只有特例：`DeepSeekChatProvider` 识别 `reasoning_content`，并拼成 `<think>` 标签给 `Think` 组件展示；这不是跨厂商、跨字段的通用 reasoning parts 模型。[DeepSeek provider 文档](https://x.ant.design/x-sdks/chat-provider-deepseek/)、[源码](https://raw.githubusercontent.com/ant-design/x/main/packages/x-sdk/src/chat-providers/DeepSeekChatProvider.ts)

**因此对 New API 的判断是：**

| 场景 | 是否可直接用内置 provider |
| --- | --- |
| OpenAI-compatible 文本 Chat Completions，JSON/SSE | 是，基本可直连 |
| Markdown/代码输出 | 是，文本交给 XMarkdown |
| DeepSeek `reasoning_content` | 换 `DeepSeekChatProvider` 可用 |
| 其他推理字段/Responses API reasoning parts | 否，要自定义 provider/parser |
| tool calls / tool results | 否，要实现分片累计、执行循环、消息映射与 UI |
| 图片/音频/文件 content parts | 否，要实现上传、请求字段和渲染映射 |
| 引用、usage、finish reason 等元数据 | 否，内置 OpenAI provider 会丢弃 |

## 4. 历史与持久化：名称容易造成误判

官网把 `useXConversations` 描述为管理多会话“persistence and CRUD”，并提供新增、删除、更新、切换和 `getMessages`；`useXChat.defaultMessages` 也能同步/异步加载历史。[useXConversations 文档](https://x.ant.design/x-sdks/use-x-conversations/)

但 2.9 源码显示真实存储只是 React 生命周期内的内存数组和模块级 `Map`：没有 `localStorage`、IndexedDB、SQLite、文件或服务端写回；hook 卸载时还会 destroy store。消息 store 同样是内存 Map。所谓 persistence 更接近“多会话切换时保持内存状态”，**不是应用重启后的持久化**。[ConversationStore 源码](https://raw.githubusercontent.com/ant-design/x/main/packages/x-sdk/src/x-conversations/store.ts)、[hook 源码](https://raw.githubusercontent.com/ant-design/x/main/packages/x-sdk/src/x-conversations/index.ts)、[消息 store 源码](https://raw.githubusercontent.com/ant-design/x/main/packages/x-sdk/src/x-chat/store.ts)

VV Code 仍需自行完成：

1. Tauri SQLite/文件/IndexedDB 的会话与消息 schema；
2. 启动时加载 `defaultConversations/defaultMessages`；
3. 新增、重命名、删除、每次流式完成后的写回；
4. 迁移、清理和附件路径生命周期。

## 5. React/Tauri、设计系统与包体成本

- React 18 可用：三个包的 peer dependency 都是 `react/react-dom >=18`。Vite ESM 可 tree-shake；`@ant-design/x` 和 x-sdk 标记 `sideEffects: false`。[x-sdk package.json](https://raw.githubusercontent.com/ant-design/x/main/packages/x-sdk/package.json)
- 关键成本是 `@ant-design/x 2.9.0` 要求 `antd ^6.1.1`，并直接依赖 Ant 的 CSS-in-JS/token/icon 栈、`react-syntax-highlighter` 与 `mermaid`。`XProvider` 本身扩展 antd `ConfigProvider`。[x package.json](https://raw.githubusercontent.com/ant-design/x/main/packages/x/package.json)、[XProvider 文档](https://x.ant.design/components/x-provider/)
- 当前 VV Code `package.json` 没有 antd，已有 Tailwind、Radix、lucide 和自有样式。因此引入后要维护第二套 token、组件行为和图标体系；为贴合现有 UI，需要做一轮主题映射。建议即使采用也只在对话页局部包 `XProvider`，避免把根布局整体迁到 Ant。
- 2026-08-01 的 npm tarball 安装体积（不是最终浏览器 gzip 包体）：`@ant-design/x` 4.85 MB / 解包 19.84 MB，`antd` 10.26 MB / 解包 48.95 MB，`@ant-design/x-markdown` 1.92 MB / 解包 5.92 MB，`@ant-design/x-sdk` 0.75 MB / 解包 3.30 MB。ESM tree-shaking 会降低最终产物，但 Mermaid、代码高亮、CSS-in-JS 与 antd 的首次引入仍会形成显著新 chunk；应将聊天页路由懒加载并以实际 Vite bundle report 验证。
- Tauri 本身不是阻碍，WebView 可运行这些 React 组件。`XRequest` 默认走浏览器 fetch，所以远程 New API 必须允许 CORS；否则需用其 `custom fetch` 接 Tauri/Rust 代理。当前项目 CSP 已允许 `https:`/`http:` connect，但 API key 应继续从可信本地层注入，避免写入持久化前端状态。

## 最终定位

评分（针对本项目）：

| 维度 | 评价 |
| --- | --- |
| 左侧历史 + 右侧对话 UI | 强 |
| 文本/Markdown/代码流 | 强 |
| 附件选择与展示 | 强；上传与模型消息映射缺失 |
| OpenAI 纯文本兼容 | 强 |
| tool/reasoning/多模态的统一字段抽象 | 弱到中 |
| 重启后历史持久化 | 无，需自建 |
| 与现有 Tailwind/Radix 设计体系契合 | 较弱 |

**建议：不要把 Ant Design X 作为“零适配运行时”来选；只有在团队愿意接受 antd 6 成为第二套设计系统，并把首版限定为文本/Markdown（附件先只做 UI）时采用。** 若核心目标是统一 message parts、tool/reasoning/multimodal 并尽量不维护模型字段，应该把协议运行时交给更强的通用 AI SDK，再决定是否仅复用 Ant Design X 的 Conversations/Bubble/Sender 外观层。
