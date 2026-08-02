# VV Code 品牌与发行配置

品牌信息集中在 `src/product/config.ts`。应用 Logo 取自 <https://vvcode.top/logo.png>，经过圆角透明处理的完整字标位于 `src/product/assets/logo.png`。当前采用暂定品牌 **VV Code**，后续确定正式名称时应只修改集中配置、Logo 与打包元数据，不要在业务组件中散落字符串。

## Logo 文件约定

- `src/product/assets/logo.png` 是官网完整 “VV CODE” 字标，供应用内较大尺寸的品牌位使用。
- `src/product/assets/app-icon.png` 从同一官网 Logo 裁出双 V，并放在官网黑色底上；它用于 favicon、关于页和系统应用图标。完整字标缩到 16–32 px 会失去可读性，因此必须保留这个小尺寸版本。
- `src-tauri/icons/` 中的 `.icns`、`.ico` 和不同尺寸 PNG 是 macOS、Windows、Linux 及移动平台要求的生成产物，不是多套 Logo 设计。修改 `app-icon.png` 后运行 `pnpm icons:generate` 统一重建。
- `src-tauri/icons/tray/macos/vv-code-template.svg` 是 macOS 菜单栏要求的单色模板图标。托盘尺寸无法清楚呈现完整的 “VV CODE” 字标，因此只保留官网 Logo 上方的双 V 符号。

不要手工逐个修改 `src-tauri/icons/` 下的派生图片，否则不同平台很容易出现图标不一致。

## 编译参数

生产构建通过 `.env.production`、本地 `pnpm dev` 通过 `.env.development` 固定使用真实服务域名；如需临时指向测试环境，可在启动或构建环境覆盖：

```bash
VITE_NEWAPI_BASE_URL=https://vvcode.top
```

该地址既是 VV Code 官网，也是当前生产 NewAPI 服务地址。它属于单一供应商的编译期配置，不在生产 UI 中开放编辑，避免用户把客户端切换到任意中转站。

## 本地界面验收

使用 `vite build --mode qa` 可在未连接中转站时显示“进入开发界面预览”。预览数据均为仓库内的假数据，配置按钮不会写入本机 AI 工具配置。普通 `vite build` 的生产包不包含这一入口。

## 当前发行保护

- 应用名：`VV Code`
- 官方网站：<https://vvcode.top/>
- Bundle Identifier：`com.vvcode.desktop`
- OAuth 回调：`http://127.0.0.1:{动态端口}/oauth/newapi`（仅本地回环）
- 安装包不再注册 OAuth 自定义 URL 协议。
- CC Switch 官方更新源已移除，`createUpdaterArtifacts` 暂时关闭。

正式发布前还需配置自有代码签名、安装包图标、更新签名公钥和自有更新地址。不得恢复上游 CC Switch 的更新公钥或下载地址，否则二开版本可能被上游包覆盖。
