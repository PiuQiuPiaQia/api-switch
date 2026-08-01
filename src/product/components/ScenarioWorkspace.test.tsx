import { useCallback, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT } from "../config";
import type { NewApiBootstrap, ToolVersionInfo } from "../types";
import { ScenarioWorkspace } from "./ScenarioWorkspace";

const apiMocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getToolVersions: vi.fn(),
  runToolLifecycleAction: vi.fn(),
  checkForUpdates: vi.fn(),
  refreshEnvironment: vi.fn(),
  ensureTokens: vi.fn(),
}));

vi.mock("@/lib/api/providers", () => ({
  providersApi: { getAll: apiMocks.getProviders },
}));

vi.mock("@/lib/api/settings", () => ({
  settingsApi: {
    getToolVersions: apiMocks.getToolVersions,
    runToolLifecycleAction: apiMocks.runToolLifecycleAction,
  },
}));

const installedToolInfo: ToolVersionInfo = {
  name: "Claude Code",
  version: "2.1.0",
  latest_version: null,
  error: null,
  installed_but_broken: false,
  env_type: "macos",
  wsl_distro: null,
};

const bootstrapWithoutKey: NewApiBootstrap = {
  source: "desktop-v1",
  user: {
    id: 1,
    username: "tester",
    displayName: "Tester",
    email: "",
    role: 1,
    status: 1,
    group: "daily",
    quota: 100,
    usedQuota: 0,
    requestCount: 0,
  },
  groups: [
    {
      id: "daily",
      name: "日常组",
      description: "日常线路",
      ratio: "0.7",
      baseUrl: "https://api.example.com",
      apiKey: "",
      defaultModelId: "",
      apiProvider: "anthropic",
      ccProvider: "anthropic",
      isDefault: true,
      models: [],
    },
  ],
};

const bootstrapWithKey: NewApiBootstrap = {
  ...bootstrapWithoutKey,
  groups: bootstrapWithoutKey.groups.map((group) => ({
    ...group,
    apiKey: "sk-ready-1234567890-done",
  })),
};

const bootstrapWithLegacyKey: NewApiBootstrap = {
  ...bootstrapWithoutKey,
  groups: bootstrapWithoutKey.groups.map((group) => ({
    ...group,
    apiKey: "sk-legacy-1234567890-old",
  })),
};

function AutoProvisionHarness({
  initialBootstrap = bootstrapWithoutKey,
}: {
  initialBootstrap?: NewApiBootstrap;
}) {
  const [bootstrap, setBootstrap] = useState(initialBootstrap);
  const ensureTokens = useCallback(async (groupId: string) => {
    apiMocks.ensureTokens(groupId);
    setBootstrap(bootstrapWithKey);
    return bootstrapWithKey;
  }, []);

  return (
    <ScenarioWorkspace
      scenario={PRODUCT.scenarios.find((item) => item.id === "claude")!}
      bootstrap={bootstrap}
      preview={false}
      environment={{ info: installedToolInfo, loading: false, error: null }}
      onCheckForUpdates={apiMocks.checkForUpdates}
      onRefreshEnvironment={apiMocks.refreshEnvironment}
      onEnsureTokens={ensureTokens}
    />
  );
}

describe("ScenarioWorkspace", () => {
  beforeEach(() => {
    apiMocks.ensureTokens.mockReset();
    apiMocks.getProviders.mockReset();
    apiMocks.getProviders.mockResolvedValue({});
    apiMocks.getToolVersions.mockReset();
    apiMocks.runToolLifecycleAction.mockReset();
    apiMocks.checkForUpdates.mockReset();
    apiMocks.checkForUpdates.mockResolvedValue(installedToolInfo);
    apiMocks.refreshEnvironment.mockReset();
    apiMocks.refreshEnvironment.mockResolvedValue(installedToolInfo);
  });

  it("automatically provisions a missing group key and enables configuration", async () => {
    render(<AutoProvisionHarness />);

    await waitFor(() =>
      expect(apiMocks.ensureTokens).toHaveBeenCalledWith("daily"),
    );
    expect(apiMocks.ensureTokens).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "创建客户端密钥" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "应用配置" })).toBeEnabled(),
    );
  });

  it("checks the desktop key even when a legacy compatibility key exists", async () => {
    render(<AutoProvisionHarness initialBootstrap={bootstrapWithLegacyKey} />);

    await waitFor(() =>
      expect(apiMocks.ensureTokens).toHaveBeenCalledWith("daily"),
    );
    expect(apiMocks.ensureTokens).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "应用配置" })).toBeEnabled(),
    );
  });

  it("reuses the app-level environment state without checking again on mount", async () => {
    render(<AutoProvisionHarness initialBootstrap={bootstrapWithKey} />);

    await screen.findByRole("button", { name: "检测更新" });
    expect(apiMocks.getToolVersions).not.toHaveBeenCalled();
    expect(apiMocks.refreshEnvironment).not.toHaveBeenCalled();
  });

  it("uses the update-only callback from the header", async () => {
    render(<AutoProvisionHarness initialBootstrap={bootstrapWithKey} />);

    fireEvent.click(await screen.findByRole("button", { name: "检测更新" }));

    await waitFor(() =>
      expect(apiMocks.checkForUpdates).toHaveBeenCalledTimes(1),
    );
    expect(apiMocks.refreshEnvironment).not.toHaveBeenCalled();
    expect(apiMocks.getToolVersions).not.toHaveBeenCalled();
  });
});
