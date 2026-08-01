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
  applyManagedDefaultModel,
  applyOpenCodeModelCatalog,
  resolveGroupConnection,
  type ClaudeCoreModelRoutes,
} from "../configuration";
import type { NewApiGroup, ProductScenario } from "../types";

interface ManagedProviderCoreFormProps {
  formId: string;
  scenario: ProductScenario;
  group: NewApiGroup;
  provider: Provider;
  hasApiKey: boolean;
  onSubmit: (provider: Provider) => Promise<void> | void;
}

interface OpenCodeModelRow {
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

function openCodeRowsFromProvider(provider: Provider): OpenCodeModelRow[] {
  const models = asRecord(asRecord(provider.settingsConfig).models);
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
  provider,
  hasApiKey,
  onSubmit,
}: ManagedProviderCoreFormProps) {
  const { t } = useTranslation();
  const connection = resolveGroupConnection(scenario, group);
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
  const [openCodeModels, setOpenCodeModels] = useState<OpenCodeModelRow[]>(() =>
    openCodeRowsFromProvider(provider),
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
    } else if (scenario.id === "opencode") {
      next = applyOpenCodeModelCatalog(provider, openCodeModels);
    }
    void onSubmit(next);
  };

  const updateRoute = (role: keyof ClaudeCoreModelRoutes, value: string) => {
    setClaudeRoutes((current) => ({ ...current, [role]: value }));
  };

  const updateOpenCodeModel = (
    rowId: string,
    field: "id" | "name",
    value: string,
  ) => {
    setOpenCodeModels((current) =>
      current.map((row) =>
        row.rowId === rowId ? { ...row, [field]: value } : row,
      ),
    );
  };

  return (
    <form id={formId} className="vv-core-provider-form" onSubmit={handleSubmit}>
      <div className="vv-core-routes">
        <div className="vv-core-routes__heading">
          <strong>模型配置</strong>
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

        {scenario.id === "opencode" && (
          <div className="vv-core-opencode-models">
            {openCodeModels.length === 0 ? (
              <p className="vv-core-empty-models">暂不限制模型列表。</p>
            ) : (
              openCodeModels.map((row) => (
                <div key={row.rowId} className="vv-core-opencode-row">
                  <div className="vv-core-opencode-model-id">
                    <input
                      value={row.id}
                      onChange={(event) =>
                        updateOpenCodeModel(row.rowId, "id", event.target.value)
                      }
                      placeholder="模型 ID"
                      autoComplete="off"
                    />
                    {fetchedModels.length > 0 && (
                      <ModelDropdown
                        models={fetchedModels}
                        onSelect={(id) =>
                          updateOpenCodeModel(row.rowId, "id", id)
                        }
                      />
                    )}
                  </div>
                  <input
                    value={row.name}
                    onChange={(event) =>
                      updateOpenCodeModel(row.rowId, "name", event.target.value)
                    }
                    placeholder="显示名称（可选）"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="vv-core-opencode-remove"
                    aria-label={`删除模型 ${row.id || "空白"}`}
                    onClick={() =>
                      setOpenCodeModels((current) =>
                        current.filter((item) => item.rowId !== row.rowId),
                      )
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            )}
            <button
              type="button"
              className="vv-core-add-model"
              onClick={() =>
                setOpenCodeModels((current) => [
                  ...current,
                  { rowId: `new-${Date.now()}`, id: "", name: "" },
                ])
              }
            >
              <Plus size={14} /> 添加模型
            </button>
          </div>
        )}
      </div>
    </form>
  );
}
