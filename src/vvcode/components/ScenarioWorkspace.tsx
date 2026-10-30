import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpCircle,
  Check,
  ChevronsUpDown,
  CircleDashed,
  CircleDollarSign,
  Download,
  Loader2,
  RefreshCw,
  RotateCcw,
  ServerCog,
} from "lucide-react";
import { toast } from "sonner";
import { ProviderIcon } from "@/components/ProviderIcon";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Provider } from "@/types";
import { providersApi } from "@/lib/api/providers";
import { settingsApi } from "@/lib/api/settings";
import { isUpdateAvailable } from "@/lib/version";
import {
  applyDshManagedConfiguration,
  applyPreparedManagedConfiguration,
  buildManagedProvider,
  isDshApiProtocol,
  managedProviderName,
  resolveGroupConnection,
} from "../configuration";
import { PRODUCT } from "../config";
import { dshApi, newApiApi } from "../api";
import type {
  DshManagedStatus,
  NewApiBootstrap,
  ProductScenario,
  ToolEnvironmentState,
  ToolEnvironmentSnapshot,
  ToolVersionInfo,
} from "../types";
import { isToolEnvironmentReady } from "../toolEnvironment";
import { ManagedProviderCoreForm } from "./ManagedProviderCoreForm";
import { PageLayout } from "./PageLayout";

interface ScenarioWorkspaceProps {
  scenario: ProductScenario;
  bootstrap: NewApiBootstrap;
  preview: boolean;
  credentialRefreshing?: boolean;
  globalBaseUrl?: string;
  environment: ToolEnvironmentState;
  onCheckForUpdates: () => Promise<ToolVersionInfo>;
  onRefreshEnvironment: () => Promise<ToolEnvironmentSnapshot>;
  onEnsureTokens: (
    groupId: string,
    createReplacementKey?: boolean,
  ) => Promise<NewApiBootstrap>;
  initialSelectedGroupId?: string;
  onSelectedGroupChange?: (groupId: string) => void;
}

interface KeyPreparationState {
  groupId: string;
  phase: "checking" | "ready" | "error";
  error: string | null;
}

type ToolLifecycleAction = "install" | "update";
type ToolAction = ToolLifecycleAction;

interface DshManagedStatusPanelProps {
  status: DshManagedStatus | null;
  loading: boolean;
  error: string | null;
  reapplying: boolean;
  canReapply: boolean;
  onReapply: () => void;
  onRefresh: () => void;
}

/**
 * Read-only view of the Dsh managed-provider status with an explicit repair
 * entry: drift is only surfaced here, never overwritten in the background.
 */
