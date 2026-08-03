# VV Code 二开协作规范

## 项目定位

本仓库是基于 **CC Switch 2** 的 VV Code 站版二开。上游 CC Switch 代码仍是可持续同步的基座；VV Code 的站点登录、NewAPI 对接、托管供应商、场景工作台、聊天和发行策略属于二开能力。

“95 开”是本仓库的强制性架构目标：约 95% 的 VV Code 功能应完整放在独立目录，只允许约 5% 的通用扩展点、入口注册和打包配置留在上游路径。这不是精确行数比例，而是代码归属和依赖方向约束。

## 目录归属

VV Code 专属代码必须优先放在：

- `src/vvcode/`：前端应用、页面、组件、状态、站点 API 适配、品牌资源和同目录测试。
- `src-tauri/src/vvcode/`：NewAPI/OAuth、托管配置、VV Code Tauri 命令和发行版运行策略。
- `docs/vvcode/`：VV Code 架构、对接、品牌发行和调研资料。
- `scripts/vvcode/`：仅服务于 VV Code 的新脚本；若脚本是已有发行入口，可保留原路径，但应把主体实现下沉到该目录。

以下视为 CC Switch 上游/共享区：`src/components/`、`src/hooks/`、`src/lib/`、`src/config/`、`src-tauri/src/commands/`、`src-tauri/src/services/`、`src-tauri/src/proxy/` 及其他原有模块。新增二开业务不得直接落入这些目录。

## 依赖方向

- 允许 `vvcode -> 上游共享模块`：VV Code 可复用上游通用 UI、类型、环境检测、配置写入和供应商服务。
- 禁止 `上游共享模块 -> vvcode`：共享代码不应知道 NewAPI、VV Code 页面、托管供应商 ID 或站点协议。
- 仅组合根可以注册 VV Code：前端为 `src/main.tsx`，Rust 后端为 `src-tauri/src/lib.rs`。品牌图标等纯发行资源可有有限例外，不得借此引入业务逻辑。
- 上游需要扩展时，只增加中性、可选、可复用的 props/trait/hook，不出现 `vvcode`、`newapi`、站点 URL 或托管供应商分支。业务参数由 `src/vvcode` 适配层传入。

## 开发规则

1. 修改前先用 `git diff <upstream-base>...HEAD` 确认代码属于上游还是二开，不以文件中的品牌字样盲判归属。
2. 新功能先在 `vvcode` 目录完成垂直切片；需复用上游大组件时，在 VV Code 侧写 wrapper/adapter。
3. 不要在上游 `commands/mod.rs` 中声明 VV Code 命令；命令放在 `src-tauri/src/vvcode/` 并由 `lib.rs` 注册。
4. 不要在上游供应商、代理或数据库实现中加 VV Code 专属常量和分支；优先组合现有 service，必要时提取通用能力后由 VV Code 调用。
5. 品牌、站点 URL、托管 provider ID、场景清单和发行版开关集中在 VV Code 配置模块，不在业务组件和上游模块里散落。
6. VV Code 测试与实现同目录放置。修改共享扩展点时，同时跑上游相关测试，确保默认参数保持原行为。
7. 纯品牌替换、Tauri/Cargo/package 元数据、应用图标、更新源和打包工作流是不可避免的 5% 发行层差异；修改时应与业务代码分开提交。

## 品牌配置与派生发行

- `src/vvcode/brand.config.json` 是品牌唯一事实源。展示名、标语、官网、站点服务、仓库地址、包名、Bundle Identifier、默认数据目录、日志名、同步根目录和 User-Agent 不得在业务代码中重复声明。
- 前端 VV Code 代码通过 `src/vvcode/brand.ts` 或 `src/vvcode/config.ts` 读取品牌；Rust VV Code 代码通过 `src-tauri/src/vvcode/brand.rs` 读取。共享前端只能使用 `src/config/productRuntime.ts` 的中性构建值，共享 Rust 只能使用构建层注入的中性 `PRODUCT_*` 编译值，禁止反向导入 `vvcode`。
- i18n 文案使用 `{{brandName}}`、`{{packageName}}`、`{{configDirName}}`、`{{databaseFileName}}`、`{{logFileName}}`、`{{syncRoot}}`、`{{upstreamName}}` 插值，不要把当前品牌名或默认路径重新写进 locale JSON。
- 修改品牌配置后必须先运行 `pnpm brand:sync`，同步 `package.json`、Tauri 配置和 Cargo 包元数据；`pnpm brand:check` 与 `pnpm architecture:check` 会阻止派生文件漂移。
- Logo 文件名固定为 `src/vvcode/assets/logo.png` 和 `src/vvcode/assets/app-icon.png`。换图后运行 `pnpm icons:generate`，不要把资源路径做成散落的业务配置。
- `compatibility.managedProviderId`、`src/vvcode` 目录名、Rust/IPC 中已有的 `vvcode_*` 命令名属于持久化或代码兼容标识，不随展示品牌改名。确需修改时必须单独设计旧数据识别、迁移和回滚方案。
- `distribution.configDirName`、`databaseFileName`、`packageName` 和 `bundleIdentifier` 会影响用户数据位置、LocalStorage 命名、可执行文件或系统安装身份。已发布产品修改这些字段前必须提供迁移策略，不能把它当成纯文案换牌。

## 禁止事项

- 禁止在 `src/product/` 或含糊的 `product` 新目录继续新增二开代码；统一使用 `vvcode` 命名。
- 禁止为了快速上线，在 `ProviderForm`、`ProviderService`、`commands/provider.rs` 等上游大文件内直接写 VV Code 分支。
- 禁止把 NewAPI access token 或 OAuth 密钥暴露给 renderer；敏感会话仍由 Rust `vvcode` 模块持有，前端只接收脱敏摘要。
- 禁止为规避边界检查而使用别名、重导出或字符串动态导入隐藏反向依赖。
- 禁止绕过 `brand.config.json` 在组件、Rust 命令、语言包、更新器或发行清单中新增品牌名、官网、仓库地址及默认产品目录硬编码。

## 校验与上游同步

提交前至少运行：

```bash
pnpm architecture:check
pnpm typecheck
pnpm test:unit
cargo test --manifest-path src-tauri/Cargo.toml --lib 'vvcode::'
```

合并/变基新版 CC Switch 时，先保留上游实现，再在组合根重接 VV Code 模块。冲突如果反复出现在上游大文件，应继续提取适配层，而不是长期维护一份复制文件。完成同步后用 `git diff --stat` 和 `git diff --dirstat` 复核二开变更是否仍主要集中在 `vvcode` 目录。
