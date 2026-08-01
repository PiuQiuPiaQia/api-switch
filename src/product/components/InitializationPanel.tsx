import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  Check,
  Globe2,
  Loader2,
  RefreshCw,
  Server,
} from "lucide-react";
import { toast } from "sonner";
import { newApiApi } from "../api";
import {
  loadCachedApiInfoRoutes,
  saveCachedApiInfoRoutes,
} from "../apiInfoPreferences";
import {
  latencyGrade,
  normalizeProbeUrl,
  uniqueProbeUrls,
} from "../initialization";
import { previewApiInfoRoutes } from "../mockData";
import type { NewApiEndpointProbe, NewApiInfoRoute } from "../types";
import { PageHeading } from "./PageHeading";

interface InitializationPanelProps {
  preview: boolean;
  serverUrl: string;
  globalBaseUrl: string;
  onGlobalBaseUrlChange: (baseUrl: string) => void;
}

type ProbeResultMap = Record<string, NewApiEndpointProbe>;

function gradeLabel(result: NewApiEndpointProbe): string {
  const grade = latencyGrade(result.latency);
  if (grade === "excellent") return "优秀";
  if (grade === "healthy") return "正常";
  if (grade === "slow") return "较慢";
  return "不可达";
}

export function InitializationPanel({
  preview,
  serverUrl,
  globalBaseUrl,
  onGlobalBaseUrlChange,
}: InitializationPanelProps) {
  const [routes, setRoutes] = useState<NewApiInfoRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [probeResults, setProbeResults] = useState<ProbeResultMap>({});
  const [probeError, setProbeError] = useState<string | null>(null);

  const probeUrls = useMemo(() => uniqueProbeUrls(routes), [routes]);

  const loadRoutes = useCallback(
    async (notify = false) => {
      setLoading(true);
      setFetchError(null);
      try {
        const nextRoutes = preview
          ? previewApiInfoRoutes
          : await newApiApi.getApiInfoRoutes();
        if (!preview) saveCachedApiInfoRoutes(serverUrl, nextRoutes);
        setRoutes(nextRoutes);
        setProbeResults({});
        setProbeError(null);
        if (notify)
          toast.success(`已拉取 ${nextRoutes.length} 条 API 线路配置`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFetchError(message);
        if (notify) toast.error(message);
      } finally {
        setLoading(false);
      }
    },
    [preview, serverUrl],
  );

  useEffect(() => {
    const cachedRoutes = preview
      ? previewApiInfoRoutes
      : loadCachedApiInfoRoutes(serverUrl);
    if (cachedRoutes !== null) {
      setRoutes(cachedRoutes);
      setLoading(false);
      setFetchError(null);
      return;
    }
    void loadRoutes();
  }, [loadRoutes, preview, serverUrl]);

  useEffect(() => {
    if (!routes.length || !globalBaseUrl) return;
    const selectedUrl = normalizeProbeUrl(globalBaseUrl);
    if (!routes.some((route) => normalizeProbeUrl(route.url) === selectedUrl)) {
      onGlobalBaseUrlChange("");
    }
  }, [globalBaseUrl, onGlobalBaseUrlChange, routes]);

  const runNetworkTest = async () => {
    if (!probeUrls.length) {
      toast.info("网站 API 信息中没有可检测的配置 URL");
      return;
    }

    setTesting(true);
    setProbeError(null);
    setProbeResults({});
    try {
      let results: NewApiEndpointProbe[];
      if (preview) {
        await new Promise((resolve) => setTimeout(resolve, 650));
        results = probeUrls.map((url, index) => ({
          url,
          latency: 76 + index * 31,
          status: 200,
          error: null,
        }));
      } else {
        results = await newApiApi.testEndpoints(probeUrls, 6);
      }

      const nextResults = Object.fromEntries(
        results.map((result) => [normalizeProbeUrl(result.url), result]),
      );
      setProbeResults(nextResults);

      const reachableRoutes = routes.filter((route) => {
        const result = nextResults[normalizeProbeUrl(route.url)];
        return typeof result?.latency === "number";
      }).length;
      if (reachableRoutes === routes.length) {
        toast.success(`网络检测完成，${routes.length} 条配置 URL 均可达`);
      } else {
        toast.warning(
          `网络检测完成，${reachableRoutes}/${routes.length} 条配置 URL 可达`,
        );
      }
    } catch (testError) {
      const message =
        testError instanceof Error ? testError.message : String(testError);
      setProbeError(message);
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };

  const selectGlobalRoute = (route: NewApiInfoRoute, index: number) => {
    const baseUrl = normalizeProbeUrl(route.url);
    const result = probeResults[baseUrl];
    if (typeof result?.latency !== "number") {
      toast.info("请先完成网络检测，再选择可达线路");
      return;
    }
    onGlobalBaseUrlChange(baseUrl);
    toast.success(
      `${route.route || route.description || `线路 ${index + 1}`} 已设为全局 Base URL`,
    );
  };

  return (
    <div className="vv-page vv-initialization-page">
      <PageHeading
        className="vv-init-heading"
        eyebrow="连接准备"
        title="API 信息"
        description="管理配置线路，并通过延迟检测选择全局连接。"
        icon={<Globe2 size={20} strokeWidth={1.9} />}
        accent="#6658ee"
        actions={
          <>
            <button
              type="button"
              className="vv-secondary-button"
              disabled={loading || testing}
              onClick={() => void loadRoutes(true)}
            >
              <RefreshCw className={loading ? "vv-spin" : ""} size={15} />
              {loading ? "拉取中" : "重新拉取"}
            </button>
            <button
              type="button"
              className="vv-primary-button"
              disabled={loading || testing || routes.length === 0}
              onClick={() => void runNetworkTest()}
            >
              {testing ? (
                <Loader2 className="vv-spin" size={15} />
              ) : (
                <Activity size={15} />
              )}
              {testing ? "正在检测" : "一键网络检测"}
            </button>
          </>
        }
      />

      {(fetchError || probeError) && (
        <div className="vv-init-alert" role="alert">
          <AlertCircle size={15} />
          <span>{probeError ?? `拉取 API 信息失败：${fetchError}`}</span>
        </div>
      )}

      <section className="vv-api-list-card">
        <header className="vv-api-list-card__header">
          <div>
            <h2>配置 URL</h2>
            <p>已缓存 {routes.length} 条网站线路，重新拉取时才会更新。</p>
          </div>
          <span>{routes.length} 条</span>
        </header>

        {routes.length ? (
          <div className="vv-api-list">
            <div className="vv-api-row vv-api-row--labels">
              <span>线路</span>
              <span>配置 URL</span>
              <span>网络状态</span>
              <span>全局线路</span>
            </div>
            {routes.map((route, index) => {
              const normalizedUrl = normalizeProbeUrl(route.url);
              const result = probeResults[normalizedUrl];
              const grade = result ? latencyGrade(result.latency) : undefined;
              const routeName =
                route.route || route.description || `线路 ${index + 1}`;
              const showDescription =
                route.description && route.description !== routeName;
              const isSelected =
                normalizedUrl === normalizeProbeUrl(globalBaseUrl);
              const canSelect = typeof result?.latency === "number";
              return (
                <div
                  className={`vv-api-row ${isSelected ? "is-selected" : ""}`}
                  key={`${route.id || index}:${normalizedUrl}`}
                >
                  <span className="vv-api-name">
                    <i>
                      <Server size={15} />
                    </i>
                    <span>
                      <strong>{routeName}</strong>
                      {showDescription && <small>{route.description}</small>}
                    </span>
                  </span>
                  <code title={route.url}>{route.url}</code>
                  <span className="vv-api-probe" aria-live="polite">
                    {testing ? (
                      <i className="is-testing">
                        <Loader2 className="vv-spin" size={13} />
                        <span>
                          <strong>检测中</strong>
                          <small>正在连接配置 URL</small>
                        </span>
                      </i>
                    ) : result ? (
                      typeof result.latency === "number" ? (
                        <i className={`is-${grade}`}>
                          <span className="vv-api-probe__dot" />
                          <span>
                            <strong>{Math.round(result.latency)} ms</strong>
                            <small>
                              {gradeLabel(result)}
                              {result.status ? ` · HTTP ${result.status}` : ""}
                            </small>
                          </span>
                        </i>
                      ) : (
                        <i
                          className="is-failed"
                          title={result.error ?? undefined}
                        >
                          <AlertCircle size={13} />
                          <span>
                            <strong>不可达</strong>
                            <small>{result.error || "连接失败"}</small>
                          </span>
                        </i>
                      )
                    ) : (
                      <i className="is-pending">
                        <span className="vv-api-probe__dot" />
                        <span>
                          <strong>未检测</strong>
                          <small>点击一键网络检测</small>
                        </span>
                      </i>
                    )}
                  </span>
                  <button
                    type="button"
                    className={`vv-api-select ${isSelected ? "is-selected" : ""}`}
                    disabled={testing || isSelected || !canSelect}
                    onClick={() => selectGlobalRoute(route, index)}
                    title={
                      isSelected
                        ? "当前全局 Base URL"
                        : canSelect
                          ? `将 ${routeName} 设为全局 Base URL`
                          : "完成网络检测后可选择"
                    }
                  >
                    {isSelected && <Check size={12} />}
                    {isSelected
                      ? "当前使用"
                      : canSelect
                        ? "设为全局"
                        : "检测后选择"}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="vv-init-empty">
            {loading ? (
              <Loader2 className="vv-spin" size={22} />
            ) : (
              <Globe2 size={22} />
            )}
            <strong>{loading ? "正在拉取 API 信息" : "没有配置 URL"}</strong>
            <span>
              {loading
                ? "正在读取网站的 API 信息配置。"
                : "请先在网站的 API 信息中配置线路地址。"}
            </span>
          </div>
        )}

        <footer className="vv-api-list-card__note">
          <Activity size={13} />
          检测后可选择一条可达线路作为全局 Base
          URL；后续获取模型和应用配置都会使用该地址。
        </footer>
      </section>
    </div>
  );
}
