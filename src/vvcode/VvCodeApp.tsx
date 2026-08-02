import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Cloud, Gauge, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { ProviderIcon } from "@/components/ProviderIcon";
import { settingsApi } from "@/lib/api/settings";
import { PRODUCT } from "./config";
import { newApiApi } from "./api";
import {
  loadSelectedGlobalBaseUrl,
  saveSelectedGlobalBaseUrl,
} from "./apiInfoPreferences";
import {
  loadSelectedScenarioGroup,
  saveSelectedScenarioGroup,
} from "./scenarioPreferences";
import { previewBootstrap, previewSession } from "./mockData";
import { resolveAccountName } from "./userIdentity";
import type {
  NewApiBootstrap,
  NewApiSession,
  ProductScenario,
  ScenarioId,
  ToolEnvironmentState,
  ToolVersionInfo,
} from "./types";
import { BrandMark } from "./components/BrandMark";
import { LoginScreen } from "./components/LoginScreen";
import { InitializationPanel } from "./components/InitializationPanel";
import { ScenarioWorkspace } from "./components/ScenarioWorkspace";
import { AccountPage } from "./components/AccountPage";
import "./vvcode.css";

type ActivePage = ProductScenario["id"] | "initialize" | "account";

const TOOL_CHECK_TIMEOUT_MS = 12_000;

function createInitialToolEnvironments(): Record<
  ScenarioId,
  ToolEnvironmentState
> {
  return PRODUCT.scenarios.reduce(
    (states, scenario) => {
      states[scenario.id] = {
        info: null,
        loading: scenario.tool !== null,
        error: null,
      };
      return states;
    },
    {} as Record<ScenarioId, ToolEnvironmentState>,
  );
}

async function withToolCheckTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("更新检测超时，请检查网络后重试")),
          TOOL_CHECK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function AppLoading() {
  return (
    <div className="vv-app-loading">
      <BrandMark />
      <Loader2 className="vv-spin" size={24} />
      <span>正在准备工作台…</span>
    </div>
  );
}

