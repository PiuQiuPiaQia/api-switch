# `vvcode.top` 站点嵌入与登录复用调查

调查时间：2026-08-01（站点返回时间约 15:18–15:20 GMT）  
范围：只读检查线上响应、前端静态 bundle 与本仓库现有 Tauri 配置；未登录真实账号，未修改应用代码。共进行了 **5 次 HTTP 请求**，没有额外的网页搜索或网络请求。

## 结论

`vvcode.top` **目前没有通过 HTTP 响应头禁止被 iframe 嵌入**：抽查的首页和 `/chat/1` 都是 `200`，均未返回 `Content-Security-Policy`（因此也没有 `frame-ancestors`）、`X-Frame-Options`、`Set-Cookie` 或 `Location`。因此，从目标站点的防嵌入响应头这一项看，标准 iframe 暂时可行。

但它**不是当前桌面应用中可直接免登录工作的嵌入页**，原因有三层：

1. 站点内置聊天路由属于 `_authenticated` 路由树；无站点浏览器会话时，前端会客户端跳转到 `/sign-in?redirect=...`。
2. 站点前端依赖其自身浏览器状态：`localStorage.user`、`localStorage.uid`、带凭据的同源 API 请求，以及服务器认可的 Cookie/访问令牌。当前桌面端 OAuth+PKCE 得到的 access token 只在 Rust 中使用，没有写入 WebView 的 Cookie/localStorage，也没有交给远端页面。
3. 本应用当前 CSP 没有 `frame-src`，其 `default-src 'self'` 会阻止 `https://vvcode.top` iframe；而单独加载远端页面还会推翻仓库当前“renderer 只运行打包内容”的安全边界。

所以，**“加一个 iframe 指向聊天页”在响应头层面不会被目标站点立即拒绝，但在现有应用中会先被本地 CSP 拦截，即使放开 CSP，也会显示登录页而不是复用桌面 OAuth 登录**。若要做站点复用，至少需要专门的 Web 会话桥接；在此之前不应把它视为即插即用方案。

## 可能的聊天相关路由

