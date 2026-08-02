import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT } from "./config";
import type { ToolVersionInfo } from "./types";
import VvCodeApp from "./VvCodeApp";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getBootstrap: vi.fn(),
  getToolVersions: vi.fn(),
  getLatestToolVersions: vi.fn(),
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
  }: {
    scenario: { name: string };
    onCheckForUpdates: () => Promise<unknown>;
  }) => (
    <div>
      {scenario.name} 工作区
      <button type="button" onClick={() => void onCheckForUpdates()}>
        仅检测更新
      </button>
    </div>
  ),
}));

vi.mock("./components/AccountPage", () => ({
  AccountPage: () => <div>用户页</div>,
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
    mocks.getSession.mockReset();
    mocks.getSession.mockResolvedValue(null);
    mocks.getBootstrap.mockReset();
    mocks.getToolVersions.mockReset();
    mocks.getLatestToolVersions.mockReset();
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
  });
});
