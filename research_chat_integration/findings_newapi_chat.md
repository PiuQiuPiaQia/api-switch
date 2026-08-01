# New API 对话页、鉴权与桌面嵌入研究

研究时间：2026-08-01（Asia/Shanghai）  
上游：`QuantumNous/new-api`，检查的 `main` 提交为 [`0ab02020603d22e5613bc4cf46bfab06f8567769`](https://github.com/QuantumNous/new-api/commit/0ab02020603d22e5613bc4cf46bfab06f8567769)。以下结论来自该提交的源代码、仓库内鉴权文档，以及 `vvcode.top` 的公开状态接口/响应头；没有把旧版文档仓库或第三方文章当作依据。

## 结论摘要

1. **VV Code 若要嵌入站内现成的“对话”能力，当前真正对应的是 `/playground/`，不是 `/chat2link`。** `/playground/` 是 New API 自带 React 对话界面；`/chat/:chatId` 只是把管理员配置的第三方聊天网址放进 iframe，`/chat2link` 则跳转到第一个 Web 类型的聊天预设。
2. **内置 Playground 使用“网站登录会话”，不使用用户的 `sk-` API Key。** 浏览器以短期 Bearer JWT 调 `/pg/chat/completions`；后端要求 `UserAuth`，并明确拒绝 PAT（代码里的 `use_access_token`）。因此 VV Code Rust 进程现有的管理 Access Token/PAT 不能直接让该页面登录，也不能直接调用 Playground 专用端点。
3. **当前登录不能可靠复用到跨站 iframe。** Refresh Token Cookie 是 `HttpOnly; SameSite=Strict`；Access JWT 只放内存、15 分钟有效。以 Tauri 本地页面为顶层站点时，`vvcode.top` iframe 无法依赖这个 Strict Cookie 冷启动/续期。
4. **上游本身没有设置 `X-Frame-Options` 或 CSP `frame-ancestors`。** 这表示源码默认未主动禁止外层 iframe，但反代/CDN仍可加头；而且“能显示”不等于“能登录”。`SESSION_COOKIE_TRUSTED_URL` 也不是 iframe/CORS 白名单。
5. **最小且安全的方案是“远程子 WebView（作为顶层浏览上下文）+ 一次性 SSO ticket”。** 服务端复用已有 `auth_flows` 单次消费机制，给 Rust 进程签发 30–60 秒、一次性、绑定用户/用途/返回路径的 ticket；远程 WebView 交换 ticket 后建立普通 New API 登录 Session。若产品必须使用 HTML `<iframe>`，还需要专门的无 Cookie embed 会话/续期协议，不能只把 Cookie 改为 `SameSite=None`。

## 路由与前端实现

| 用途 | 当前公开路径 | 实现 | 鉴权/凭据 |
| --- | --- | --- | --- |
| New API 自带对话页 | `/playground/` | TanStack Router 文件路由导入 `@/features/playground` 的 `Playground`；内部由 `PlaygroundChat`、`PlaygroundInput` 和自定义 hooks 组成 | 网站登录会话的内存 Access JWT |
| 管理员配置的外部聊天客户端 | `/chat/:chatId` | `ChatRouteComponent` 解析 `Chats` 预设，必要时读取用户首个启用的 `sk-` Key，再用 iframe 显示外部 URL | 外层页面先用网站 Session；第三方聊天客户端通常收到 `sk-` Key |
| 兼容跳转入口 | `/chat2link` | 取第一个 Web 预设、读取 `sk-` Key、替换 URL 模板后执行 `window.location.href` | 同上，但跳走而非内嵌 |

### 内置 Playground

- [`web/src/routes/_authenticated/playground/index.tsx`](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/web/src/routes/_authenticated/playground/index.tsx#L19-L40) 注册 `/_authenticated/playground/`，公开路径为 `/playground/`，并在侧栏模块 `chat.playground` 关闭时跳回 dashboard。
- [`web/src/features/playground/index.tsx`](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/web/src/features/playground/index.tsx#L19-L119) 是主要组件。它不是可单独安装的官方 SDK/package，而是 `newapi-web` 内部 React feature；上游前端包名和依赖可见 [`web/package.json`](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/web/package.json#L1-L79)（React 19、TanStack Router/Query、`sse.js` 等）。
- [`constants.ts`](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/web/src/features/playground/constants.ts#L35-L73) 将推理端点固定为 `/pg/chat/completions`，模型/分组来自 `/api/user/models` 与 `/api/user/self/groups`。
- 流式请求通过 `sse.js` 发 POST，并在创建 SSE 前调用 `getFreshAuthHeaders()` 取得 `Authorization: Bearer <session access JWT>`，见 [`use-stream-request.ts`](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/web/src/features/playground/hooks/use-stream-request.ts#L186-L201)。
- 对话、参数和配置仅保存在 `vvcode.top` 源下的 `localStorage`，不是服务端会话记录，见 [`storage.ts`](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/web/src/features/playground/lib/storage/storage.ts#L278-L393)。WebView profile/数据分区变化会影响历史是否保留。

### `/chat/:chatId` 并非内置对话 UI

- [`web/src/routes/_authenticated/chat/$chatId.tsx`](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/web/src/routes/_authenticated/chat/%24chatId.tsx#L33-L74) 按数组下标取一个管理员配置的聊天预设；最终只渲染一个 `<iframe src={iframeSrc} allow="camera; microphone">`，且没有 `sandbox`，见[同文件 L156-L164](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/web/src/routes/_authenticated/chat/%24chatId.tsx#L156-L164)。
- 当 URL 模板含 `{key}` 或若干客户端配置占位符时，页面会读取用户首个启用 Token 的明文 Key，并把 `sk-...` 替换进 URL/编码配置，见 [`use-active-chat-key.ts`](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/web/src/features/chat/hooks/use-active-chat-key.ts#L25-L57) 和 [`chat-links.ts`](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/web/src/features/chat/lib/chat-links.ts#L87-L94)。这会把长期 API Key 交给目标聊天客户端；不应把该模式误认为 Cookie SSO。
- [`chat2link.tsx`](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/web/src/routes/_authenticated/chat2link.tsx#L29-L75) 是跳转兼容入口，不是聊天组件。

## 网站 Session、PAT 与 API Key 的边界

当前上游面板鉴权为：

- 15 分钟 Access JWT：只保存在浏览器内存，通过 Bearer Header 发送。
- 最长 30 天的随机 Refresh Token：只存在于 `HttpOnly; SameSite=Strict` Cookie，服务端仅存 HMAC 摘要并轮换。
- 冷启动通过 `POST /api/user/auth/refresh` 重新获得 AuthBundle。

这是上游的明确契约，见 [`docs/authentication.md`](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/docs/authentication.md#L1-L13) 和[浏览器接口部分](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/docs/authentication.md#L29-L71)。实际 Cookie 写入代码也固定使用 `SameSiteStrictMode`，见 [`service/auth_session.go`](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/service/auth_session.go#L292-L325)。

`/playground/` 的推理链路进一步收紧：

- [`router/relay-router.go`](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/router/relay-router.go#L62-L68) 对 `/pg/chat/completions` 安装 `UserAuth()`，而普通 `/v1/*` 使用 `TokenAuth()`。
- [`controller/playground.go`](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/controller/playground.go#L15-L55) 明确拒绝 PAT（`use_access_token == true`），只接受真实 dashboard 登录 Session；通过后才在服务端临时构造 `playground-<group>` Token 进入计费/路由链路。
- 所以 VV Code 现有 Rust 持有的长期管理 Access Token 即使安全地加进请求头，也不是内置 Playground 接受的浏览器会话 JWT。把它放进 iframe URL、DOM、localStorage 或 renderer 都不是可接受的修补方式。

## iframe 与响应头

上游静态页面路由 [`router/web-router.go`](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/router/web-router.go#L22-L37) 只设置缓存相关头并返回 SPA index；整个仓库没有 `X-Frame-Options` 或 CSP `frame-ancestors` 的设置。结论是：

- 上游源码默认没有主动禁止别人框住 New API 页面。
- 实际站点的 Nginx/OpenResty、CDN/WAF仍可能加头，必须以部署响应为准。
- 2026-08-01 实测 `https://vvcode.top/playground/`、`/chat/0`、`/chat2link` 的 HTML 响应均未包含 `X-Frame-Options` 或 `Content-Security-Policy`，只看到 HSTS/缓存等头；这说明**当前站点显示层面可尝试 frame，但不解决登录**。
- `SESSION_COOKIE_TRUSTED_URL` 只允许指定 Origin 调 refresh/logout，官方文档明确说它不是 relay CORS 白名单，当然也不是 `frame-ancestors`，见 [`docs/authentication.md` L91-L123](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/docs/authentication.md#L91-L123)。

### 为什么现有网站登录不能直接复用

在 Tauri 本地页面的 HTML `<iframe src="https://vvcode.top/playground/">` 中，顶层 site 与 `vvcode.top` 不同。`SameSite=Strict` Refresh Cookie 不会作为这种第三方上下文的可靠身份基础；浏览器/WebView的第三方 Cookie 限制还会进一步造成差异。页面 Access JWT 又只在该 frame 的 JS 内存中，冷启动没有它，15 分钟后也需要 Refresh Cookie 续期。因此单纯放开 frame 头、在 Tauri CSP 增加 `frame-src`、或配置 `SESSION_COOKIE_TRUSTED_URL` 都不能完成免登录。

## `vvcode.top` 当前配置快照

公开 [`/api/status`](https://vvcode.top/api/status) 在 2026-08-01 返回：

- `SidebarModulesAdmin.chat.playground = true`
- `SidebarModulesAdmin.chat.chat = false`
- `chats` 只有 `Cherry Studio` 与 `CC Switch` 两个自定义协议项，没有 Web URL 预设
- `server_address = https://vvcode.top`

因此 VV Code 当前应把 `https://vvcode.top/playground/` 当作“网站自带对话页”候选；`/chat/:chatId` 在此配置下没有可嵌入的 Web Chat 预设。公开 bundle 也包含 `/_authenticated/playground/` 和 `/chat/$chatId`，与上述上游提交一致。

## 最小安全集成建议

### 推荐：远程子 WebView + 一次性 SSO ticket

把 `https://vvcode.top/playground/` 放入一个独立的远程 WebView/子 WebView，使它对 Cookie 而言是自己的顶层浏览上下文，而不是 Tauri HTML 页面中的跨站 iframe。服务器增加两个很小的接口：

1. `POST /api/oauth/desktop/sso-ticket`
   - 仅由 Rust 进程调用，校验现有桌面 OAuth 凭据；最好校验专用 client/audience/scope，**不要让任意通用 PAT 都能升级为浏览器 Session**。
   - 创建 `purpose=desktop_sso` 的随机 ticket，TTL 30–60 秒，绑定 `user_id`、桌面 client、一次性 nonce/PKCE challenge，以及允许列表内的 `return_to=/playground/`。
   - 数据库只存 ticket 的 HMAC，限流并写审计日志。
2. `POST /api/oauth/desktop/sso-exchange`
   - 远程 WebView 从 URL fragment 或受控启动页取得 ticket，再以 POST 交换；服务端原子消费 ticket、调用已有 `CreateLoginSession(..., "desktop_sso", ...)`、写正常的 Strict/HttpOnly Refresh Cookie，并返回现有 AuthBundle。
   - 成功后立即 `history.replaceState` 清除 fragment，再进入 `/playground/`；设置 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`。

这不是从零造基础设施：上游 [`model/auth_flow.go`](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/model/auth_flow.go#L37-L50) 已提供“仅存 HMAC、过期、绑定用户/Session/用途”的 AuthFlow，并有[原子单次消费](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/model/auth_flow.go#L181-L229)；登录 Session 的统一签发出口在 [`service/auth_session.go`](https://github.com/QuantumNous/new-api/blob/0ab02020603d22e5613bc4cf46bfab06f8567769/service/auth_session.go#L45-L111)。主要新增量是一个 purpose、两个受限 controller/route 和一个很小的前端 bootstrap 页面。

安全要求：ticket 绝不能放在查询参数后继续跳转到第三方；不记录 ticket；单次消费；短 TTL；只允许固定 `return_to`；Rust 长期 Token 永不进入 renderer/WebView；登录 Session 仍受现有设备数、撤销和 `auth_version` 控制。

### 如果产品必须使用 HTML iframe

需要比上面多一层专用 embed 设计：

1. 为 `/embed/playground` 单独返回 CSP `frame-ancestors`，只允许实际测得的 VV Code/Tauri Origin（按平台列举），不要对整个站点使用 `*`；同时在 Tauri 端把 `frame-src` 限定为 `https://vvcode.top`。
2. ticket exchange 返回**短期、只在 iframe 内存中的 embed Bearer JWT**，前端用它调用 `/pg/*`；到期时由父应用通过严格校验 `origin/source/nonce` 的握手向 Rust 请求新的单次 ticket。长期桌面 Token 永不发送给 frame。
3. 对 embed route 隐藏无关导航/外链，限制 popup/download/camera/microphone；外层 iframe 使用最小 `sandbox`/`allow` 权限。

不建议的“最小改动”是把全站 Refresh Cookie 改成 `SameSite=None; Secure`：它扩大了第三方 Cookie/CSRF/点击劫持面，仍可能被 WebKit/Chromium的第三方 Cookie策略阻断，也没有做到对 VV Code 单独授权。若仅为了交付，优先使用顶层远程子 WebView；如果无法使用远程子 WebView，则本地实现聊天 UI、用 Rust 保管的分组 `sk-` Key 调标准 `/v1/chat/completions`，通常比改造整个面板的跨站 Session 更小、更稳。