export default function VvCodeApp() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<NewApiSession | null>(null);
  const [bootstrap, setBootstrap] = useState<NewApiBootstrap | null>(null);
  const [preview, setPreview] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [globalBaseUrl, setGlobalBaseUrl] = useState("");
  const [activePage, setActivePage] = useState<ActivePage>("initialize");
  const [toolEnvironments, setToolEnvironments] = useState(
    createInitialToolEnvironments,
  );
  const initialToolCheckStartedRef = useRef(false);
  const tokenRequestsRef = useRef(new Map<string, Promise<NewApiBootstrap>>());

  const refreshToolEnvironment = useCallback(
    async (scenarioId: ScenarioId): Promise<ToolVersionInfo> => {
      const scenario = PRODUCT.scenarios.find((item) => item.id === scenarioId);
      if (!scenario) throw new Error("未找到对应的工具配置");

      if (!scenario.tool) {
        const info: ToolVersionInfo = {
          name: scenario.name,
          version: null,
          latest_version: null,
          error: null,
          installed_but_broken: false,
          env_type: "unknown",
          wsl_distro: null,
        };
        setToolEnvironments((current) => ({
          ...current,
          [scenarioId]: { info, loading: false, error: null },
        }));
        return info;
      }

      setToolEnvironments((current) => ({
        ...current,
        [scenarioId]: {
          ...current[scenarioId],
          loading: true,
          error: null,
        },
      }));

      try {
        const [result] = await withToolCheckTimeout(
          settingsApi.getToolVersions([scenario.tool]),
        );
        if (!result) throw new Error("未获得更新检测结果");
        const info = result as ToolVersionInfo;
        setToolEnvironments((current) => ({
          ...current,
          [scenarioId]: { info, loading: false, error: null },
        }));
        return info;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setToolEnvironments((current) => ({
          ...current,
          [scenarioId]: {
            ...current[scenarioId],
            loading: false,
            error: message,
          },
        }));
        throw error;
      }
    },
    [],
  );

  const checkToolUpdate = useCallback(
    async (scenarioId: ScenarioId): Promise<ToolVersionInfo> => {
      const scenario = PRODUCT.scenarios.find((item) => item.id === scenarioId);
      const currentInfo = toolEnvironments[scenarioId].info;
      if (
        !scenario?.tool ||
        !currentInfo?.version ||
        currentInfo.installed_but_broken
      ) {
        throw new Error("运行环境尚未就绪，请先在下方完成初始化");
      }

      setToolEnvironments((current) => ({
        ...current,
        [scenarioId]: {
          ...current[scenarioId],
          loading: true,
          error: null,
        },
      }));

      try {
        const [result] = await withToolCheckTimeout(
          settingsApi.getLatestToolVersions([scenario.tool], {
            [scenario.tool]: currentInfo.version,
          }),
        );
        if (!result?.latest_version) {
          throw new Error("暂未获得最新版本信息，请稍后重试");
        }
        const info: ToolVersionInfo = {
          ...currentInfo,
          latest_version: result.latest_version,
        };
        setToolEnvironments((current) => ({
          ...current,
          [scenarioId]: { info, loading: false, error: null },
        }));
        return info;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setToolEnvironments((current) => ({
          ...current,
          [scenarioId]: {
            ...current[scenarioId],
            loading: false,
            error: message,
          },
        }));
        throw error;
      }
    },
    [toolEnvironments],
  );

  const loadBootstrap = useCallback(async () => {
    if (preview) {
      setDataError(null);
      setBootstrap(previewBootstrap);
      return;
    }
    setDataLoading(true);
    setDataError(null);
    try {
      const nextBootstrap = await newApiApi.getBootstrap();
      setBootstrap(nextBootstrap);
    } catch (error) {
      setDataError(error instanceof Error ? error.message : String(error));
    } finally {
      setDataLoading(false);
    }
  }, [preview]);

  useEffect(() => {
    void newApiApi
      .getSession()
      .then(async (current) => {
        if (
          current &&
          (!PRODUCT.newApiBaseUrl ||
            current.serverUrl.replace(/\/+$/, "") !== PRODUCT.newApiBaseUrl)
        ) {
          await newApiApi.logout();
          setLoginError(
            PRODUCT.newApiBaseUrl
              ? "服务配置已更新，请使用当前中转站重新登录"
              : "当前构建尚未配置中转站服务地址",
          );
          setGlobalBaseUrl("");
          setSession(null);
          return;
        }
        setGlobalBaseUrl(
          current ? loadSelectedGlobalBaseUrl(current.serverUrl) : "",
        );
        setSession(current);
      })
      .catch((error) =>
        setLoginError(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    if (session) void loadBootstrap();
  }, [loadBootstrap, session]);

  useEffect(() => {
    if (!session || initialToolCheckStartedRef.current) return;
    initialToolCheckStartedRef.current = true;
    void Promise.allSettled(
      PRODUCT.scenarios.map((scenario) => refreshToolEnvironment(scenario.id)),
    );
  }, [refreshToolEnvironment, session]);

  const handleLogin = async () => {
    setLoginBusy(true);
    setLoginError(null);
    try {
      const nextSession = await newApiApi.beginOAuth(PRODUCT.newApiBaseUrl);
      setGlobalBaseUrl(loadSelectedGlobalBaseUrl(nextSession.serverUrl));
      setSession(nextSession);
      toast.success("登录成功，正在同步可用分组");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoginBusy(false);
    }
  };

  const handlePreview = () => {
    setPreview(true);
    setGlobalBaseUrl("");
    setSession(previewSession);
    setBootstrap(previewBootstrap);
  };

  const handleLogout = async () => {
    if (!preview) {
      try {
        await newApiApi.logout();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    setSession(null);
    setBootstrap(null);
    setPreview(false);
    setGlobalBaseUrl("");
    setActivePage("initialize");
    tokenRequestsRef.current.clear();
  };

  const handleGlobalBaseUrlChange = useCallback(
    (baseUrl: string) => {
      setGlobalBaseUrl(baseUrl);
      if (!preview && session) {
        saveSelectedGlobalBaseUrl(session.serverUrl, baseUrl);
      }
    },
    [preview, session],
  );

  const ensureTokens = useCallback(
    async (groupId: string): Promise<NewApiBootstrap> => {
      if (preview) return previewBootstrap;
      const requestKey = `${session?.serverUrl ?? ""}\u0000${session?.userId ?? ""}\u0000${groupId}`;
      const pending = tokenRequestsRef.current.get(requestKey);
      if (pending) return await pending;

      const request = newApiApi.ensureGroupTokens(groupId).then((next) => {
        setBootstrap(next);
        return next;
      });
      tokenRequestsRef.current.set(requestKey, request);
      try {
        return await request;
      } finally {
        if (tokenRequestsRef.current.get(requestKey) === request) {
          tokenRequestsRef.current.delete(requestKey);
        }
      }
    },
    [preview, session?.serverUrl, session?.userId],
  );

  const activeScenario = useMemo(
    () => PRODUCT.scenarios.find((scenario) => scenario.id === activePage),
    [activePage],
  );
  const sessionServerUrl = session?.serverUrl ?? "";
  const bootstrapUserId = bootstrap?.user.id ?? 0;
  const selectedScenarioGroupId = useMemo(() => {
    if (preview || !activeScenario || !bootstrapUserId || !sessionServerUrl) {
      return "";
    }
    return loadSelectedScenarioGroup(
      sessionServerUrl,
      bootstrapUserId,
      activeScenario.id,
    );
  }, [activeScenario, bootstrapUserId, preview, sessionServerUrl]);
  const handleSelectedScenarioGroupChange = useCallback(
    (groupId: string) => {
      if (preview || !activeScenario || !bootstrapUserId || !sessionServerUrl) {
        return;
      }
      saveSelectedScenarioGroup(
        sessionServerUrl,
        bootstrapUserId,
        activeScenario.id,
        groupId,
      );
    },
    [activeScenario, bootstrapUserId, preview, sessionServerUrl],
  );

  if (booting) return <AppLoading />;
  if (!session) {
    return (
      <LoginScreen
        busy={loginBusy}
        error={loginError}
        onLogin={() => void handleLogin()}
        onPreview={handlePreview}
      />
    );
  }

  const sidebarIdentity = bootstrap?.user ?? session;
  const sidebarAccountName = resolveAccountName(sidebarIdentity);

  return (
    <div className="vv-shell">
      <aside className="vv-sidebar">
        <div className="vv-sidebar__drag" data-tauri-drag-region />

        <nav className="vv-sidebar__nav" aria-label="工作台导航">
          <span className="vv-sidebar__label">工作台</span>
          <button
            type="button"
            className={activePage === "initialize" ? "is-active" : ""}
            onClick={() => setActivePage("initialize")}
          >
            <i style={{ "--nav-accent": "#6658ee" } as React.CSSProperties}>
              <Gauge size={18} strokeWidth={1.9} />
            </i>
            <span>初始化</span>
          </button>
          <span className="vv-sidebar__label">AI工具</span>
          {PRODUCT.scenarios.map((scenario) => (
            <button
              type="button"
              key={scenario.id}
              className={activePage === scenario.id ? "is-active" : ""}
              onClick={() => setActivePage(scenario.id)}
            >
              <i
                aria-hidden="true"
                style={
                  { "--nav-accent": scenario.accent } as React.CSSProperties
                }
              >
                <ProviderIcon
                  icon={scenario.icon}
                  name={scenario.name}
                  size={18}
                  showFallback={false}
                />
              </i>
              <span>{scenario.name}</span>
            </button>
          ))}
        </nav>

        <div className="vv-sidebar__footer">
          <button
            type="button"
            className={activePage === "account" ? "is-active" : ""}
            onClick={() => setActivePage("account")}
          >
            <span className="vv-sidebar__avatar">
              {sidebarAccountName.slice(0, 1).toUpperCase()}
            </span>
            <span className="vv-sidebar__user">
              <strong>{sidebarAccountName}</strong>
              <small>{preview ? "开发预览" : "账号已连接"}</small>
            </span>
            <ChevronRight size={14} strokeWidth={2} />
          </button>
        </div>
      </aside>

      <main className="vv-main">
        <div className="vv-topbar" data-tauri-drag-region>
          <div className="vv-topbar__connection">
            <Cloud size={14} />
            <span>{preview ? "界面预览" : "中转站已连接"}</span>
            <i />
          </div>
          {!preview && (
            <button
              type="button"
              disabled={dataLoading}
              onClick={() => void loadBootstrap()}
            >
              <RefreshCw className={dataLoading ? "vv-spin" : ""} size={14} />
              同步配置
            </button>
          )}
        </div>

        <div className="vv-main__scroll">
          {dataLoading && !bootstrap ? (
            <AppLoading />
          ) : dataError && !bootstrap ? (
            <div className="vv-data-error">
              <strong>暂时无法加载工作台数据</strong>
              <p>{dataError}</p>
              <div className="vv-data-error__actions">
                <button
                  className="vv-primary-button"
                  onClick={() => void loadBootstrap()}
                >
                  <RefreshCw size={16} /> 重新加载
                </button>
                <button
                  className="vv-secondary-button"
                  onClick={() => void handleLogout()}
                >
                  重新登录
                </button>
              </div>
            </div>
          ) : bootstrap && activePage === "initialize" ? (
            <InitializationPanel
              preview={preview}
              serverUrl={session.serverUrl}
              globalBaseUrl={globalBaseUrl}
              onGlobalBaseUrlChange={handleGlobalBaseUrlChange}
            />
          ) : bootstrap && activePage === "account" ? (
            <AccountPage
              session={session}
              bootstrap={bootstrap}
              preview={preview}
              globalBaseUrl={globalBaseUrl}
              onLogout={() => void handleLogout()}
            />
          ) : bootstrap && activeScenario ? (
            <ScenarioWorkspace
              key={activeScenario.id}
              scenario={activeScenario}
              bootstrap={bootstrap}
              preview={preview}
              globalBaseUrl={globalBaseUrl}
              environment={toolEnvironments[activeScenario.id]}
              onCheckForUpdates={() => checkToolUpdate(activeScenario.id)}
              onRefreshEnvironment={() =>
                refreshToolEnvironment(activeScenario.id)
              }
              onEnsureTokens={ensureTokens}
              initialSelectedGroupId={selectedScenarioGroupId}
              onSelectedGroupChange={handleSelectedScenarioGroupChange}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}
