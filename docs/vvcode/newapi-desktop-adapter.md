# NewAPI 桌面端适配契约

本文是 VV Code 桌面端与单一 NewAPI 中转站之间的实现契约。当前桌面端已实现 OAuth 2.0 + PKCE、会话持久化、分组目录和分组专属 Key 初始化。

## 1. 总体流程

1. 桌面端生成随机 `state`、`code_verifier` 和 S256 `code_challenge`。
2. 桌面端仅在 IPv4 回环地址上绑定一个由操作系统分配的临时端口，例如 `127.0.0.1:49152`，然后打开系统浏览器：

   ```text
   GET {NEWAPI_BASE_URL}/api/oauth/vscode
     ?state=...
     &code_challenge=...
     &code_challenge_method=S256
     &redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Foauth%2Fnewapi
   ```

3. 用户在浏览器登录并授权，中转站跳转到本机临时监听地址：

   ```text
   http://127.0.0.1:49152/oauth/newapi?code=ONE_TIME_CODE&state=ORIGINAL_STATE
   ```

4. 桌面端在 Rust 进程中交换令牌：

   ```http
   POST /api/oauth/vscode/token
   Content-Type: application/x-www-form-urlencoded

   code=...&code_verifier=...&state=...&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Foauth%2Fnewapi
   ```

5. 进入具体 AI 工具时，桌面端优先通过 `GET /api/desktop/groups?app=<application-id>` 读取该应用的可用分组；接口尚未部署或应用未配置时，回退到 `GET /api/user/self/groups`。
6. 用户选择 AI 场景和分组后，可按需从该分组的 `/models` 接口获取候选模型，再把连接信息与用户明确填写的模型配置写入本机。

管理访问令牌与推理 Key 是两类凭据：OAuth `access_token` 只调用管理接口；每个分组的 `apiKey` 才写入 Claude Code、Codex、Gemini CLI 或 OpenCode。

## 2. OAuth 必须满足的约束

- 必须使用 PKCE S256，不接受 `plain`。
- 授权端点只允许 `http://127.0.0.1:{动态端口}/oauth/newapi` 形式的回调；必须精确校验协议、IPv4 地址与路径，只允许端口动态变化。
- 令牌端点收到的 `redirect_uri` 必须与签发授权码时记录的完整地址（包括端口）完全一致。
- `state` 必须原样绑定到授权请求并在交换时校验。
- 授权码必须一次性使用，建议 5 分钟过期。
- 登录用户被禁用后，授权与管理 API 都返回 401/403。
- 生产环境只允许 HTTPS 服务地址；localhost 开发环境可例外。
- 不得把 access token、授权码、分组 Key 写入服务端普通日志或错误信息。
- 对授权开始、令牌交换和 Key 初始化做用户/IP 维度限流。

当前客户端兼容 `vv-code-api` 的令牌响应：

```json
{
  "access_token": "management-token",
  "token_type": "Bearer",
  "expires_in": -1,
  "user_id": 123,
  "username": "alice",
  "display_name": "Alice",
  "role": 1
}
```

客户端将 access token 保存在应用配置目录的 `newapi-session.json` 中；Unix 平台权限会收紧为 `0600`。令牌不会返回给 React 页面。

## 3. 应用分组接口

### `GET /api/desktop/groups?app=<application-id>`

请求头：

```http
Authorization: Bearer <management-access-token>
New-Api-User: <user-id>
Accept: application/json
```

`app` 必须使用服务端配置的稳定应用标识。当前桌面端发送：

| 场景           | `app`            |
| -------------- | ---------------- |
| Claude Code    | `claude-code`    |
| Claude Desktop | `claude-desktop` |
| Codex          | `codex`          |
| Gemini CLI     | `gemini-cli`     |
| OpenClaw       | `openclaw`       |
| Hermes         | `hermes`         |

标准成功响应：

```json
{
  "success": true,
  "data": {
    "daily": {
      "desc": "均衡速度与成本",
      "ratio": 1
    },
    "coding": {
      "desc": "编程任务",
      "ratio": 1.5
    }
  }
}
```

