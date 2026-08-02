import { useCallback, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolInstallationReport } from "@/lib/api/settings";
import { PRODUCT } from "../config";
import { managedProviderName } from "../configuration";
import type {
  NewApiBootstrap,
  ToolEnvironmentState,
  ToolVersionInfo,
} from "../types";
import { ScenarioWorkspace } from "./ScenarioWorkspace";

const apiMocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getToolVersions: vi.fn(),
  runToolLifecycleAction: vi.fn(),
  checkForUpdates: vi.fn(),
  refreshEnvironment: vi.fn(),
  ensureTokens: vi.fn(),
  restoreOfficialConfiguration: vi.fn(),
  repairToolCommand: vi.fn(),
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

vi.mock("../api", () => ({
  newApiApi: {
    restoreOfficialConfiguration: apiMocks.restoreOfficialConfiguration,
  },
}));

vi.mock("../toolEnvironmentApi", () => ({
  toolEnvironmentApi: {
    repairCommand: apiMocks.repairToolCommand,
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

const installedToolReport: ToolInstallationReport = {
  tool: "claude",
  installs: [
    {
      path: "/Users/tester/.local/bin/claude",
      version: "2.1.0",
      runnable: true,
      error: null,
      source: "system",
      is_path_default: true,
    },
  ],
  is_conflict: false,
  needs_confirmation: false,
  command: "/Users/tester/.local/bin/claude update",
  anchored: true,
};

const readyEnvironment: ToolEnvironmentState = {
  info: installedToolInfo,
  installationReport: installedToolReport,
  loading: false,
  error: null,
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
  ensuredBootstrap = bootstrapWithKey,
  initialSelectedGroupId,
  scenarioId = "claude",
}: {
  initialBootstrap?: NewApiBootstrap;
  ensuredBootstrap?: NewApiBootstrap;
  initialSelectedGroupId?: string;
  scenarioId?: (typeof PRODUCT.scenarios)[number]["id"];
}) {
  const [bootstrap, setBootstrap] = useState(initialBootstrap);
  const ensureTokens = useCallback(
    async (groupId: string) => {
      apiMocks.ensureTokens(groupId);
      setBootstrap(ensuredBootstrap);
      return ensuredBootstrap;
    },
    [ensuredBootstrap],
  );

  return (
    <ScenarioWorkspace
      scenario={PRODUCT.scenarios.find((item) => item.id === scenarioId)!}
      bootstrap={bootstrap}
      preview={false}
      environment={readyEnvironment}
      onCheckForUpdates={apiMocks.checkForUpdates}
      onRefreshEnvironment={apiMocks.refreshEnvironment}
      onEnsureTokens={ensureTokens}
      initialSelectedGroupId={initialSelectedGroupId}
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
    apiMocks.refreshEnvironment.mockResolvedValue({
      info: installedToolInfo,
      installationReport: installedToolReport,
    });
    apiMocks.restoreOfficialConfiguration.mockReset();
    apiMocks.restoreOfficialConfiguration.mockResolvedValue(undefined);
    apiMocks.repairToolCommand.mockReset();
    apiMocks.repairToolCommand.mockResolvedValue({
      launcher_path: "/Users/tester/.local/bin/claude",
      installation_path:
        "/Users/tester/.nvm/versions/node/v20/bin/claude",
      changed: true,
    });
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

  it("reuses a credential already present in bootstrap", async () => {
    render(<AutoProvisionHarness initialBootstrap={bootstrapWithLegacyKey} />);

    const credentialStatus = screen.getByText("访问凭据已就绪");
    expect(credentialStatus.closest(".vv-group-toolbar")).not.toBeNull();
    expect(screen.queryByText("正在准备访问凭据…")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "应用配置" })).toBeEnabled(),
    );
    expect(apiMocks.ensureTokens).not.toHaveBeenCalled();
  });

  it("restores the cached group before preparing credentials", async () => {
    const performanceGroup = {
      ...bootstrapWithoutKey.groups[0],
      id: "performance",
      name: "高性能组",
      isDefault: false,
    };
    const initialBootstrap: NewApiBootstrap = {
      ...bootstrapWithoutKey,
      groups: [bootstrapWithoutKey.groups[0], performanceGroup],
    };
    const ensuredBootstrap: NewApiBootstrap = {
      ...initialBootstrap,
      groups: initialBootstrap.groups.map((group) =>
        group.id === "performance"
          ? { ...group, apiKey: "sk-performance-ready" }
          : group,
      ),
    };

    render(
      <AutoProvisionHarness
        initialBootstrap={initialBootstrap}
        ensuredBootstrap={ensuredBootstrap}
        initialSelectedGroupId="performance"
      />,
    );

    await waitFor(() =>
      expect(apiMocks.ensureTokens).toHaveBeenCalledWith("performance"),
    );
    expect(apiMocks.ensureTokens).not.toHaveBeenCalledWith("daily");
  });

  it("waits for the applied provider group before preparing credentials", async () => {
    const performanceGroup = {
      ...bootstrapWithoutKey.groups[0],
      id: "performance",
      name: "高性能组",
      isDefault: false,
    };
    const initialBootstrap: NewApiBootstrap = {
      ...bootstrapWithoutKey,
      groups: [bootstrapWithoutKey.groups[0], performanceGroup],
    };
    const ensuredBootstrap: NewApiBootstrap = {
      ...initialBootstrap,
      groups: initialBootstrap.groups.map((group) =>
        group.id === "performance"
          ? { ...group, apiKey: "sk-performance-ready" }
          : group,
      ),
    };
    apiMocks.getProviders.mockResolvedValue({
      [PRODUCT.managedProviderId]: {
        id: PRODUCT.managedProviderId,
        name: managedProviderName(performanceGroup),
        settingsConfig: {},
      },
    });

    render(
      <AutoProvisionHarness
        initialBootstrap={initialBootstrap}
        ensuredBootstrap={ensuredBootstrap}
        initialSelectedGroupId="removed-group"
      />,
    );

    await waitFor(() =>
      expect(apiMocks.ensureTokens).toHaveBeenCalledWith("performance"),
    );
    expect(apiMocks.ensureTokens).not.toHaveBeenCalledWith("daily");
  });

  it("reuses the app-level environment state without checking again on mount", async () => {
    render(<AutoProvisionHarness initialBootstrap={bootstrapWithKey} />);

    await screen.findByRole("button", { name: "检测更新" });
    const version = screen.getByText("2.1.0");
    expect(version.closest(".vv-scenario-version")).toHaveTextContent(
      "当前版本2.1.0",
    );
    expect(version.closest(".vv-page-layout--standard")).not.toBeNull();
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

  it("opens Claude Desktop configuration without requiring a CLI environment", async () => {
    render(
      <AutoProvisionHarness
        initialBootstrap={bootstrapWithKey}
        scenarioId="claude-desktop"
      />,
    );

    expect(await screen.findByText("独立配置")).toBeInTheDocument();
    expect(screen.getByText("客户端配置")).toBeInTheDocument();
    expect(
      screen.getByText("配置后请重启 Claude Desktop。"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "检测更新" })).toBeNull();
    expect(apiMocks.getToolVersions).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(apiMocks.getProviders).toHaveBeenCalledWith("claude-desktop"),
    );
  });

  it.each(PRODUCT.scenarios.filter((scenario) => scenario.tool))(
    "offers one-click command repair for $name when its CLI is outside PATH",
    async (scenario) => {
      const hiddenPath = `/Users/tester/.nvm/versions/node/v20/bin/${scenario.tool}`;
      const hiddenEnvironment: ToolEnvironmentState = {
        info: { ...installedToolInfo, name: scenario.name },
        installationReport: {
          ...installedToolReport,
          tool: scenario.tool!,
          installs: [
            {
              ...installedToolReport.installs[0],
              path: hiddenPath,
              source: "nvm",
              is_path_default: false,
            },
          ],
        },
        loading: false,
        error: null,
      };

      render(
        <ScenarioWorkspace
          scenario={scenario}
          bootstrap={bootstrapWithKey}
          preview={false}
          environment={hiddenEnvironment}
          onCheckForUpdates={apiMocks.checkForUpdates}
          onRefreshEnvironment={apiMocks.refreshEnvironment}
          onEnsureTokens={apiMocks.ensureTokens}
        />,
      );

      expect(
        await screen.findByText(
          `${scenario.name} 已安装，只差连接终端命令`,
        ),
      ).toBeInTheDocument();
      expect(screen.getByText(/无需重装或手动修改 PATH/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "应用配置" })).toBeNull();
      expect(apiMocks.getProviders).not.toHaveBeenCalled();
      expect(apiMocks.ensureTokens).not.toHaveBeenCalled();

      apiMocks.repairToolCommand.mockResolvedValueOnce({
        launcher_path: `/Users/tester/.local/bin/${scenario.tool}`,
        installation_path: hiddenPath,
        changed: true,
      });
      fireEvent.click(screen.getByRole("button", { name: "一键修复" }));
      await waitFor(() =>
        expect(apiMocks.repairToolCommand).toHaveBeenCalledWith(scenario.tool),
      );
      await waitFor(() =>
        expect(apiMocks.refreshEnvironment).toHaveBeenCalledTimes(1),
      );
      expect(apiMocks.runToolLifecycleAction).not.toHaveBeenCalled();
    },
  );

  it("automatically repairs a hidden command after installing a CLI", async () => {
    const scenario = PRODUCT.scenarios.find((item) => item.id === "gemini")!;
    const hiddenEnvironment: ToolEnvironmentState = {
      info: {
        ...installedToolInfo,
        name: scenario.name,
      },
      installationReport: {
        ...installedToolReport,
        tool: "gemini",
        installs: [
          {
            ...installedToolReport.installs[0],
            path: "/Users/tester/.nvm/versions/node/v20/bin/gemini",
            is_path_default: false,
          },
        ],
      },
      loading: false,
      error: null,
    };
    const missingEnvironment: ToolEnvironmentState = {
      info: {
        ...installedToolInfo,
        name: scenario.name,
        version: null,
      },
      installationReport: {
        ...installedToolReport,
        tool: "gemini",
        installs: [],
      },
      loading: false,
      error: null,
    };
    apiMocks.runToolLifecycleAction.mockResolvedValue(undefined);
    apiMocks.refreshEnvironment
      .mockResolvedValueOnce(hiddenEnvironment)
      .mockResolvedValueOnce({
        info: { ...installedToolInfo, name: scenario.name },
        installationReport: {
          ...installedToolReport,
          tool: "gemini",
          installs: [
            {
              ...installedToolReport.installs[0],
              path: "/Users/tester/.local/bin/gemini",
            },
          ],
        },
      });

    render(
      <ScenarioWorkspace
        scenario={scenario}
        bootstrap={bootstrapWithKey}
        preview={false}
        environment={missingEnvironment}
        onCheckForUpdates={apiMocks.checkForUpdates}
        onRefreshEnvironment={apiMocks.refreshEnvironment}
        onEnsureTokens={apiMocks.ensureTokens}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "初始化环境" }),
    );

    await waitFor(() =>
      expect(apiMocks.runToolLifecycleAction).toHaveBeenCalledWith(
        ["gemini"],
        "install",
      ),
    );
    await waitFor(() =>
      expect(apiMocks.repairToolCommand).toHaveBeenCalledWith("gemini"),
    );
    expect(apiMocks.refreshEnvironment).toHaveBeenCalledTimes(2);
  });

  it.each(PRODUCT.scenarios)(
    "offers a native restore action for $name",
    async (scenario) => {
      render(
        <AutoProvisionHarness
          initialBootstrap={bootstrapWithKey}
          scenarioId={scenario.id}
        />,
      );

      fireEvent.click(
        await screen.findByRole("button", { name: "恢复官方默认配置" }),
      );

      await waitFor(() =>
        expect(apiMocks.restoreOfficialConfiguration).toHaveBeenCalledWith(
          scenario.appId,
        ),
      );
    },
  );

  it("keeps restore available when the account has no configurable groups", async () => {
    render(
      <AutoProvisionHarness
        initialBootstrap={{ ...bootstrapWithKey, groups: [] }}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "恢复官方默认配置" }),
    );

    await waitFor(() =>
      expect(apiMocks.restoreOfficialConfiguration).toHaveBeenCalledWith(
        "claude",
      ),
    );
    expect(apiMocks.ensureTokens).not.toHaveBeenCalled();
  });
});
