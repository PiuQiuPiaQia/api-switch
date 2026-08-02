<div align="center">

# VV Code

Eine Desktop-App zur Verwaltung von Anbietern, Konfigurationen, MCP-Servern, Prompts und Skills für KI-Programmierwerkzeuge.

[Website](https://vvcode.top) · [Downloads](https://github.com/PiuQiuPiaQia/api-switch/releases) · [Dokumentation](docs/user-manual/en/README.md)

[English](README.md) · [中文](README_ZH.md) · [日本語](README_JA.md) · Deutsch

</div>

## Funktionen

- Anbieterkonfigurationen für Claude Code, Claude Desktop, Codex, Gemini CLI, Grok Build, OpenCode, OpenClaw und Hermes.
- Schneller Anbieterwechsel in der App oder über das System-Tray.
- Gemeinsame Verwaltung von MCP-Servern, Prompts und Skills.
- Lokaler Proxy, Failover, Nutzungsstatistiken und Sitzungsverwaltung.
- Lokale Datenspeicherung mit Backups, Import/Export und optionaler Synchronisierung.

## Download

Die aktuelle Version finden Sie unter [GitHub Releases](https://github.com/PiuQiuPiaQia/api-switch/releases).

- Windows: Windows 10 oder neuer
- macOS: macOS 12 oder neuer
- Linux: das passende Paket für Ihre Distribution

Beta-Versionen können unsigniert oder nicht notarisiert sein. Beachten Sie vor der Installation die Hinweise im jeweiligen Release.

## Entwicklung

Benötigt werden Node.js 20+, pnpm 10+, Rust 1.85+ und die [Systemabhängigkeiten für Tauri 2](https://v2.tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test:unit
```

Beta-Paket für das aktuelle Betriebssystem erstellen:

```bash
pnpm package:beta
```

## Daten

VV Code speichert seine Anwendungsdaten unter `~/.vv-code/`. Sichern Sie dieses Verzeichnis, bevor Sie Daten importieren oder den Speicherort ändern.

## Open-Source-Hinweis

VV Code ist ein unabhängig gepflegtes Derivat von [CC Switch](https://github.com/farion1231/cc-switch), entwickelt von Jason Young und Mitwirkenden. VV Code ist keine offizielle Veröffentlichung von CC Switch.

Der Copyright-Hinweis und die MIT-Lizenz des Upstream-Projekts befinden sich in [LICENSE](LICENSE), weitere Angaben in [NOTICE](NOTICE).
