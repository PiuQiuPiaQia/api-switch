import type { OpenCodeModel, Provider } from "@/types";
import { openclawApi } from "@/lib/api/openclaw";
import { providersApi } from "@/lib/api/providers";
import {
  setCodexBaseUrl,
  setCodexModelName,
  setCodexWireApi,
} from "@/utils/providerConfigUtils";
import { PRODUCT } from "./config";
import { dshApi } from "./api";
import type {
  DshApiProtocol,
  DshManagedStatus,
  NewApiConnection,
  NewApiGroup,
  ProductScenario,
} from "./types";
import {
  resolveGroupConnection,
  resolveScenarioBaseUrl,
  type ScenarioApiFormat,
} from "./scenarioConnection";

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

/** Wire protocols Dsh accepts, mapped from the scenario protocol ids. */
export function dshApiMode(
  apiFormat: string | undefined,
): DshApiProtocol | null {
  if (apiFormat === "openai_chat") return "openai-completions";
  if (apiFormat === "openai_responses") return "openai-responses";
  if (apiFormat === "anthropic") return "anthropic-messages";
  return null;
}

/** Inverse of dshApiMode: the scenario protocol behind a Dsh wire protocol. */
export function dshScenarioFormat(api: string | undefined): ScenarioApiFormat {
  if (api === "anthropic-messages") return "anthropic";
  if (api === "openai-responses") return "openai_responses";
  return "openai_chat";
}

/** Dsh's Anthropic SDK appends /v1/messages itself; retain custom prefixes. */
export function resolveDshBaseUrl(baseUrl: string, api: DshApiProtocol): string {
  const resolved = resolveScenarioBaseUrl(baseUrl, undefined, dshScenarioFormat(api));
  if (api !== "anthropic-messages") return resolved;
  try {
    const url = new URL(resolved);
    url.pathname = url.pathname.replace(/\/v1\/?$/, "") || "/";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return resolved;
  }
}

/**
 * Compaction headroom Dsh reserves next to a request's max output tokens
 * (compaction-basic's default headroomTokens).
 */
export const DSH_OUTPUT_HEADROOM = 65_536;

/**
 * Protect a Dsh model's output limit from vendor figures that eat the whole
 * context window: Dsh reserves maxTokens plus headroom before deciding to
 * compact, so a reply limit near the window leaves it nothing to compact
 * with. Only when a real context figure exists is the vendor/user output
 * limit held to min(output, max(1, max(window/4, window/2 - 65536))); without
 * context numbers nothing is invented and the given limit stays as entered.
 */
export function protectedDshOutputLimit(
  context: number | undefined,
  output: number | undefined,
): number | undefined {
  const hasContext =
    typeof context === "number" && Number.isFinite(context) && context > 0;
  const hasOutput =
    typeof output === "number" && Number.isFinite(output) && output > 0;

  if (!hasContext) return hasOutput ? Math.floor(output) : undefined;

  const room = Math.max(
    1,
    Math.floor(Math.max(context / 4, context / 2 - DSH_OUTPUT_HEADROOM)),
  );
  return hasOutput ? Math.min(Math.floor(output), room) : room;
}

/** Parse a positive finite number from user input; anything else is ignored. */
export function parsePositiveLimit(value: string | number): number | undefined {
  const raw = typeof value === "number" ? value : value.trim();
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/** Model rows edited by the Dsh managed-provider form. */
export interface DshModelDraft {
  id: string;
  name: string;
  context: string | number;
  output: string | number;
}

function cleanDshText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim()
    : "";
}

/**
 * Apply the Dsh form state to a managed provider: one explicit wire protocol
 * for every model, a sanitized model catalog with optional context/output
 * limits (output protected against window-eating figures), and an optional
 * default model that must exist in the catalog.
 */
export function applyDshManagedSettings(
  provider: Provider,
  api: string,
  models: DshModelDraft[],
  defaultModel: string,
): Provider {
  const protocol = dshApiMode(api) ?? (isDshApiProtocol(api) ? api : null);
  if (!protocol) {
    throw new Error("请先为 Dsh 托管供应商选择模型协议");
  }

  const settingsConfig = asRecord(provider.settingsConfig);
  const options = asRecord(settingsConfig.options);
  const apiKey = typeof options.apiKey === "string" ? options.apiKey : "";
  const rawBaseUrl = typeof options.baseURL === "string" ? options.baseURL : "";
  const scenarioFormat = dshScenarioFormat(protocol);

  const catalog: Record<string, OpenCodeModel> = {};
  for (const draft of models) {
    const id = cleanDshText(draft.id);
    if (!id) continue;
    const context = parsePositiveLimit(draft.context);
    const output = parsePositiveLimit(draft.output);
    const protectedOutput = protectedDshOutputLimit(context, output);
    const entry: OpenCodeModel = { name: cleanDshText(draft.name) || id };
    if (context !== undefined || protectedOutput !== undefined) {
      entry.limit = {
        ...(context !== undefined ? { context } : {}),
        ...(protectedOutput !== undefined ? { output: protectedOutput } : {}),
      };
    }
    catalog[id] = entry;
  }

  const normalizedDefault = cleanDshText(defaultModel);
  if (normalizedDefault && !(normalizedDefault in catalog)) {
    throw new Error("默认模型不在模型列表中，请先添加该模型或清空默认值");
  }

  const previousName = cleanDshText(settingsConfig.name);
  const nextSettings: Record<string, unknown> = {
    ...(previousName ? { name: previousName } : {}),
    api: protocol,
    options: {
      baseURL: resolveDshBaseUrl(rawBaseUrl, protocol),
      apiKey,
    },
    models: catalog,
  };
  if (normalizedDefault) nextSettings.defaultModel = normalizedDefault;

  return {
    ...provider,
    settingsConfig: nextSettings,
    meta: {
      ...provider.meta,
      apiFormat: scenarioFormat,
    },
  };
}

