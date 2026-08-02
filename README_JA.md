<div align="center">

# VV Code

AI コーディングツールのプロバイダー、設定、MCP、プロンプト、Skills を管理するデスクトップアプリです。

[Web サイト](https://vvcode.top) · [ダウンロード](https://github.com/PiuQiuPiaQia/api-switch/releases) · [ドキュメント](docs/user-manual/ja/README.md)

[English](README.md) · [中文](README_ZH.md) · 日本語 · [Deutsch](README_DE.md)

</div>

## 主な機能

- Claude Code、Claude Desktop、Codex、Gemini CLI、Grok Build、OpenCode、OpenClaw、Hermes のプロバイダー設定を管理。
- アプリまたはシステムトレイからプロバイダーを切り替え。
- 対応ツール間で MCP、プロンプト、Skills を管理。
- ローカルプロキシ、フェイルオーバー、使用量追跡、セッション管理。
- ローカル保存、バックアップ、インポート・エクスポート、任意の同期機能。

## ダウンロード

最新版は [GitHub Releases](https://github.com/PiuQiuPiaQia/api-switch/releases) からダウンロードできます。

- Windows：Windows 10 以降
- macOS：macOS 12 以降
- Linux：ディストリビューションに対応するパッケージ

Beta 版は署名または公証されていない場合があります。インストール前に各 Release の注意事項を確認してください。

## 開発

Node.js 20+、pnpm 10+、Rust 1.85+、および [Tauri 2 のシステム依存関係](https://v2.tauri.app/start/prerequisites/)が必要です。

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test:unit
```

現在の OS 向け Beta パッケージをビルドします：

```bash
pnpm package:beta
```

## データ

VV Code のアプリデータは `~/.vv-code/` に保存されます。データのインポートや保存先の変更前に、このディレクトリをバックアップしてください。

## オープンソース表記

VV Code は Jason Young とコントリビューターによる [CC Switch](https://github.com/farion1231/cc-switch) を基に、独立して保守されている派生プロジェクトです。CC Switch の公式リリースではありません。

上流の著作権表示と MIT License は [LICENSE](LICENSE) に、追加の表記は [NOTICE](NOTICE) に記載されています。
