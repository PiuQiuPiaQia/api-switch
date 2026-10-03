import type { Provider } from "@/types";
import { openclawApi } from "@/lib/api/openclaw";
import { providersApi } from "@/lib/api/providers";
import {
  setCodexBaseUrl,
  setCodexModelName,
  setCodexWireApi,
} from "@/utils/providerConfigUtils";
import { PRODUCT } from "./config";
import type { NewApiConnection, NewApiGroup, ProductScenario } from "./types";
import { resolveGroupConnection } from "./scenarioConnection";

export { resolveGroupConnection } from "./scenarioConnection";

export function validateManagedConnection(connection: NewApiConnection): void {
  if (!connection.baseUrl || !connection.apiKey) {
    throw new Error("当前分组尚未准备好 Base URL 或专属密钥");
  }

  let url: URL;
  try {
    url = new URL(connection.baseUrl);
  } catch {
    throw new Error("当前分组的 Base URL 格式无效");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("当前分组的 Base URL 必须是安全的 HTTP(S) 地址");
  }
  if (url.search || url.hash) {
    throw new Error("当前分组的 Base URL 不得包含查询参数或片段");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !loopback) {
    throw new Error("生产环境的分组 Base URL 必须使用 HTTPS");
  }
}

export function managedProviderName(group: NewApiGroup): string {
  return `${PRODUCT.brand.name} · ${group.name}`;
}

