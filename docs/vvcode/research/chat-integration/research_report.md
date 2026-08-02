# VV Code 对话页集成结论

## 决策

正式版采用本地 React 对话组件，推荐 `@assistant-ui/react` + `useLocalRuntime`，通过薄适配层调用 New API 标准 `/v1/chat/completions` 流式接口。不要直接把 `https://vvcode.top/playground/` 作为主窗口 iframe。

iframe 当前虽然没有被目标站点的 `X-Frame-Options` 或 `frame-ancestors` 拦截，但它不是免登录的即插即用方案，而且会改变桌面端现有的可信 renderer 安全边界。

## 关键依据

| 维度          | 本地聊天组件                                            | 网站 iframe                                                                     |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 登录复用      | 直接使用 bootstrap 已提供的分组推理 Key                 | 网站需要独立 dashboard Session；桌面 OAuth PAT 不能登录 Playground              |
| 流式接口      | 标准 `/v1/chat/completions`，线上已允许跨域 Bearer 请求 | `/pg/chat/completions` 需要短期 Session JWT，后端明确拒绝 PAT                   |
| Cookie        | 不依赖 Cookie                                           | Refresh Cookie 为 `HttpOnly; SameSite=Strict`，跨站 iframe 不能可靠冷启动或续期 |
| UI 一致性     | 可完全贴合当前 VV Code 左侧工作台                       | 会嵌入网站顶部栏、侧栏和网站主题，除非另做 embed 模式                           |
| 安全边界      | 只加载本地打包代码和远程数据，符合现有模型              | 在高权限 Tauri 主 WebView 中引入远程可执行内容，需要重新审计 IPC/capabilities   |
| 离线/故障表现 | 可由桌面端控制重试、错误和降级                          | 受网站发布、登录、Cookie、CSP 和 WebView 平台差异共同影响                       |
| 初期代码量    | 中等，需要 SSE 适配和 UI 接线                           | 表面很小，但生产可用还需要 SSO、Cookie/嵌入策略和安全隔离                       |

## 路由纠正

- 网站真正的内置对话页是 `/playground/`。
- `/chat/:chatId` 的 `chatId` 是管理员配置的外部聊天预设数组下标，不是会话 ID。
- `vvcode.top/api/status` 当前启用了 `playground`、关闭了 `chat`，外部预设只有 Cherry Studio 和 CC Switch 自定义协议，因此 `/chat/:chatId` 不是可复用的站内聊天页。

## 推荐组件

首选 `@assistant-ui/react`：MIT、支持 React 18/19，LocalRuntime 不强制 Next.js、Vercel 后端或 Assistant Cloud，且与仓库现有 Tailwind/Radix/shadcn 风格最接近。

首版只引入：

1. Thread、Message、Composer 和 LocalRuntime。
2. Markdown 与代码复制；代码高亮按语言懒加载。
3. 分组和模型选择、流式输出、停止、重试、清空。
4. 以用户 ID 隔离的本地对话状态。

附件、工具调用、服务端会话同步放到第二阶段。首版不叠加 `@assistant-ui/react-ai-sdk`，避免为了当前原生 OpenAI SSE 再引入一套 UI Message Stream 协议。

## 最小实现路径

1. 在 `VvCodeApp` 的 `ActivePage` 和“工作台”导航中增加 `chat`。
2. 新建 `ChatPage`，复用 `bootstrap.groups`、默认分组与 `ensureGroupTokens`。
3. 使用分组 `baseUrl` + `apiKey` 请求标准 Chat Completions；Key 不写 URL、日志或对话持久化。
4. 自定义 `ChatModelAdapter.run` 解析 OpenAI SSE，支持 `AbortController`，按 assistant-ui 要求 yield 累计消息状态。
5. 对 content、reasoning、错误、`[DONE]`、中止和半截流建立 fixture 测试。
6. 保持 Tauri CSP 不增加 `frame-src`，也不加载任何远程脚本。

## 若仍要复用网站页面

不要直接使用主窗口 iframe。相对可控的方案是独立、零 Tauri capability 的远程子 WebView，加服务端 30–60 秒一次性 SSO ticket：Rust 用现有桌面凭据申请 ticket，远程 WebView 原子兑换后创建普通网站 Session，再进入 `/playground/`。长期 PAT 不进入 URL、renderer 或远程页面。

若强制使用 HTML iframe，还需单独实现 `/embed/playground`、精确 `frame-ancestors`、短期内存 embed JWT 与父子窗口续期握手；这已经比本地聊天组件更复杂，不适合作为当前首选。

## 资料

- `findings_site_embed.md`：线上响应头、CSP、登录复用和 Tauri 安全边界。
- `findings_newapi_chat.md`：New API 路由、Session/PAT/API Key 边界与 SSO 备选。
- `findings_chat_sdks.md`：assistant-ui、Vercel AI SDK UI、Ant Design X、Chatscope 对比。
