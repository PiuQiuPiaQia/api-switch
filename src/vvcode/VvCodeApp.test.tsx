import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT } from "./config";
import { previewBootstrap, previewSession } from "./mockData";
import type { ToolVersionInfo } from "./types";
import VvCodeApp from "./VvCodeApp";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getBootstrap: vi.fn(),
  getToolVersions: vi.fn(),
  getLatestToolVersions: vi.fn(),
  probeToolInstallations: vi.fn(),
}));

vi.mock("./api", () => ({
  newApiApi: {
    getSession: mocks.getSession,
    getBootstrap: mocks.getBootstrap,
    beginOAuth: vi.fn(),
    logout: vi.fn(),
    ensureGroupTokens: vi.fn(),
  },
}));

vi.mock("@/lib/api/settings", () => ({
  settingsApi: {
    getToolVersions: mocks.getToolVersions,
    getLatestToolVersions: mocks.getLatestToolVersions,
    probeToolInstallations: mocks.probeToolInstallations,
  },
}));

vi.mock("./components/BrandMark", () => ({
  BrandMark: () => <span>VV Code</span>,
}));

vi.mock("./components/LoginScreen", () => ({
  LoginScreen: ({ onPreview }: { onPreview: () => void }) => (
    <button type="button" onClick={onPreview}>
      进入预览
    </button>
  ),
}));

vi.mock("./components/InitializationPanel", () => ({
  InitializationPanel: () => <div>初始化页</div>,
}));

vi.mock("./components/ScenarioWorkspace", () => ({
  ScenarioWorkspace: ({
    scenario,
    onCheckForUpdates,
    credentialRefreshing,
  }: {
    scenario: { name: string };
    onCheckForUpdates: () => Promise<unknown>;
    credentialRefreshing: boolean;
  }) => (
    <div>
      {scenario.name} 工作区
      {credentialRefreshing && <span>正在准备访问凭据…</span>}
      <button type="button" onClick={() => void onCheckForUpdates()}>
        仅检测更新
      </button>
    </div>
  ),
}));

vi.mock("./components/AccountPage", () => ({
  AccountPage: () => <div>用户页</div>,
}));

vi.mock("./components/AppUpdateControl", () => ({
  AppUpdateControl: () => null,
}));

function toolInfo(name: string): ToolVersionInfo {
  return {
    name,
    version: "1.0.0",
    latest_version: "1.0.0",
    error: null,
    installed_but_broken: false,
    env_type: "macos",
    wsl_distro: null,
  };
}

describe("VvCodeApp tool environment checks", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.getSession.mockReset();
    mocks.getSession.mockResolvedValue(null);
    mocks.getBootstrap.mockReset();
    mocks.getToolVersions.mockReset();
    mocks.getLatestToolVersions.mockReset();
    mocks.probeToolInstallations.mockReset();
    mocks.getLatestToolVersions.mockResolvedValue([
      { name: "claude", latest_version: "1.1.0" },
    ]);
    mocks.getToolVersions.mockImplementation(async ([tool]: string[]) => [
      toolInfo(tool),
    ]);
  });

  it("checks every tool once on first entry and reuses the results while navigating", async () => {
    render(<VvCodeApp />);

    fireEvent.click(await screen.findByRole("button", { name: "进入预览" }));

    expect(screen.getByText("preview")).toBeInTheDocument();
    expect(screen.queryByText("体验用户")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "OpenCode" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "对话" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "OpenClaw（龙虾）" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hermes" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Claude Desktop" }),
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(mocks.getToolVersions).toHaveBeenCalledTimes(
        PRODUCT.scenarios.filter((scenario) => scenario.tool).length,
      ),
    );
    expect(mocks.probeToolInstallations).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    expect(await screen.findByText("Claude Code 工作区")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Claude Desktop" }));
    expect(
      await screen.findByText("Claude Desktop 工作区"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Codex（桌面端 / CLI）" }),
    );
    expect(
      await screen.findByText("Codex（桌面端 / CLI） 工作区"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "OpenClaw（龙虾）" }));
    expect(
      await screen.findByText("OpenClaw（龙虾） 工作区"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hermes" }));
    expect(await screen.findByText("Hermes 工作区")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));

    expect(mocks.getToolVersions).toHaveBeenCalledTimes(
      PRODUCT.scenarios.filter((scenario) => scenario.tool).length,
    );

    fireEvent.click(screen.getByRole("button", { name: "仅检测更新" }));
    await waitFor(() =>
      expect(mocks.getLatestToolVersions).toHaveBeenCalledWith(["claude"], {
        claude: "1.0.0",
      }),
    );
    expect(mocks.getToolVersions).toHaveBeenCalledTimes(
      PRODUCT.scenarios.filter((scenario) => scenario.tool).length,
    );
    expect(mocks.getToolVersions).not.toHaveBeenCalledWith([null]);
    expect(mocks.getToolVersions).not.toHaveBeenCalledWith(["opencode"]);
    expect(mocks.getToolVersions).toHaveBeenCalledWith(["openclaw"]);
    expect(mocks.getToolVersions).toHaveBeenCalledWith(["hermes"]);
    expect(mocks.probeToolInstallations).not.toHaveBeenCalled();
  });

  it("reloads groups with the API application identifier for each scenario", async () => {
    mocks.getSession.mockResolvedValue(previewSession);
    mocks.getBootstrap.mockResolvedValue(previewBootstrap);

    render(<VvCodeApp />);

    expect(await screen.findByText("初始化页")).toBeInTheDocument();
    expect(mocks.getBootstrap).toHaveBeenCalledWith(undefined);

    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    await waitFor(() =>
      expect(mocks.getBootstrap).toHaveBeenCalledWith("claude-code"),
    );
    expect(await screen.findByText("Claude Code 工作区")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Gemini CLI" }));
    await waitFor(() =>
      expect(mocks.getBootstrap).toHaveBeenCalledWith("gemini-cli"),
    );
    expect(await screen.findByText("Gemini CLI 工作区")).toBeInTheDocument();
  });

  it("restores a visited application from cache while refreshing in the background", async () => {
    mocks.getSession.mockResolvedValue(previewSession);
    mocks.getBootstrap.mockResolvedValue(previewBootstrap);

    render(<VvCodeApp />);
    expect(await screen.findByText("初始化页")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    expect(await screen.findByText("Claude Code 工作区")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Gemini CLI" }));
    expect(await screen.findByText("Gemini CLI 工作区")).toBeInTheDocument();

    mocks.getBootstrap.mockReturnValueOnce(new Promise(() => undefined));
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));

    expect(screen.getByText("Claude Code 工作区")).toBeInTheDocument();
    expect(screen.queryByText("正在准备工作台…")).not.toBeInTheDocument();
    expect(screen.getByText("正在准备访问凭据…")).toBeInTheDocument();
  });
});