路由来自当前首页引用的主 bundle [`https://vvcode.top/static/js/index.2d6e119a3b.js`](https://vvcode.top/static/js/index.2d6e119a3b.js)（SHA-256：`56dc76d817eca1d9e8408d48b16d4783175ae7e29caeecaac58713901ecb7c09`）。

| 路由 | 判断 | 匿名行为/限制 |
|---|---|---|
| [`/playground/`](https://vvcode.top/playground/) | 最像“新建一次对话/提示词实验”的固定入口；路由组件名与 UI 文案均为 Playground | 位于 `/_authenticated/playground/`；还受 `chat.playground` 功能开关控制，关闭时转 `/dashboard` |
| [`/chat/{chatId}`](https://vvcode.top/chat/1) | 已存在会话的聊天详情页，例如 `/chat/1` | 位于 `/_authenticated/chat/$chatId`；`chatId` 必须能转为整数，否则转 `/dashboard`；没有发现无 ID 的 `/chat` 路由 |
| [`/chat2link`](https://vvcode.top/chat2link) | 已认证的“准备 Web chat 链接/跳转”辅助页，不应当当作稳定的聊天 UI 入口 | 位于 `_authenticated`；bundle 文案包含 “Preparing your chat link…”/“Redirecting to chat page…”；更像向管理员配置的外部聊天客户端跳转 |
| [`/sign-in`](https://vvcode.top/sign-in) | 站点登录页 | `_authenticated` 父路由在缺少用户状态或 `/api/user/self` 校验失败时跳到这里，并携带原地址作为 `redirect` |

主 bundle 中的关键逻辑（压缩后的等价语义）：

```text
/_authenticated beforeLoad:
  if (!auth.user) redirect('/sign-in', { redirect: location.href })
  GET /api/user/self
  if validation fails, clear user and redirect('/sign-in', ...)

/_authenticated/chat/$chatId:
  if chatId is not an integer, redirect('/dashboard')

/_authenticated/playground/:
  if feature('chat', 'playground') is disabled, redirect('/dashboard')
```

## HTTP 响应头、重定向与匿名访问

### HTML

[`GET https://vvcode.top/`](https://vvcode.top/) 返回：

```text
HTTP/2 200
server: openresty
content-type: text/html; charset=utf-8
cache-control: no-cache
strict-transport-security: max-age=31536000
```

[`GET https://vvcode.top/chat/1`](https://vvcode.top/chat/1) 同样返回 `HTTP/2 200` 和相同的 2,365 字节 SPA shell。两个响应体 SHA-256 都是：

```text
37aa75e024db05f7cc3ac6ba76afee245442ea0c86ca035a5178b170b96b8e49
```

两次 HTML 响应均未观察到以下头：

```text
Content-Security-Policy
X-Frame-Options
Set-Cookie
Location
```

这说明 `/chat/1` 的匿名请求**不会发生服务器端 30x**；服务器返回 SPA shell，登录跳转由 JavaScript 路由守卫执行。该结论仅代表 2026-08-01 的线上配置，不能视为站点长期承诺。

### 匿名身份 API

[`GET https://vvcode.top/api/user/self`](https://vvcode.top/api/user/self) 在不带 Cookie、Bearer token 或用户头时返回：

```text
HTTP/2 401
content-type: application/json; charset=utf-8

{"message":"Unauthorized, not logged in and no access token provided","success":false}
```

该响应也没有 `Set-Cookie`。因此匿名访问只能加载页面外壳，不能通过身份校验，也不能使用已认证聊天页。

### 静态资源

主 bundle 和登录页 chunk [`https://vvcode.top/static/js/async/2692.2b4e459eac.js`](https://vvcode.top/static/js/async/2692.2b4e459eac.js) 均返回 `200`，没有 CSP、X-Frame-Options 或 Set-Cookie。登录 chunk SHA-256 为 `51ada174574af86a963cc09d1f876df9dbd6368d108cc0d89218628f46575042`。

## Cookie、SameSite 与当前 OAuth token 的关系

### 能确认的事实

当前站点 bundle 创建 API 客户端时使用：

```text
baseURL: ""
withCredentials: true
localStorage.getItem("uid") -> request header "New-Api-User"
GET /api/user/self
```

它还把用户摘要保存在 `localStorage.user`。这说明正常站点登录至少依赖站点浏览器存储，并让浏览器在后续同源请求中携带凭据；仅伪造 `localStorage.user` 不够，因为父路由随后会调用 `/api/user/self` 验证。

当前桌面实现 [`src-tauri/src/commands/newapi.rs`](../src-tauri/src/commands/newapi.rs) 明确把 OAuth secret 和管理请求留在 Rust 进程。OAuth 流程在系统浏览器打开 `/api/oauth/vscode`，用 PKCE code 换取 `access_token` 和 `user_id`；Rust 发管理 API 时同时附加：

```text
Authorization: Bearer <access_token>
New-Api-User: <user_id>
```

renderer 只拿脱敏的 `NewApiSessionSummary`。因此现状没有任何步骤会把 Bearer token 交给 `vvcode.top` iframe，也没有把站点登录 Cookie 写入 Tauri WebView。

### 不能从匿名检查确认的部分

本次所有匿名响应都没有 `Set-Cookie`，所以**无法观测真实登录 Cookie 的名称、Domain、Path、HttpOnly、Secure 或 SameSite 属性**。要判断 iframe 中 Cookie 是否可发送，必须用测试账号完成一次站点 Web 登录并检查成功响应/回调的 `Set-Cookie`。

对于嵌在 Tauri 本地 origin 中的 iframe，`vvcode.top` 是第三方上下文：

- 若会话 Cookie 是 `SameSite=Lax` 或 `Strict`，通常不会随 iframe 子资源请求发送。
- 即使是 `SameSite=None; Secure`，WKWebView/WebView2 的第三方 Cookie/跟踪防护仍可能产生平台差异。
- 系统浏览器的 Cookie 存储也不能假设会与 Tauri 的 WKWebView/WebView2 自动共享。

单独的顶层远端 WebView/窗口会让 `vvcode.top` 成为第一方上下文，避开 iframe 的 SameSite 限制，但仍不会自动获得系统浏览器或 Rust 中的现有会话。

## 对 Tauri iframe/WebView 集成的具体影响

1. **目标站点响应头：暂时允许。** 没有 `frame-ancestors` 或 `X-Frame-Options`，所以目标站点不是当前首要阻塞项。
2. **宿主 CSP：当前阻止 iframe。** [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json) 的 CSP 是 `default-src 'self'; ...`，没有 `frame-src`。`connect-src https:` 只允许数据请求，不允许远端 frame；iframe 原型至少要显式允许 `frame-src https://vvcode.top`。
3. **登录：当前不能复用。** 放开 CSP 后，匿名 iframe 会被前端路由送到站点登录页。父页面受同源策略限制，不能直接写 `vvcode.top` 的 localStorage/Cookie；把 Rust token 暴露给 renderer 或拼进 URL 也不应作为方案。
4. **分离 WebView：可解决 framing/CSP，不解决身份。** 顶层或子 WebView 加载远端 URL 不依赖目标站点的 `frame-ancestors`，但仍需独立登录或服务端会话桥接，并需明确限制远端 origin 的 Tauri capability/IPC 权限。
5. **安全边界必须重审。** 本仓库 [`SECURITY.md`](../SECURITY.md) 和 `session_manager.rs` 都把“引入 iframe/webview 或让 WebView 导航到远端 origin”列为现有可信 renderer 假设失效条件；其中 `launch_session_terminal` 还明确接受 renderer 传来的任意 shell command。任何站点嵌入方案都必须先隔离远端内容，确认其不能调用主窗口的高权限 IPC，而不只是调整 CSP。

## 若继续做站点复用，最小后端能力

较稳妥的方向不是把长期 Bearer token 暴露给远端页面，而是增加一次性 Web 会话引导，例如：

1. Rust 使用现有 Bearer token + `New-Api-User` 请求服务端换取短时、一次性 authorization code。
2. 在独立、无主窗口 Tauri capability 的顶层 WebView 中导航到 `https://vvcode.top/.../bootstrap?code=...`。
3. 服务端兑换 code 后设置 HttpOnly、Secure 的站点会话 Cookie，再 302 到 `/playground/` 或确定的 `/chat/{id}`。
4. 若坚持 iframe，还必须验证 Cookie 的 `SameSite=None; Secure` 与 macOS/Windows 实际第三方 Cookie 行为；顶层隔离 WebView通常更可靠。

在实施前，还需要用测试账号补一次认证后的抓包，以确定 Cookie 属性和真实“新建会话”入口；本次未使用任何真实凭据。

## 精确网络检查记录（总计 5 次）

1. 首页 HTML：

   ```sh
   curl --silent --show-error --dump-header - --output /tmp/vvcode_home.html --connect-timeout 15 --max-time 30 https://vvcode.top/ && wc -c /tmp/vvcode_home.html
   ```

   结果：`HTTP/2 200`；2,365 bytes；无 CSP/XFO/Set-Cookie/Location。

2. 首页引用的主 bundle：

   ```sh
   curl --silent --show-error --dump-header /tmp/vvcode_bundle.headers --output /tmp/vvcode_index.js --connect-timeout 15 --max-time 45 https://vvcode.top/static/js/index.2d6e119a3b.js && sed -n '1,40p' /tmp/vvcode_bundle.headers && wc -c /tmp/vvcode_index.js
   ```

   结果：`HTTP/2 200`；3,457,854 bytes；从本地副本提取路由、认证守卫和 API 客户端配置。

3. 聊天详情候选路由：

   ```sh
   curl --silent --show-error --dump-header - --output /tmp/vvcode_chat1.html --connect-timeout 15 --max-time 30 https://vvcode.top/chat/1 && wc -c /tmp/vvcode_chat1.html
   ```

   结果：`HTTP/2 200`；2,365 bytes；与首页响应体逐字节相同；无 CSP/XFO/Set-Cookie/Location。

4. 匿名用户校验：

   ```sh
   curl --silent --show-error --dump-header - --output /tmp/vvcode_user_self.json --connect-timeout 15 --max-time 30 https://vvcode.top/api/user/self && sed -n '1,80p' /tmp/vvcode_user_self.json
   ```

   结果：`HTTP/2 401`；响应为 `Unauthorized, not logged in and no access token provided`；无 Set-Cookie。

5. 登录页异步 chunk：

   ```sh
   curl --silent --show-error --dump-header /tmp/vvcode_signin_chunk.headers --output /tmp/vvcode_signin_chunk.js --connect-timeout 15 --max-time 30 https://vvcode.top/static/js/async/2692.2b4e459eac.js && sed -n '1,40p' /tmp/vvcode_signin_chunk.headers && wc -c /tmp/vvcode_signin_chunk.js
   ```

   结果：`HTTP/2 200`；13,612 bytes；确认当前登录页支持密码、OAuth、微信和 Passkey 等站点内登录方式，但没有发现可从 iframe URL 直接注入现有桌面 Bearer token 的机制。
