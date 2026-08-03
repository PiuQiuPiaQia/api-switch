# 品牌配置与发行

`src/vvcode/brand.config.json` 是二开发行的品牌唯一事实源。前端运行时、Rust 编译、站点登录、更新源、默认数据目录以及 package/Tauri/Cargo 发行元数据都由该文件派生。不要在组件、locale、Rust 命令或构建脚本中重新写一份品牌值。

## 换牌流程

1. 修改 `src/vvcode/brand.config.json`。字段说明见同目录的 `brand.config.schema.json`。
2. 替换 `src/vvcode/assets/logo.png` 与 `src/vvcode/assets/app-icon.png`。
3. 运行：

   ```bash
   pnpm brand:sync
   pnpm icons:generate
   pnpm architecture:check
   pnpm typecheck
   pnpm test:unit
   cargo test --manifest-path src-tauri/Cargo.toml --lib 'vvcode::'
   ```

4. 检查并更新面向人的发行材料，例如 `README.md`、`README_ZH.md`、`NOTICE`、`SECURITY.md`、应用商店/Flatpak 描述和 GitHub Release 文案。这些内容包含法律声明或完整叙述，不由同步脚本机械改写。

`pnpm brand:sync` 当前同步以下必须静态存在的文件：

- `package.json`：包名、描述、作者、主页、仓库和问题地址。
- `src-tauri/tauri.conf.json`：产品名、窗口标题、Bundle Identifier 和短描述。
- `src-tauri/tauri.windows.conf.json`：Windows 窗口标题。
- `src-tauri/Cargo.toml`：crate 包名、描述、作者、主页和仓库；包名变化时同时更新 `src-tauri/Cargo.lock` 中的应用包记录。

CI 和提交前使用 `pnpm brand:check` 检查这些派生文件是否与配置一致。不要直接修改派生字段；直接修改会在架构校验中失败。

## 字段边界

### 日常换牌字段

- `brand.*`：展示名、标语、产品描述和官网。
- `service.defaultBaseUrl`：正式 NewAPI 服务地址。`VITE_NEWAPI_BASE_URL` 仅用于临时联调覆盖，正式发行应修改配置文件。
- `repository.*`：源码、问题、Release 和 GitHub Releases API 地址。
- `distribution.publisherName`、`logFileName`、`syncRoot`、`themeStorageKey`、`userAgent`：发行与运行时标识。

### 修改前必须设计迁移的字段

- `distribution.configDirName`：决定默认用户数据目录。修改后应用会看到一个新的空目录；同步脚本不会擅自移动用户数据。
- `distribution.databaseFileName`：决定主数据库文件名。已发布后修改会让旧数据库不可见。
- `distribution.packageName`：影响可执行文件、包管理元数据和前端 LocalStorage 命名空间。
- `distribution.bundleIdentifier`：操作系统会把新值视为另一个应用，也会影响权限、自动启动和签名身份。
- `compatibility.managedProviderId`：用于识别已写入各工具配置的托管供应商。纯展示换牌必须保留；只有提供旧 ID 兼容读取、迁移和回滚时才能修改。

`src/vvcode`、`src-tauri/src/vvcode`、`VvCodeApp`、`vvcode_*` IPC 命令和事件名是内部代码兼容标识，不属于展示品牌。保留这些名字可以减少与上游同步时的无意义改名和持久化协议断裂。

## 多语言文案

语言包不再保存当前品牌字面量，而使用下列插值：

- `{{brandName}}`
- `{{packageName}}`
- `{{configDirName}}`
- `{{databaseFileName}}`
- `{{logFileName}}`
- `{{syncRoot}}`
- `{{upstreamName}}`

品牌插值在前端组合根启动时由 `src/vvcode/branding.ts` 注入。新增产品文案时应继续使用这些变量；业务特有的工具名或协议名不应当被品牌插值替换。

上游共享前端若确实需要产品级默认值，只能读取中性扩展点 `src/config/productRuntime.ts`；该模块由 Vite 构建层注入，不得在共享组件中反向导入 `src/vvcode`。Rust 共享模块同理，只能读取 `build.rs` 注入的 `PRODUCT_*` 编译值。

## Logo 文件约定

- `src/vvcode/assets/logo.png`：应用内较大尺寸的完整字标。
- `src/vvcode/assets/app-icon.png`：favicon、关于页和系统应用图标的方形小尺寸版本。
- `src-tauri/icons/`：由 `app-icon.png` 生成的 macOS、Windows 和 Linux 派生资源。不要逐个手改。
- `src-tauri/icons/tray/macos/vv-code-template.svg`：macOS 单色菜单栏模板。文件名是内部兼容名，图形本身需要随新品牌人工调整。

## 构建与更新安全

正式发布必须使用新品牌自己的代码签名、Tauri 更新签名密钥和 Release 仓库。不得复用上游 CC Switch 或另一个品牌的私钥、公钥、Bundle Identifier 和更新地址。

本地 Beta 构建：

```bash
pnpm package:beta
```

macOS Beta 使用 ad-hoc 签名且未公证，Windows Beta 可能没有代码签名；接收者会看到系统安全提示。正式版本使用 `Production Release` 工作流，仅响应非 Beta 的 `v*` 标签。
