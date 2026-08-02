import { useCallback, useState, type FormEvent } from "react";
import { Download, Loader2, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ModelDropdown,
  ModelInputWithFetch,
} from "@/components/providers/forms/shared";
import type { Provider } from "@/types";
import {
  fetchModelsForConfig,
  showFetchModelsError,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import { extractCodexModelName } from "@/utils/providerConfigUtils";
import {
  applyClaudeCoreModelRoutes,
  applyAgentModelCatalog,
  applyManagedDefaultModel,
  resolveGroupConnection,
  type ClaudeCoreModelRoutes,
} from "../configuration";
import type { NewApiGroup, ProductScenario } from "../types";

interface ManagedProviderCoreFormProps {
  formId: string;
  scenario: ProductScenario;
  group: NewApiGroup;
  globalBaseUrl?: string;
  provider: Provider;
  hasApiKey: boolean;
  onSubmit: (provider: Provider) => Promise<void> | void;
}

interface AgentModelRow {
  rowId: string;
  id: string;
  name: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function exactEnvValue(provider: Provider, field: string): string {
  const env = asRecord(asRecord(provider.settingsConfig).env);
  return typeof env[field] === "string" ? env[field].trim() : "";
}

function defaultModelFromProvider(
  scenario: ProductScenario,
  provider: Provider,
): string {
  const settingsConfig = asRecord(provider.settingsConfig);
  if (scenario.id === "codex") {
    return typeof settingsConfig.config === "string"
      ? (extractCodexModelName(settingsConfig.config) ?? "")
      : "";
  }
  if (scenario.id === "gemini") {
    return exactEnvValue(provider, "GEMINI_MODEL");
  }
  return "";
}

function agentRowsFromProvider(
  scenario: ProductScenario,
  provider: Provider,
): AgentModelRow[] {
  const rawModels = asRecord(provider.settingsConfig).models;
  if (scenario.id === "openclaw" || scenario.id === "hermes") {
    return Array.isArray(rawModels)
      ? rawModels.flatMap((value, index) => {
          const model = asRecord(value);
          const id = typeof model.id === "string" ? model.id : "";
          if (!id) return [];
          return [
            {
              rowId: `existing-${index}-${id}`,
              id,
              name: typeof model.name === "string" ? model.name : id,
            },
          ];
        })
      : [];
  }

  const models = asRecord(rawModels);
  return Object.entries(models).map(([id, value], index) => {
    const model = asRecord(value);
    return {
      rowId: `existing-${index}-${id}`,
      id,
      name: typeof model.name === "string" ? model.name : id,
    };
  });
}

export function ManagedProviderCoreForm({
  formId,
  scenario,
  group,
  globalBaseUrl = "",
  provider,
  hasApiKey,
  onSubmit,
}: ManagedProviderCoreFormProps) {
  const { t } = useTranslation();
  const connection = resolveGroupConnection(scenario, group, globalBaseUrl);
  const [claudeRoutes, setClaudeRoutes] = useState<ClaudeCoreModelRoutes>(
    () => ({
      sonnet: exactEnvValue(provider, "ANTHROPIC_DEFAULT_SONNET_MODEL"),
      opus: exactEnvValue(provider, "ANTHROPIC_DEFAULT_OPUS_MODEL"),
      haiku: exactEnvValue(provider, "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
    }),
  );
  const [defaultModel, setDefaultModel] = useState(() =>
    defaultModelFromProvider(scenario, provider),
  );
  const [agentModels, setAgentModels] = useState<AgentModelRow[]>(() =>
    agentRowsFromProvider(scenario, provider),
  );
  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);

  const handleFetchModels = useCallback(() => {
    if (!connection.baseUrl || !connection.apiKey) {
      showFetchModelsError(null, t, {
        hasApiKey: Boolean(connection.apiKey),
        hasBaseUrl: Boolean(connection.baseUrl),
      });
      return;
    }

    setIsFetchingModels(true);
    fetchModelsForConfig(connection.baseUrl, connection.apiKey)
      .then((models) => {
        setFetchedModels(models);
        if (models.length === 0) {
          toast.info(t("providerForm.fetchModelsEmpty"));
        } else {
          toast.success(
            t("providerForm.fetchModelsSuccess", { count: models.length }),
          );
        }
      })
      .catch((error) => {
        console.warn("[VV Code] Failed to fetch provider models:", error);
        showFetchModelsError(error, t);
      })
      .finally(() => setIsFetchingModels(false));
  }, [connection.apiKey, connection.baseUrl, t]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let next = provider;
    if (scenario.id === "claude") {
      next = applyClaudeCoreModelRoutes(provider, claudeRoutes);
    } else if (scenario.id === "codex" || scenario.id === "gemini") {
      next = applyManagedDefaultModel(scenario, provider, defaultModel);
    } else if (
      scenario.id === "opencode" ||
      scenario.id === "openclaw" ||
      scenario.id === "hermes"
    ) {
      next = applyAgentModelCatalog(scenario, provider, agentModels);
    }
    void onSubmit(next);
  };

  const updateRoute = (role: keyof ClaudeCoreModelRoutes, value: string) => {
    setClaudeRoutes((current) => ({ ...current, [role]: value }));
  };

  const updateAgentModel = (
    rowId: string,
    field: "id" | "name",
    value: string,
  ) => {
    setAgentModels((current) =>
      current.map((row) =>
        row.rowId === rowId ? { ...row, [field]: value } : row,
      ),
    );
  };

  const addAgentModel = () => {
    const row = { rowId: `new-${crypto.randomUUID()}`, id: "", name: "" };
    setAgentModels((current) => [...current, row]);
  };

  const removeAgentModel = (rowId: string) => {
    setAgentModels((current) => current.filter((item) => item.rowId !== rowId));
  };

  return (
    <form id={formId} className="vv-core-provider-form" onSubmit={handleSubmit}>
      <div className="vv-core-routes">
        <div className="vv-core-routes__heading">
          <span className="vv-core-routes__title">
            <strong>
              {scenario.id === "claude-desktop" ? "客户端配置" : "模型配置"}
            </strong>
            <small title={connection.baseUrl}>
              Base URL · {connection.baseUrl}
            </small>
          </span>
          <div className="vv-core-routes__actions">
            {scenario.id !== "claude-desktop" && (
              <button
                type="button"
                onClick={handleFetchModels}
                disabled={isFetchingModels || !hasApiKey}
                className="vv-core-fetch-button"
              >
                {isFetchingModels ? (
                  <Loader2 className="vv-spin" size={14} />
                ) : (
                  <Download size={14} />
                )}
                {isFetchingModels ? "正在获取" : "获取模型"}
              </button>
            )}
            {(scenario.id === "opencode" ||
              scenario.id === "openclaw" ||
              scenario.id === "hermes") && (
              <button type="button" onClick={addAgentModel}>
                <Plus size={14} /> 添加模型
              </button>
            )}
          </div>
        </div>

        {scenario.id === "claude" && (
          <div className="vv-core-routes__grid">
            {(
              [
                ["sonnet", "Sonnet"],
                ["opus", "Opus"],
                ["haiku", "Haiku"],
              ] as const
            ).map(([role, label]) => (
              <label key={role}>
                <span>{label}</span>
                <div className="vv-core-model-control">
                  <ModelInputWithFetch
                    id={`${formId}-${role}-model`}
                    value={claudeRoutes[role]}
                    onChange={(value) => updateRoute(role, value)}
                    placeholder="留空则不覆盖"
                    fetchedModels={fetchedModels}
                    isLoading={isFetchingModels}
                  />
                </div>
              </label>
            ))}
          </div>
        )}

        {scenario.id === "claude-desktop" && (
          <p className="vv-core-model-order-hint">
            配置后请重启 Claude Desktop。
          </p>
        )}

        {(scenario.id === "codex" || scenario.id === "gemini") && (
          <label className="vv-core-default-model">
            <span>默认模型</span>
            <div className="vv-core-model-control">
              <ModelInputWithFetch
                id={`${formId}-default-model`}
                value={defaultModel}
                onChange={setDefaultModel}
                placeholder="留空则不覆盖"
                fetchedModels={fetchedModels}
                isLoading={isFetchingModels}
              />
            </div>
          </label>
        )}

        {(scenario.id === "opencode" ||
          scenario.id === "openclaw" ||
          scenario.id === "hermes") && (
          <div className="vv-core-opencode-models">
            <div className="vv-core-model-list-heading">
              <span>模型 ID</span>
              <span>显示名称（可选）</span>
            </div>
            {agentModels.length === 0 ? (
              <p className="vv-core-empty-models">
                暂无模型配置。点击“添加模型”来配置可用模型。
              </p>
            ) : (
              agentModels.map((row, index) => (
                <div
                  key={row.rowId}
                  className={
                    scenario.id === "openclaw" || scenario.id === "hermes"
                      ? "vv-core-agent-model-card"
                      : undefined
                  }
                >
                  {(scenario.id === "openclaw" || scenario.id === "hermes") && (
                    <span
                      className={`vv-core-model-role ${index === 0 ? "is-primary" : ""}`}
                    >
                      {index === 0
                        ? "默认模型"
                        : scenario.id === "openclaw"
                          ? "回退模型"
                          : "备选模型"}
                    </span>
                  )}
                  <div className="vv-core-opencode-row">
                    <div className="vv-core-opencode-model-id">
                      <input
                        value={row.id}
                        onChange={(event) =>
                          updateAgentModel(row.rowId, "id", event.target.value)
                        }
                        placeholder="模型 ID"
                        autoComplete="off"
                      />
                      {fetchedModels.length > 0 && (
                        <ModelDropdown
                          models={fetchedModels}
                          onSelect={(id) =>
                            updateAgentModel(row.rowId, "id", id)
                          }
                        />
                      )}
                    </div>
                    <input
                      value={row.name}
                      onChange={(event) =>
                        updateAgentModel(row.rowId, "name", event.target.value)
                      }
                      placeholder="显示名称（可选）"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="vv-core-opencode-remove"
                      aria-label={`删除模型 ${row.id || "空白"}`}
                      onClick={() => removeAgentModel(row.rowId)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}
            {(scenario.id === "openclaw" || scenario.id === "hermes") &&
              agentModels.length > 0 && (
                <p className="vv-core-model-order-hint">
                  列表第一项为默认模型，后续模型按顺序作为
                  {scenario.id === "openclaw" ? "回退模型" : "备选模型"}。
                </p>
              )}
          </div>
        )}
      </div>
    </form>
  );
}
