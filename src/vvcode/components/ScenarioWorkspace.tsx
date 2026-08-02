import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpCircle,
  Check,
  ChevronsUpDown,
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
  applyPreparedManagedConfiguration,
  buildManagedProvider,
  managedProviderName,
  resolveGroupConnection,
} from "../configuration";
import { PRODUCT } from "../config";
import { newApiApi } from "../api";
import type {
  NewApiBootstrap,
  ProductScenario,
  ToolEnvironmentState,
  ToolVersionInfo,
} from "../types";
import { ManagedProviderCoreForm } from "./ManagedProviderCoreForm";
import { PageLayout } from "./PageLayout";

interface ScenarioWorkspaceProps {
  scenario: ProductScenario;
  bootstrap: NewApiBootstrap;
  preview: boolean;
  globalBaseUrl?: string;
  environment: ToolEnvironmentState;
  onCheckForUpdates: () => Promise<ToolVersionInfo>;
  onRefreshEnvironment: () => Promise<ToolVersionInfo>;
  onEnsureTokens: (groupId: string) => Promise<NewApiBootstrap>;
  initialSelectedGroupId?: string;
  onSelectedGroupChange?: (groupId: string) => void;
}

interface KeyPreparationState {
  groupId: string;
  phase: "checking" | "ready" | "error";
  error: string | null;
}

type ToolLifecycleAction = "install" | "update";

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
  action: ToolLifecycleAction | null;
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
  const [toolAction, setToolAction] = useState<ToolLifecycleAction | null>(
    null,
  );
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
  const [providerLoading, setProviderLoading] = useState(!preview);
  const [existingManagedProvider, setExistingManagedProvider] =
    useState<Provider | null>(null);
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
    (Boolean(toolInfo?.version) && !toolInfo?.installed_but_broken);
  const updateAvailable = hasToolEnvironment
    ? isUpdateAvailable(toolInfo?.version, toolInfo?.latest_version)
    : false;

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
        const nextVersion = next?.version;
        const actionCompleted =
          Boolean(nextVersion) &&
          !next?.installed_but_broken &&
          (action === "install" ||
            !isUpdateAvailable(nextVersion, next?.latest_version));
        if (actionCompleted) {
          toast.success(
            action === "install"
              ? `${scenario.name} 环境初始化完成`
              : `${scenario.name} 已更新至 ${nextVersion}`,
          );
        } else {
          toast.warning("命令已执行，但环境仍不可用，请重新检测或检查安装日志");
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
        console.warn("[VV Code] Failed to load managed provider:", error);
        if (!cancelled) setExistingManagedProvider(null);
      })
      .finally(() => {
        if (!cancelled) setProviderLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    bootstrap.groups,
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
      !hasPreparedCredential &&
      (!keyPreparationIsCurrent || keyPreparation.phase === "checking"),
  );
  const keyProvisionError =
    !hasPreparedCredential &&
    keyPreparationIsCurrent &&
    keyPreparation.phase === "error"
      ? keyPreparation.error
      : null;
  const keyReady = hasPreparedCredential;
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

    if (!environmentReady || providerLoading || !provisionGroupId) {
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
    void onEnsureTokens(provisionGroupId)
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
    environmentReady,
    onEnsureTokens,
    preview,
    providerLoading,
    scenario,
    selectedConnection?.apiKey,
    selectedGroup?.id,
  ]);

  const appliesBySwitching = scenario.appId !== "opencode";

  const handleConfigure = async (configuredProvider: Provider) => {
    if (!selectedGroup || !managedProvider) return;
    if (preview) {
      toast.info("当前为开发预览模式，不会写入本机配置");
      return;
    }
    setConfiguring(true);
    try {
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

  const handleRestoreDefaults = async () => {
    if (preview) {
      toast.info("当前为开发预览模式，不会修改本机配置");
      return;
    }

    setRestoring(true);
    try {
      await newApiApi.restoreOfficialConfiguration(scenario.appId);
      toast.success(
        scenario.appId === "openclaw" || scenario.appId === "hermes"
          ? `${scenario.name} 已移除 VV Code 托管配置`
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
  const currentVersion = toolLoading
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
                    onClick={() => setKeyRetryNonce((current) => current + 1)}
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
        <EnvironmentGate
          scenario={scenario}
          toolInfo={toolInfo}
          loading={toolLoading}
          error={
            toolError ??
            (toolInfo?.installed_but_broken ? toolInfo.error : null)
          }
          action={toolAction}
          onDetect={() => void retryEnvironmentCheck()}
          onInitialize={() => void runToolAction("install")}
        />
      )}
    </PageLayout>
  );
}