对象键作为稳定的分组标识，`desc` 和 `ratio` 用于界面展示。服务端返回结果应当是“应用配置允许的分组”与“当前用户可用分组”的交集。客户端也兼容数组形式以及可选的 `name`、`baseUrl`、`apiProvider`、`ccProvider`、`isDefault` 和 `connections` 字段。初次拉取分组时不读取或创建任何 Token；用户选中分组后才按需准备该分组的独立 Key。

当应用分组接口返回 `404` 或 `501` 时，客户端使用相同鉴权头请求通用接口 `GET /api/user/self/groups`。`401`、`403`、`429` 和其他服务端错误不会触发回退，避免绕过鉴权、权限和限流结果。应用已配置为空列表时应返回成功的空 `data`，客户端不会回退。

## 4. 分组 Key 初始化

桌面端直接复用 NewAPI 标准 Token 接口，无需新增服务端路由：

```http
GET /api/token/search?keyword=desktop-<selected-group-id>&p=1&size=100
POST /api/token/
POST /api/token/batch/keys
Authorization: Bearer <management-access-token>
New-Api-User: <user-id>
```

要求：

- 操作必须幂等；已有分组 Key 不重新生成。
- 桌面端先精确查找同名 Token，只为当前选中分组创建缺失的 Key。
- 客户端创建的 Token 名称使用 `desktop-<group_id>`，例如 `desktop-daily`。
- 创建请求的 `group` 使用网站返回的原始分组标识；Token 永不过期且使用无限额度。
- 查询时优先匹配 `desktop-` 名称，并兼容名称等于分组标识的旧 Token。
- 只创建当前用户可使用分组的 Key。
- Key 应绑定具体分组，不能借此访问其他分组。
- 禁止在响应或审计日志之外长期展示完整 Key；桌面端只在写配置时使用并在 UI 脱敏。
- 创建后通过标准 Key 查询接口读取完整 Key，并立即刷新本地 `bootstrap`。

## 5. 请求边界

登录后或用户手动同步时，通过 `GET /api/user/self/groups` 获取通用分组。进入 AI 工具时改用 `GET /api/desktop/groups?app=<application-id>`，并按上述规则回退。模型仅在进入聊天并选择分组时通过 `GET /api/user/models?group=<group_id>` 按需读取。Token 搜索、创建和完整 Key 读取也只在用户实际选择某个分组后发生；完成 Key 初始化后继续按当前应用重新拉取分组。

## 6. 场景配置语义

桌面端底层保留多类配置兼容；当前 VV Code 产品界面展示 Claude Code、Claude Desktop、Codex（桌面端 / CLI）、Gemini CLI、OpenClaw（龙虾）和 Hermes，OpenCode 入口暂不展示：

| 场景               | Base URL 写入位置                                                               | 分组 Key 写入位置                       | 可选模型配置                                       |
| ------------------ | ------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------- |
| Claude Code        | `~/.claude/settings.json` → `env.ANTHROPIC_BASE_URL`                            | `ANTHROPIC_AUTH_TOKEN`                  | `DEFAULT_SONNET/OPUS/HAIKU_MODEL`                  |
| Claude Desktop     | Claude Desktop `Claude-3p` 配置库中的 VV Code profile                           | profile 的 inference gateway Key        | 客户端从接口自动读取模型                           |
| Codex 桌面端 / CLI | `~/.codex/config.toml` → `[model_providers.custom].base_url`                    | `~/.codex/auth.json` → `OPENAI_API_KEY` | `config.toml` → `model`                            |
| Gemini CLI         | `~/.gemini/.env` → `GOOGLE_GEMINI_BASE_URL`                                     | `GEMINI_API_KEY`                        | `GEMINI_MODEL`                                     |
| OpenCode           | `~/.config/opencode/opencode.json` → `provider.vv-code-managed.options.baseURL` | `options.apiKey`                        | `provider.vv-code-managed.models` 中的手动模型目录 |
| OpenClaw           | `~/.openclaw/openclaw.json` → `models.providers.vv-code-managed.baseUrl`        | `apiKey`                                | `models`，首个模型同步为默认模型                   |
| Hermes             | `~/.hermes/config.yaml` → `custom_providers[].base_url`                         | `api_key`                               | `models`，切换时首个模型设为默认                   |

