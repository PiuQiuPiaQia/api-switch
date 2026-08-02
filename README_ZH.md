<div align="center">

# VV Code

用于管理 AI 编程工具供应商、配置、MCP、提示词和 Skills 的桌面应用。

[官网](https://vvcode.top) · [下载](https://github.com/PiuQiuPiaQia/api-switch/releases) · [使用文档](docs/user-manual/zh/README.md)

[English](README.md) · 中文 · [日本語](README_JA.md) · [Deutsch](README_DE.md)

</div>

## 主要功能

- 管理 Claude Code、Claude Desktop、Codex、Gemini CLI、Grok Build、OpenCode、OpenClaw 和 Hermes 的供应商配置。
- 从主界面或系统托盘快速切换供应商。
- 跨工具管理 MCP、提示词和 Skills。
- 提供本地代理、故障转移、用量统计和会话管理。
- 数据本地存储，支持备份、导入导出和可选同步。

## 下载

请从 [GitHub Releases](https://github.com/PiuQiuPiaQia/api-switch/releases) 下载最新版本。

- Windows：Windows 10 及以上
- macOS：macOS 12 及以上
- Linux：选择对应发行版的安装包

Beta 版本可能未签名或未经公证，安装前请查看对应 Release 的说明。

## 开发

需要 Node.js 20+、pnpm 10+、Rust 1.85+，以及 [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test:unit
```

为当前操作系统构建 Beta 安装包：

```bash
pnpm package:beta
```

## 数据目录

VV Code 的应用数据保存在 `~/.vv-code/`。导入数据或修改存储位置前，请先备份该目录。

## 开源致谢

VV Code 是基于 [CC Switch](https://github.com/farion1231/cc-switch) 开发并独立维护的衍生项目。CC Switch 由 Jason Young 与社区贡献者共同开发；VV Code 不是 CC Switch 的官方发行版本。

上游版权与 MIT License 已保留在 [LICENSE](LICENSE)，其他说明见 [NOTICE](NOTICE)。