export function isDshApiProtocol(value: unknown): value is DshApiProtocol {
  return (
    value === "openai-completions" ||
    value === "openai-responses" ||
    value === "anthropic-messages"
  );
}

/**
 * Validate a Dsh managed settings payload before it reaches the dedicated
 * backend command. The backend re-validates; this keeps form errors local.
 */
export function validateDshManagedSettings(
  settingsConfig: Record<string, unknown>,
): asserts settingsConfig is {
  api: DshApiProtocol;
  options: { baseURL: string; apiKey: string };
  models: Record<string, OpenCodeModel>;
  defaultModel?: string;
} {
  if (!isDshApiProtocol(settingsConfig.api)) {
    throw new Error("Dsh 托管配置缺少有效的模型协议");
  }
  const options = asRecord(settingsConfig.options);
  if (
    typeof options.baseURL !== "string" ||
    !options.baseURL.trim() ||
    typeof options.apiKey !== "string" ||
    !options.apiKey.trim()
  ) {
    throw new Error("Dsh 托管配置缺少可用的 Base URL 或访问密钥");
  }
  const models = asRecord(settingsConfig.models);
  for (const [id, value] of Object.entries(models)) {
    if (!id.trim()) throw new Error("Dsh 模型列表包含空模型 ID");
    const model = asRecord(value);
    const limit = asRecord(model.limit);
    for (const field of ["context", "output"] as const) {
      const limitValue = limit[field];
      if (limitValue === undefined) continue;
      if (
        typeof limitValue !== "number" ||
        !Number.isFinite(limitValue) ||
        limitValue <= 0
      ) {
        throw new Error(`Dsh 模型 ${id} 的 ${field} 上限必须是有效正数`);
      }
    }
  }
  const defaultModel = settingsConfig.defaultModel;
  if (
    defaultModel !== undefined &&
    (typeof defaultModel !== "string" ||
      (defaultModel.trim() && !(defaultModel.trim() in models)))
  ) {
    throw new Error("Dsh 默认模型不在模型列表中");
  }
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

    case "dsh": {
      const previousSettings = asRecord(previous?.settingsConfig);
      // The website group API never states a protocol, so only an explicit
      // connection format (or the user's persisted choice) picks one; a
      // rebuild must never guess over the user's saved protocol.
      const api = isDshApiProtocol(previousSettings.api)
        ? previousSettings.api
        : dshApiMode(connection.apiFormat);
      const settingsConfig: Record<string, unknown> = {
        ...previousSettings,
        options: {
          ...asRecord(previousSettings.options),
          baseURL: api
            ? resolveDshBaseUrl(connection.baseUrl, api)
            : connection.baseUrl,
          apiKey: connection.apiKey,
        },
        models: asRecord(previousSettings.models),
      };
      if (api) settingsConfig.api = api;
      else delete settingsConfig.api;
      if (typeof previousSettings.defaultModel === "string") {
        settingsConfig.defaultModel = previousSettings.defaultModel;
      }

      return {
        ...common,
        settingsConfig,
        meta: {
          ...common.meta,
          ...(api ? { apiFormat: dshScenarioFormat(api) } : {}),
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

/**
 * Apply a Dsh managed provider through the dedicated backend command. Dsh
 * profiles live in ~/.dsh and the backend owns multi-profile writes, desktop
 * conflicts, credentials, and rollback — this must never fall back to the
 * generic providers add/switch path.
 */
export async function applyDshManagedConfiguration(
  provider: Provider,
): Promise<DshManagedStatus> {
  if (provider.id !== PRODUCT.managedProviderId) {
    throw new Error("托管供应商标识无效，未写入本机配置");
  }
  const settingsConfig = asRecord(provider.settingsConfig);
  validateDshManagedSettings(settingsConfig);
  validateManagedConnection({
    baseUrl: asRecord(settingsConfig.options).baseURL as string,
    apiKey: asRecord(settingsConfig.options).apiKey as string,
    apiFormat: settingsConfig.api as string,
  });

  return await dshApi.applyManagedProvider(provider);
}