export interface ClaudeCoreModelRoutes {
  sonnet: string;
  opus: string;
  haiku: string;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function matchingManagedProvider(
  provider: Provider | null | undefined,
  group: NewApiGroup,
): Provider | undefined {
  return provider?.id === PRODUCT.managedProviderId &&
    provider.name === managedProviderName(group)
    ? provider
    : undefined;
}

function codexAuth(apiKey: string): Record<string, string> {
  return { OPENAI_API_KEY: apiKey };
}

function codexConfig(
  providerName: string,
  baseUrl: string,
  wireApi: "responses" | "chat",
): string {
  const tomlString = (value: string) => JSON.stringify(value);
  return `model_provider = "custom"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.custom]
name = ${tomlString(providerName)}
base_url = ${tomlString(baseUrl)}
wire_api = ${tomlString(wireApi)}
requires_openai_auth = true`;
}

function openClawApiMode(apiFormat: string | undefined): string {
  if (apiFormat === "anthropic") return "anthropic-messages";
  if (apiFormat === "gemini_native") return "google-generative-ai";
  if (apiFormat === "openai_responses") return "openai-responses";
  return "openai-completions";
}

function hermesApiMode(apiFormat: string | undefined): string {
  if (apiFormat === "anthropic") return "anthropic_messages";
  if (apiFormat === "openai_responses") return "codex_responses";
  return "chat_completions";
}

export function buildManagedProvider(
  scenario: ProductScenario,
  group: NewApiGroup,
  existingProvider?: Provider | null,
  globalBaseUrl?: string,
): Provider {
  const name = managedProviderName(group);
  const connection = resolveGroupConnection(scenario, group, globalBaseUrl);
  const previous = matchingManagedProvider(existingProvider, group);
  const previousMeta = previous?.meta ?? {};
  const previousEndpoints = previousMeta.custom_endpoints ?? {};
  const common = {
    id: PRODUCT.managedProviderId,
    name,
    category: "aggregator" as const,
    notes: `由 ${PRODUCT.brand.name} 自动管理 · 分组 ${group.name}`,
    icon: "custom",
    iconColor: scenario.accent,
    websiteUrl: previous?.websiteUrl,
    meta: {
      ...previousMeta,
      endpointAutoSelect: previousMeta.endpointAutoSelect ?? false,
      custom_endpoints: {
        ...previousEndpoints,
        [connection.baseUrl]: {
          url: connection.baseUrl,
          addedAt: previousEndpoints[connection.baseUrl]?.addedAt ?? Date.now(),
        },
      },
    },
  } satisfies Omit<Provider, "settingsConfig">;

  switch (scenario.id) {
    case "claude": {
      const previousSettings = asRecord(previous?.settingsConfig);
      const env = { ...asRecord(previousSettings.env) };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      env.ANTHROPIC_BASE_URL = connection.baseUrl;
      env.ANTHROPIC_AUTH_TOKEN = connection.apiKey;

      return {
        ...common,
        settingsConfig: {
          ...previousSettings,
          env,
        },
        meta: {
          ...common.meta,
          apiFormat: "anthropic",
          apiKeyField: "ANTHROPIC_AUTH_TOKEN",
        },
      };
    }

    case "claude-desktop": {
      const previousSettings = asRecord(previous?.settingsConfig);
      const env = { ...asRecord(previousSettings.env) };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      env.ANTHROPIC_BASE_URL = connection.baseUrl;
      env.ANTHROPIC_AUTH_TOKEN = connection.apiKey;

      return {
        ...common,
        settingsConfig: {
          ...previousSettings,
          env,
        },
        meta: {
          ...common.meta,
          endpointAutoSelect: undefined,
          apiFormat: "anthropic",
          apiKeyField: "ANTHROPIC_AUTH_TOKEN",
          claudeDesktopMode: "direct",
          claudeDesktopModelRoutes: {},
        },
      };
    }

    case "codex": {
      const previousSettings = asRecord(previous?.settingsConfig);
      const previousConfig =
        typeof previousSettings.config === "string"
          ? previousSettings.config
          : codexConfig(
              PRODUCT.brand.name,
              connection.baseUrl,
              connection.apiFormat === "openai_chat" ? "chat" : "responses",
            );
      const rebasedConfig = setCodexWireApi(
        setCodexBaseUrl(previousConfig, connection.baseUrl),
        connection.apiFormat === "openai_chat" ? "chat" : "responses",
      );

      return {
        ...common,
        settingsConfig: {
          ...previousSettings,
          auth: {
            ...asRecord(previousSettings.auth),
            ...codexAuth(connection.apiKey),
          },
          config: rebasedConfig,
          modelCatalog: previousSettings.modelCatalog ?? { models: [] },
        },
        meta: {
          ...common.meta,
          apiFormat:
            connection.apiFormat === "openai_chat"
              ? "openai_chat"
              : "openai_responses",
        },
      };
    }

    case "gemini": {
      const previousSettings = asRecord(previous?.settingsConfig);
      return {
        ...common,
        settingsConfig: {
          ...previousSettings,
          env: {
            ...asRecord(previousSettings.env),
            GOOGLE_GEMINI_BASE_URL: connection.baseUrl,
            GEMINI_API_KEY: connection.apiKey,
          },
          config: asRecord(previousSettings.config),
        },
      };
    }

    case "opencode": {
      const provider =
        `${connection.apiFormat ?? ""} ${group.apiProvider} ${group.ccProvider}`.toLowerCase();
      const npm = provider.includes("anthropic")
        ? "@ai-sdk/anthropic"
        : "@ai-sdk/openai-compatible";
      const previousSettings = asRecord(previous?.settingsConfig);
      return {
        ...common,
        settingsConfig: {
          ...previousSettings,
          npm: previousSettings.npm ?? npm,
          name: previousSettings.name ?? PRODUCT.brand.name,
          options: {
            ...asRecord(previousSettings.options),
            baseURL: connection.baseUrl,
            apiKey: connection.apiKey,
            setCacheKey: previousSettings.options?.setCacheKey ?? true,
          },
          models: asRecord(previousSettings.models),
        },
      };
    }

    case "openclaw": {
      const previousSettings = asRecord(previous?.settingsConfig);
      return {
        ...common,
        settingsConfig: {
          ...previousSettings,
          baseUrl: connection.baseUrl,
          apiKey: connection.apiKey,
          api: openClawApiMode(connection.apiFormat),
          models: Array.isArray(previousSettings.models)
            ? previousSettings.models
            : [],
        },
      };
    }

    case "hermes": {
      const previousSettings = asRecord(previous?.settingsConfig);
      return {
        ...common,
        settingsConfig: {
          ...previousSettings,
          name:
            typeof previousSettings.name === "string"
              ? previousSettings.name
              : PRODUCT.managedProviderId,
          base_url: connection.baseUrl,
          api_key: connection.apiKey,
          api_mode: hermesApiMode(connection.apiFormat),
          models: Array.isArray(previousSettings.models)
            ? previousSettings.models
            : [],
        },
      };
    }
  }
}

export function applyClaudeCoreModelRoutes(
  provider: Provider,
  routes: ClaudeCoreModelRoutes,
): Provider {
  const settingsConfig = asRecord(provider.settingsConfig);
  const env = { ...asRecord(settingsConfig.env) };
  const routeFields = [
    [
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
      routes.sonnet,
    ],
    [
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
      routes.opus,
    ],
    [
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
      routes.haiku,
    ],
  ] as const;

  for (const [modelField, nameField, value] of routeFields) {
    const previousModel =
      typeof env[modelField] === "string" ? env[modelField].trim() : "";
    const previousName =
      typeof env[nameField] === "string" ? env[nameField].trim() : "";
    const shouldSyncName = !previousName || previousName === previousModel;
    const modelId = value.trim();
    if (modelId) {
      env[modelField] = modelId;
      if (shouldSyncName) env[nameField] = modelId;
    } else {
      delete env[modelField];
      if (shouldSyncName) delete env[nameField];
    }
  }

  return {
    ...provider,
    settingsConfig: {
      ...settingsConfig,
      env,
    },
    meta: {
      ...provider.meta,
      apiFormat: "anthropic",
      apiKeyField: "ANTHROPIC_AUTH_TOKEN",
    },
  };
}

export function applyManagedDefaultModel(
  scenario: ProductScenario,
  provider: Provider,
  model: string,
): Provider {
  const normalized = model.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const settingsConfig = asRecord(provider.settingsConfig);

  if (scenario.id === "codex") {
    const config =
      typeof settingsConfig.config === "string" ? settingsConfig.config : "";
    return {
      ...provider,
      settingsConfig: {
        ...settingsConfig,
        config: setCodexModelName(config, normalized),
      },
    };
  }

  if (scenario.id === "gemini") {
    const env = { ...asRecord(settingsConfig.env) };
    if (normalized) env.GEMINI_MODEL = normalized;
    else delete env.GEMINI_MODEL;
    return {
      ...provider,
      settingsConfig: { ...settingsConfig, env },
    };
  }

  return provider;
}

export function applyOpenCodeModelCatalog(
  provider: Provider,
  models: Array<{ id: string; name: string }>,
): Provider {
  const settingsConfig = asRecord(provider.settingsConfig);
  const normalized = Object.fromEntries(
    models
      .map((model) => ({
        id: model.id.replace(/[\u0000-\u001f\u007f]/g, "").trim(),
        name: model.name.trim(),
      }))
      .filter((model) => model.id)
      .map((model) => [model.id, { name: model.name || model.id }]),
  );

  return {
    ...provider,
    settingsConfig: {
      ...settingsConfig,
      models: normalized,
    },
  };
}

export function applyAgentModelCatalog(
  scenario: ProductScenario,
  provider: Provider,
  models: Array<{ id: string; name: string }>,
): Provider {
  if (scenario.id === "opencode") {
    return applyOpenCodeModelCatalog(provider, models);
  }

  const settingsConfig = asRecord(provider.settingsConfig);
  const normalized = models
    .map((model) => ({
      id: model.id.replace(/[\u0000-\u001f\u007f]/g, "").trim(),
      name: model.name.trim(),
    }))
    .filter((model) => model.id)
    .map((model) => ({ id: model.id, name: model.name || model.id }));

  return {
    ...provider,
    settingsConfig: {
      ...settingsConfig,
      models: normalized,
    },
  };
}

export async function applyManagedConfiguration(
  scenario: ProductScenario,
  group: NewApiGroup,
  globalBaseUrl?: string,
): Promise<void> {
  const next = buildManagedProvider(scenario, group, null, globalBaseUrl);
  await applyPreparedManagedConfiguration(scenario, group, next, globalBaseUrl);
}

export async function applyPreparedManagedConfiguration(
  scenario: ProductScenario,
  group: NewApiGroup,
  next: Provider,
  globalBaseUrl?: string,
): Promise<void> {
  validateManagedConnection(
    resolveGroupConnection(scenario, group, globalBaseUrl),
  );
  if (next.id !== PRODUCT.managedProviderId) {
    throw new Error("托管供应商标识无效，未写入本机配置");
  }

  const providers = await providersApi.getAll(scenario.appId);
  const existing = providers[next.id];

  if (existing) {
    await providersApi.update(
      {
        ...next,
        createdAt: existing.createdAt,
        sortIndex: existing.sortIndex,
        meta: { ...existing.meta, ...next.meta },
      },
      scenario.appId,
      existing.id,
    );
  } else {
    await providersApi.add(next, scenario.appId, true);
  }

  if (scenario.appId !== "opencode") {
    await providersApi.switch(next.id, scenario.appId);
  }

  if (scenario.appId === "openclaw") {
    const models = Array.isArray(next.settingsConfig.models)
      ? next.settingsConfig.models.filter(
          (model: unknown): model is { id: string; name?: string } =>
            Boolean(
              model &&
                typeof model === "object" &&
                typeof (model as { id?: unknown }).id === "string" &&
                (model as { id: string }).id.trim(),
            ),
        )
      : [];
    if (models.length > 0) {
      const modelCatalog = await openclawApi.getModelCatalog();
      await openclawApi.setModelCatalog({
        ...(modelCatalog ?? {}),
        ...Object.fromEntries(
          models.map((model) => [
            `${next.id}/${model.id}`,
            { alias: model.name || model.id },
          ]),
        ),
      });
      await openclawApi.setDefaultModel({
        primary: `${next.id}/${models[0].id}`,
        fallbacks: models.slice(1).map((model) => `${next.id}/${model.id}`),
      });
    }
  }
}
