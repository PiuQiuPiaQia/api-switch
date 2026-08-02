<div align="center">

# VV Code

A desktop app for managing AI coding tool providers, configurations, MCP servers, prompts, and skills.

[Website](https://vvcode.top) · [Releases](https://github.com/PiuQiuPiaQia/api-switch/releases) · [Documentation](docs/user-manual/en/README.md)

English · [中文](README_ZH.md) · [日本語](README_JA.md) · [Deutsch](README_DE.md)

</div>

## Features

- Manage providers for Claude Code, Claude Desktop, Codex, Gemini CLI, Grok Build, OpenCode, OpenClaw, and Hermes.
- Switch providers from the app or system tray.
- Manage MCP servers, prompts, and skills across supported tools.
- Use local proxy routing, failover, usage tracking, and session management.
- Store data locally with backup, import/export, and optional sync support.

## Download

Download the latest package from [GitHub Releases](https://github.com/PiuQiuPiaQia/api-switch/releases).

- Windows: Windows 10 or later
- macOS: macOS 12 or later
- Linux: use the package provided for your distribution

Beta releases may be unsigned or unnotarized. Check the note on each Release before installing.

## Development

Requirements: Node.js 20+, pnpm 10+, Rust 1.85+, and the [Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test:unit
```

Build a beta package for the current operating system:

```bash
pnpm package:beta
```

## Data

VV Code stores its application data under `~/.vv-code/`. Back up this directory before importing data or changing storage locations.

## Open Source Attribution

VV Code is an independently maintained derivative of [CC Switch](https://github.com/farion1231/cc-switch), created by Jason Young and its contributors. VV Code is not an official CC Switch release.

The upstream copyright and MIT License are retained in [LICENSE](LICENSE), with additional attribution in [NOTICE](NOTICE).