模型字段默认留空：留空时不注入模型覆盖，由对应工具沿用自身默认行为；已有配置会原样回填，用户主动清空才删除该覆盖项。Claude Desktop 使用 CC Switch 已有的直连 profile 写入能力，直接写入分组的 Anthropic 兼容地址与专属 Key，不启用本地路由；应用配置后只需重启 Claude Desktop，VV Code 无需保持运行。Claude Desktop 的模型列表由客户端从接口自动读取，其他场景的模型发现沿用 Switch 的按需逻辑，只有点击获取按钮才请求模型列表。

如果同一分组对不同协议需要不同地址，聚合接口可在 group 中返回：

```json
{
  "connections": {
    "claude": { "baseUrl": "...", "apiKey": "...", "apiFormat": "anthropic" },
    "claude-desktop": {
      "baseUrl": "...",
      "apiKey": "...",
      "apiFormat": "anthropic"
    },
    "codex": {
      "baseUrl": "...",
      "apiKey": "...",
      "apiFormat": "openai_responses"
    },
    "gemini": {
      "baseUrl": "...",
      "apiKey": "...",
      "apiFormat": "gemini_native"
    },
    "opencode": {
      "baseUrl": "...",
      "apiKey": "...",
      "apiFormat": "openai_chat"
    }
  }
}
```

客户端已支持该字段，并优先使用与当前场景同名的连接；Claude Desktop 未返回独立连接时会复用 `claude` 连接，其余场景未命中时回退到 group 顶层的 `baseUrl` / `apiKey`。因此使用顶层字段时，中转站必须保证该入口对所选场景兼容。

初始化页的 API 线路 URL 用于切换网络 origin，不会直接抹掉上述场景路径。客户端会把场景连接中的 path 迁移到所选线路：例如 Codex 的 `https://origin.example/v1` 配合线路 `https://cf.example` 会得到 `https://cf.example/v1`。如果服务端只返回纯 origin，OpenAI Chat / Responses 场景默认补 `/v1`，Anthropic / Gemini Native 场景保持纯 origin。服务端返回的自定义 path 始终优先，客户端不会把 `/api/coding` 等前缀替换成固定 `/v1`。

## 7. 标准错误

所有 JSON 错误建议统一：

```json
{
  "success": false,
  "code": "GROUP_KEY_NOT_READY",
  "message": "分组密钥尚未初始化",
  "requestId": "req_xxx"
}
```

建议状态码：

- `400` 参数或 PKCE 校验失败
- `401` access token 无效/过期
- `403` 用户被禁用或无分组权限
- `404` 接口未实现或资源不存在
- `409` 资源状态冲突
- `429` 频率限制
- `500/503` 服务端或依赖服务故障

客户端会优先展示 `message`，OAuth token 接口也兼容 `error_description`。

## 8. NewAPI 开发验收清单

- [ ] 桌面端只监听 `127.0.0.1`，由操作系统随机分配空闲端口，登录结束或超时后立即关闭监听。
- [ ] 浏览器完成登录后可以跳转到 `http://127.0.0.1:{动态端口}/oauth/newapi`，页面提示用户返回 VV Code。
- [ ] 错误/取消授权也带原始 `state` 并返回可读错误。
- [ ] 授权码重放失败，错误日志不包含 code/token/key。
- [ ] 聚合接口只返回当前用户有权使用的分组和模型。
- [ ] 每个可配置分组都有有效的 HTTPS `baseUrl` 和独立 `apiKey`。
- [ ] `defaultModelId` 一定属于该分组。
- [ ] Key 初始化幂等，重复调用不轮换已有 Key。
- [ ] 禁用用户、删除分组权限或禁用模型后，下一次 bootstrap 立即反映。
- [ ] 至少用 Claude Code、Codex、Gemini CLI、OpenCode 各完成一次真实推理请求。
- [ ] 管理访问令牌可撤销；撤销后所有管理接口返回 401。