function DshManagedStatusPanel({
  status,
  loading,
  error,
  reapplying,
  canReapply,
  onReapply,
  onRefresh,
}: DshManagedStatusPanelProps) {
  if (loading && !status) {
    return (
      <section className="vv-dsh-status is-loading" aria-live="polite">
        <Loader2 className="vv-spin" size={15} />
        <span>正在读取 Dsh 配置状态…</span>
      </section>
    );
  }

  if (error && !status) {
    return (
      <section className="vv-dsh-status is-error" aria-live="polite">
        <AlertTriangle size={15} />
        <div className="vv-dsh-status__body">
          <strong>Dsh 配置状态读取失败</strong>
          <small>{error}</small>
        </div>
        <button
          type="button"
          className="vv-dsh-status__action"
          onClick={onRefresh}
        >
          重试
        </button>
      </section>
    );
  }

  if (!status) return null;

  const drift = status.conflicts.length > 0 || status.warnings.length > 0;
  const profiles = status.profileNames.join("、");

  return (
    <section
      className={`vv-dsh-status ${drift ? "is-drift" : status.managed === false ? "is-missing" : "is-ready"}`}
      aria-live="polite"
    >
      {drift ? (
        <AlertTriangle size={15} />
      ) : status.managed === false ? (
        <CircleDashed size={15} />
      ) : (
        <Check size={15} />
      )}
      <div className="vv-dsh-status__body">
        <strong>
          {status.managed === false
            ? "未检测到本机托管配置"
            : drift
              ? "本机 Dsh 配置与托管配置不一致"
              : "Dsh 托管配置已就绪"}
        </strong>
        <small>
          {status.managed === false
            ? "应用配置后写入 Dsh profile。"
            : `已写入 profile：${profiles || "（无）"}`}
        </small>
        {status.conflicts.length > 0 && (
          <ul className="vv-dsh-status__list">
            {status.conflicts.map((conflict) => (
              <li key={conflict}>{conflict}</li>
            ))}
          </ul>
        )}
        {status.warnings.length > 0 && (
          <ul className="vv-dsh-status__list">
            {status.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="vv-dsh-status__actions">
        <button
          type="button"
          className="vv-dsh-status__action"
          onClick={onRefresh}
          disabled={loading || reapplying}
        >
          刷新状态
        </button>
        {drift && canReapply && (
          <button
            type="button"
            className="vv-dsh-status__action is-primary"
            onClick={onReapply}
            disabled={loading || reapplying}
          >
            {reapplying ? (
              <Loader2 className="vv-spin" size={13} />
            ) : (
              <RotateCcw size={13} />
            )}
            重新应用托管配置
          </button>
        )}
      </div>
    </section>
  );
}

function ratioLabel(value: string): string {
  if (!value) return "1×";
  if (value === "自动") return value;
  return `${value.replace(/x$/i, "")}×`;
}

interface EnvironmentGateProps {
  scenario: ProductScenario;
  toolInfo: ToolVersionInfo | null;
  loading: boolean;
  error: string | null;
  action: ToolAction | null;
  onDetect: () => void;
  onInitialize: () => void;
}

function EnvironmentGate({
  scenario,
  toolInfo,
  loading,
  error,
  action,
  onDetect,
  onInitialize,
}: EnvironmentGateProps) {
  const knownUnavailable = Boolean(toolInfo) && !toolInfo?.version;
  const needsRepair = Boolean(toolInfo?.installed_but_broken);
  const initializing = action === "install";
  const checking = loading && !initializing;
  const canInitialize = knownUnavailable || needsRepair;

  const title = checking
    ? `正在检测 ${scenario.name} 环境`
    : initializing
      ? `正在初始化 ${scenario.name}`
      : error && !toolInfo
        ? "暂时无法确认本机环境"
        : needsRepair
          ? `${scenario.name} 环境需要修复`
          : `先初始化 ${scenario.name} 环境`;

  const description = checking
    ? "正在读取本机客户端状态。"
    : initializing
      ? "正在安装并校验客户端，请稍候。"
      : error && !toolInfo
        ? "无法确认环境状态，重试后再继续。"
        : needsRepair
          ? "客户端无法正常启动，重新初始化后再继续。"
          : `本机尚未安装 ${scenario.name}，初始化后即可配置分组和模型。`;

  return (
    <section
      className={`vv-environment-gate ${error ? "is-error" : ""}`}
      aria-live="polite"
    >
      <div className="vv-environment-gate__content">
        <span className="vv-environment-gate__icon">
          {checking || initializing ? (
            <Loader2 className="vv-spin" size={34} />
          ) : error && !toolInfo ? (
            <AlertTriangle size={34} />
          ) : (
            <ServerCog size={34} />
          )}
        </span>
        <h2>{title}</h2>
        <p>{description}</p>

        {error && !checking && !initializing && (
          <div className="vv-environment-gate__error">
            <AlertTriangle size={14} />
            <span>{error}</span>
          </div>
        )}

        <button
          type="button"
          className="vv-primary-button vv-environment-gate__action"
          disabled={checking || initializing}
          onClick={canInitialize ? onInitialize : onDetect}
        >
          {checking || initializing ? (
            <Loader2 className="vv-spin" size={17} />
          ) : canInitialize ? (
            <Download size={17} />
          ) : (
            <RefreshCw size={17} />
          )}
          {checking
            ? "正在检测"
            : initializing
              ? "正在初始化"
              : canInitialize
                ? needsRepair
                  ? "重新初始化环境"
                  : "初始化环境"
                : "重新检测环境"}
        </button>
      </div>
    </section>
  );
}

export function ScenarioWorkspace({
  scenario,
  bootstrap,
  preview,
  credentialRefreshing = false,
  globalBaseUrl = "",
  environment,
  onCheckForUpdates,
  onRefreshEnvironment,
  onEnsureTokens,
  initialSelectedGroupId = "",
  onSelectedGroupChange,
}: ScenarioWorkspaceProps) {
  const cachedGroupId = bootstrap.groups.some(
    (group) => group.id === initialSelectedGroupId,
  )
    ? initialSelectedGroupId
    : "";
  const [toolAction, setToolAction] = useState<ToolAction | null>(null);
  const [groupSelectorOpen, setGroupSelectorOpen] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState(
    cachedGroupId ||
      bootstrap.groups.find((group) => group.isDefault)?.id ||
      bootstrap.groups[0]?.id ||
      "",
  );
  const [configuring, setConfiguring] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [keyPreparation, setKeyPreparation] = useState<KeyPreparationState>({
    groupId: "",
    phase: "checking",
    error: null,
  });
  const [keyRetryNonce, setKeyRetryNonce] = useState(0);
  const [replacementKeyGroupId, setReplacementKeyGroupId] = useState<
    string | null
  >(null);
  const [providerLoading, setProviderLoading] = useState(!preview);
  const [existingManagedProvider, setExistingManagedProvider] =
    useState<Provider | null>(null);
  const [dshStatus, setDshStatus] = useState<DshManagedStatus | null>(null);
  const [dshStatusLoading, setDshStatusLoading] = useState(false);
  const [dshStatusError, setDshStatusError] = useState<string | null>(null);
  const [dshReapplying, setDshReapplying] = useState(false);
  const selectionTouchedRef = useRef(Boolean(cachedGroupId));
  const keyProvisionRequestRef = useRef(0);
  const {
    info: toolInfo,
    loading: toolLoading,
    error: toolError,
  } = environment;
  const hasToolEnvironment = scenario.tool !== null;
  const environmentReady =
    !hasToolEnvironment ||
    isToolEnvironmentReady(environment) ||
    (scenario.id === "dsh" && dshStatus?.desktopAvailable === true);
  const desktopOnly =
    scenario.id === "dsh" &&
    dshStatus?.desktopAvailable === true &&
    !isToolEnvironmentReady(environment);
  const updateAvailable = hasToolEnvironment
    ? isUpdateAvailable(toolInfo?.version, toolInfo?.latest_version)
    : false;
  // Credential refreshes replace the bootstrap object, but do not change the
  // group catalogue. Keep the provider editor mounted during those refreshes.
  const groupCatalogSignature = useMemo(
    () =>
      JSON.stringify(
        bootstrap.groups.map((group) => ({
          id: group.id,
          name: group.name,
          description: group.description,
          ratio: group.ratio,
        })),
      ),
    [bootstrap.groups],
  );

  const checkForUpdates = useCallback(async () => {
    try {
      const next = await onCheckForUpdates();
      if (!next.version || next.installed_but_broken) {
        toast.info(`本机暂未检测到可更新的 ${scenario.name} 环境`);
      } else if (isUpdateAvailable(next.version, next.latest_version)) {
        toast.info(`发现 ${scenario.name} 新版本 ${next.latest_version ?? ""}`);
      } else {
        toast.success(`${scenario.name} 已是最新版本`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error("更新检测失败", { description: message });
    }
  }, [onCheckForUpdates, scenario.name]);

  const retryEnvironmentCheck = useCallback(async () => {
    try {
      await onRefreshEnvironment();
    } catch (error) {
      toast.error("环境检测失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [onRefreshEnvironment]);

  const runToolAction = useCallback(
    async (action: ToolLifecycleAction) => {
      if (!scenario.tool) return;
      if (preview) {
        toast.info("当前为开发预览模式，不会修改本机环境");
        return;
      }

      setToolAction(action);
      try {
        await settingsApi.runToolLifecycleAction([scenario.tool], action);
        const next = await onRefreshEnvironment();
        const nextVersion = next.info?.version;
        const actionCompleted =
          Boolean(nextVersion) &&
          isToolEnvironmentReady(next) &&
          (action === "install" ||
            !isUpdateAvailable(nextVersion, next.info?.latest_version));
        if (actionCompleted) {
          toast.success(
            action === "install"
              ? `${scenario.name} 环境初始化完成`
              : `${scenario.name} 已更新至 ${nextVersion}`,
          );
        } else {
          toast.warning("命令已执行，但环境仍不可用", {
            description: next.info?.error || "请重新检测或检查安装日志。",
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(action === "install" ? "环境初始化失败" : "环境更新失败", {
          description: message,
        });
      } finally {
        setToolAction(null);
      }
    },
    [onRefreshEnvironment, preview, scenario.name, scenario.tool],
  );

  useEffect(() => {
    let cancelled = false;

    if (!environmentReady) {
      setExistingManagedProvider(null);
      setProviderLoading(false);
      return;
    }

    if (preview) {
      setExistingManagedProvider(null);
      setProviderLoading(false);
      return;
    }

    setProviderLoading(true);
    void providersApi
      .getAll(scenario.appId)
      .then((providers) => {
        if (cancelled) return;
        const existing = providers[PRODUCT.managedProviderId] ?? null;
        setExistingManagedProvider(existing);

        if (!existing || selectionTouchedRef.current) return;
        const appliedGroup = bootstrap.groups.find(
          (group) => existing.name === managedProviderName(group),
        );
        if (!appliedGroup) return;
        setSelectedGroupId(appliedGroup.id);
        onSelectedGroupChange?.(appliedGroup.id);
      })
      .catch((error) => {
        console.warn(
          `[${PRODUCT.brand.name}] Failed to load managed provider:`,
          error,
        );
        if (!cancelled) setExistingManagedProvider(null);
      })
      .finally(() => {
        if (!cancelled) setProviderLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    groupCatalogSignature,
    environmentReady,
    onSelectedGroupChange,
    preview,
    scenario,
  ]);

  const selectedGroup = useMemo(
    () =>
      bootstrap.groups.find((group) => group.id === selectedGroupId) ?? null,
    [bootstrap.groups, selectedGroupId],
  );

  const isDshScenario = scenario.id === "dsh";

  // Dsh status is refreshed on load, after apply, and after restore — never
  // polled in the background.
  const refreshDshStatus = useCallback(async () => {
    if (!isDshScenario || preview) return;
    setDshStatusLoading(true);
    try {
      const nextStatus = await dshApi.getManagedStatus();
      setDshStatus(nextStatus);
      setDshStatusError(null);
    } catch (error) {
      setDshStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      setDshStatusLoading(false);
    }
  }, [isDshScenario, preview]);

  useEffect(() => {
    // Desktop can be installed without the CLI. Probe it before applying the
    // CLI environment gate, otherwise desktop-only installations never open.
    if (!isDshScenario || preview) return;
    void refreshDshStatus();
  }, [isDshScenario, preview, refreshDshStatus]);

  const selectedConnection = useMemo(
    () =>
      selectedGroup
        ? resolveGroupConnection(scenario, selectedGroup, globalBaseUrl)
        : null,
    [globalBaseUrl, scenario, selectedGroup],
  );
  const keyPreparationIsCurrent =
    keyPreparation.groupId === (selectedGroup?.id ?? "");
  const hasPreparedCredential = Boolean(selectedConnection?.apiKey.trim());
  const keyProvisioning = Boolean(
    selectedGroup &&
      !preview &&
      (credentialRefreshing ||
        (!hasPreparedCredential &&
          (!keyPreparationIsCurrent || keyPreparation.phase === "checking"))),
  );
  const keyProvisionError =
    !hasPreparedCredential &&
    keyPreparationIsCurrent &&
    keyPreparation.phase === "error"
      ? keyPreparation.error
      : null;
  const keyReady = hasPreparedCredential && !credentialRefreshing;
  const managedProvider = useMemo(
    () =>
      selectedGroup
        ? buildManagedProvider(
            scenario,
            selectedGroup,
            existingManagedProvider,
            globalBaseUrl,
          )
        : null,
    [existingManagedProvider, globalBaseUrl, scenario, selectedGroup],
  );
  const managedFormId = `vv-managed-provider-form-${scenario.id}`;

  useEffect(() => {
    if (bootstrap.groups.some((group) => group.id === selectedGroupId)) return;
    const fallbackGroupId =
      bootstrap.groups.find((group) => group.isDefault)?.id ??
      bootstrap.groups[0]?.id ??
      "";
    setSelectedGroupId(fallbackGroupId);
    onSelectedGroupChange?.(fallbackGroupId);
  }, [bootstrap.groups, onSelectedGroupChange, selectedGroupId]);

  useEffect(() => {
    const requestId = keyProvisionRequestRef.current + 1;
    keyProvisionRequestRef.current = requestId;
    const provisionGroupId = selectedGroup?.id ?? "";

    if (
      !environmentReady ||
      providerLoading ||
      credentialRefreshing ||
      !provisionGroupId
    ) {
      setKeyPreparation({
        groupId: provisionGroupId,
        phase: "checking",
        error: null,
      });
      return;
    }

    if (preview || selectedConnection?.apiKey.trim()) {
      setKeyPreparation({
        groupId: provisionGroupId,
        phase: "ready",
        error: null,
      });
      return;
    }

    setKeyPreparation({
      groupId: provisionGroupId,
      phase: "checking",
      error: null,
    });
    const ensureTokens =
      replacementKeyGroupId === provisionGroupId
        ? onEnsureTokens(provisionGroupId, true)
        : onEnsureTokens(provisionGroupId);
    void ensureTokens
      .then((nextBootstrap) => {
        if (keyProvisionRequestRef.current !== requestId) return;
        const nextGroup = nextBootstrap.groups.find(
          (group) => group.id === provisionGroupId,
        );
        const nextConnection = nextGroup
          ? resolveGroupConnection(scenario, nextGroup, globalBaseUrl)
          : null;
        if (!nextConnection?.apiKey) {
          throw new Error("客户端密钥创建完成后未能读取，请重试");
        }
        setKeyPreparation({
          groupId: provisionGroupId,
          phase: "ready",
          error: null,
        });
      })
      .catch((error) => {
        if (keyProvisionRequestRef.current !== requestId) return;
        setKeyPreparation({
          groupId: provisionGroupId,
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [
    keyRetryNonce,
    credentialRefreshing,
    environmentReady,
    onEnsureTokens,
    preview,
    providerLoading,
    replacementKeyGroupId,
    scenario,
    selectedConnection?.apiKey,
    selectedGroup?.id,
  ]);

  const appliesBySwitching = scenario.appId !== "opencode";

  const handleConfigure = async (configuredProvider: Provider) => {
    if (!selectedGroup || !managedProvider) return;
    if (!environmentReady) {
      toast.error("运行环境尚未就绪，未写入本机配置");
      return;
    }
    if (preview) {
      toast.info("当前为开发预览模式，不会写入本机配置");
      return;
    }
    setConfiguring(true);
    try {
      if (isDshScenario) {
        // Dsh profiles are written by the dedicated backend only; the
        // generic providers add/switch path must never touch ~/.dsh.
        const nextStatus =
          await applyDshManagedConfiguration(configuredProvider);
        setDshStatus(nextStatus);
        setDshStatusError(null);
        setExistingManagedProvider(configuredProvider);
        toast.success(
          `${scenario.name} 托管配置已应用到 ${nextStatus.profileNames.length} 个 profile`,
        );
        return;
      }
      await applyPreparedManagedConfiguration(
        scenario,
        selectedGroup,
        configuredProvider,
        globalBaseUrl,
      );
      setExistingManagedProvider(configuredProvider);
      toast.success(
        appliesBySwitching
          ? `${scenario.name} 已配置并切换到 ${selectedGroup.name}`
          : `${scenario.name} 配置已应用`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setConfiguring(false);
    }
  };

  const handleReapplyDsh = async () => {
    if (!selectedGroup || !managedProvider) return;
    if (!environmentReady) {
      toast.error("运行环境尚未就绪，未写入本机配置");
      return;
    }
    if (preview) {
      toast.info("当前为开发预览模式，不会写入本机配置");
      return;
    }
    setDshReapplying(true);
    try {
      const nextStatus = await applyDshManagedConfiguration(managedProvider);
      setDshStatus(nextStatus);
      setDshStatusError(null);
      setExistingManagedProvider(managedProvider);
      toast.success(`${scenario.name} 托管配置已重新应用`);
    } catch (error) {
      toast.error("重新应用 Dsh 托管配置失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDshReapplying(false);
    }
  };

  const handleRestoreDefaults = async () => {
    if (preview) {
      toast.info("当前为开发预览模式，不会修改本机配置");
      return;
    }

    setRestoring(true);
    try {
      await newApiApi.restoreOfficialConfiguration(scenario.appId);
      if (isDshScenario) {
        await refreshDshStatus();
      }
      toast.success(
        scenario.appId === "openclaw" || scenario.appId === "hermes"
          ? `${scenario.name} 已移除 ${PRODUCT.brand.name} 托管配置`
          : `${scenario.name} 已恢复官方默认配置`,
      );
    } catch (error) {
      toast.error("恢复官方默认配置失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRestoring(false);
    }
  };

  const headerAction: "check" | "update" = updateAvailable ? "update" : "check";
  const headerBusy = toolLoading || toolAction !== null;
  const headerChecking = toolLoading || toolAction === "update";
  const headerLabel =
    toolAction === "update"
      ? "正在更新"
      : toolLoading
        ? "检测更新中"
        : headerAction === "update"
          ? "更新"
          : "检测更新";
  const headerTitle =
    toolError ??
    (toolInfo?.installed_but_broken ? toolInfo.error : null) ??
    (headerAction === "update"
      ? `发现新版本 ${toolInfo?.latest_version ?? ""}`
      : toolInfo?.version
        ? `当前版本 ${toolInfo.version}，点击检测更新`
        : `${scenario.name} 尚未初始化，可在下方完成安装`);
  const currentVersion = desktopOnly
    ? "桌面端已安装"
    : toolLoading
    ? "检测中"
    : toolInfo?.version
      ? toolInfo.version
      : toolError
        ? "检测失败"
        : "未安装";

  return (
    <PageLayout
      className="vv-scenario-page"
      style={{ "--scenario-accent": scenario.accent } as React.CSSProperties}
      title={scenario.name}
      description={scenario.description}
      icon={
        <ProviderIcon
          icon={scenario.icon}
          name={scenario.name}
          size={21}
          showFallback={false}
        />
      }
      accent={scenario.accent}
      actions={
        hasToolEnvironment ? (
          <>
            {scenario.desktopDownload && (
              <a
                className="vv-desktop-download"
                href={scenario.desktopDownload.url}
                target="_blank"
                rel="noopener noreferrer"
                title="前往包含 Codex 的 ChatGPT 桌面端官方下载页"
              >
                <Download size={15} />
                <span>{scenario.desktopDownload.label}</span>
              </a>
            )}
            <span
              className={`vv-scenario-version ${environmentReady ? "is-ready" : "is-missing"} ${toolError ? "is-error" : ""}`}
              title={headerTitle}
            >
              <span>当前版本</span>
              <strong>{currentVersion}</strong>
            </span>
            <button
              type="button"
              className={`vv-environment-button ${environmentReady ? "is-ready" : "is-missing"} ${updateAvailable ? "is-update" : ""} ${toolError ? "is-error" : ""}`}
              disabled={headerBusy || !environmentReady}
              title={headerTitle}
              onClick={() => {
                if (headerAction === "check") {
                  void checkForUpdates();
                } else {
                  void runToolAction("update");
                }
              }}
            >
              {headerChecking ? (
                <Loader2 className="vv-spin" size={15} />
              ) : headerAction === "update" ? (
                <ArrowUpCircle size={15} />
              ) : (
                <RefreshCw size={15} />
              )}
              <span>{headerLabel}</span>
            </button>
          </>
        ) : (
          <span className="vv-scenario-version is-ready" title="无需安装 CLI">
            <span>客户端</span>
            <strong>独立配置</strong>
          </span>
        )
      }
    >
      {environmentReady ? (
        <section className="vv-catalog">
          <div className="vv-group-toolbar">
            <span className="vv-field-label">分组</span>
            {selectedGroup ? (
              <Popover
                modal
                open={groupSelectorOpen}
                onOpenChange={setGroupSelectorOpen}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    role="combobox"
                    aria-expanded={groupSelectorOpen}
                    className="vv-group-select"
                  >
                    <span className="vv-group-select__current">
                      <strong>{selectedGroup.name}</strong>
                    </span>
                    <span className="vv-ratio-badge">
                      <CircleDollarSign size={13} />
                      {ratioLabel(selectedGroup.ratio)}
                    </span>
                    <ChevronsUpDown
                      className="vv-group-select__chevrons"
                      size={16}
                    />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="start"
                  sideOffset={6}
                  collisionPadding={10}
                  className="vv-group-select__popover z-[200] w-[var(--radix-popover-trigger-width)] p-0"
                >
                  <Command>
                    <CommandInput placeholder="搜索分组…" />
                    <CommandList>
                      <CommandEmpty>没有找到匹配的分组</CommandEmpty>
                      <CommandGroup
                        heading={`可用分组 · ${bootstrap.groups.length}`}
                      >
                        {bootstrap.groups.map((group) => (
                          <CommandItem
                            key={group.id}
                            value={group.id}
                            keywords={[group.name, group.description]}
                            className="vv-group-select__option"
                            onSelect={() => {
                              selectionTouchedRef.current = true;
                              setSelectedGroupId(group.id);
                              onSelectedGroupChange?.(group.id);
                              setGroupSelectorOpen(false);
                            }}
                          >
                            <Check
                              className={`vv-group-select__check ${selectedGroupId === group.id ? "is-visible" : ""}`}
                              size={15}
                            />
                            <span className="vv-group-select__option-copy">
                              <strong>{group.name}</strong>
                              <small>
                                {group.description || "由中转站分配的可用线路"}
                              </small>
                            </span>
                            <span className="vv-group-select__option-ratio">
                              {ratioLabel(group.ratio)}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            ) : (
              <div className="vv-empty-result">暂无可用分组</div>
            )}
            {selectedGroup && (
              <div
                className={`vv-credential-status ${keyProvisionError ? "is-error" : keyProvisioning ? "is-loading" : "is-ready"}`}
                aria-live="polite"
              >
                {keyProvisioning ? (
                  <Loader2 className="vv-spin" size={14} />
                ) : keyProvisionError ? (
                  <AlertTriangle size={14} />
                ) : (
                  <Check size={14} />
                )}
                <span>
                  {keyProvisioning
                    ? "正在准备访问凭据…"
                    : keyProvisionError
                      ? keyProvisionError
                      : "访问凭据已就绪"}
                </span>
                {keyProvisionError && (
                  <button
                    type="button"
                    className="vv-credential-status__retry"
                    onClick={() => {
                      setReplacementKeyGroupId(selectedGroup.id);
                      setKeyRetryNonce((current) => current + 1);
                    }}
                  >
                    重试
                  </button>
                )}
              </div>
            )}
          </div>

          {selectedGroup && managedProvider && (
            <section className="vv-provider-editor">
              <div className="vv-provider-editor__body">
                {providerLoading ? (
                  <div className="vv-provider-editor__loading">
                    <Loader2 className="vv-spin" size={17} />
                    正在读取已有配置…
                  </div>
                ) : (
                  <div className="vv-managed-provider-form">
                    <ManagedProviderCoreForm
                      key={`${scenario.id}:${selectedGroup.id}:${globalBaseUrl}`}
                      formId={managedFormId}
                      scenario={scenario}
                      group={selectedGroup}
                      globalBaseUrl={globalBaseUrl}
                      provider={managedProvider}
                      hasApiKey={keyReady}
                      onSubmit={handleConfigure}
                    />
                  </div>
                )}
              </div>
            </section>
          )}

          {isDshScenario && (
            <DshManagedStatusPanel
              status={dshStatus}
              loading={dshStatusLoading}
              error={dshStatusError}
              reapplying={dshReapplying}
              canReapply={Boolean(
                selectedGroup &&
                  managedProvider &&
                  // Reapplying rewrites the persisted managed provider; it is
                  // only meaningful once a protocol has actually been saved.
                  isDshApiProtocol(managedProvider.settingsConfig?.api) &&
                  !providerLoading &&
                  keyReady,
              )}
              onReapply={() => void handleReapplyDsh()}
              onRefresh={() => void refreshDshStatus()}
            />
          )}

          <div className="vv-config-actions">
            <button
              type="button"
              className="vv-secondary-button"
              disabled={configuring || restoring || providerLoading}
              onClick={() => void handleRestoreDefaults()}
            >
              {restoring ? (
                <Loader2 className="vv-spin" size={16} />
              ) : (
                <RotateCcw size={16} />
              )}
              {restoring ? "正在恢复" : "恢复官方默认配置"}
            </button>
            {selectedGroup && (
              <button
                type="submit"
                form={managedFormId}
                className="vv-primary-button"
                disabled={
                  configuring ||
                  restoring ||
                  providerLoading ||
                  keyProvisioning ||
                  !keyReady
                }
              >
                {configuring ? <Loader2 className="vv-spin" size={16} /> : null}
                {configuring
                  ? "正在应用"
                  : preview
                    ? "预览应用配置"
                    : "应用配置"}
                {!configuring && <ArrowRight size={16} />}
              </button>
            )}
          </div>
        </section>
      ) : (
        <>
          {isDshScenario && (dshStatusLoading || dshStatusError) && (
            <DshManagedStatusPanel
              status={dshStatus}
              loading={dshStatusLoading}
              error={dshStatusError}
              reapplying={false}
              canReapply={false}
              onReapply={() => {}}
              onRefresh={() => void refreshDshStatus()}
            />
          )}
          <EnvironmentGate
            scenario={scenario}
            toolInfo={toolInfo}
            loading={toolLoading}
            error={
              toolError ??
              (toolInfo?.installed_but_broken ? toolInfo.error : null)
            }
            action={toolAction}
            onDetect={() => {
              void retryEnvironmentCheck();
              if (isDshScenario) void refreshDshStatus();
            }}
            onInitialize={() => void runToolAction("install")}
          />
        </>
      )}
    </PageLayout>
  );
}
