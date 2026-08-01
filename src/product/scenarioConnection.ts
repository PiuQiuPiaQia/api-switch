import type { NewApiConnection, NewApiGroup, ProductScenario } from "./types";

type ScenarioApiFormat =
  | "anthropic"
  | "openai_chat"
  | "openai_responses"
  | "gemini_native";

function canonicalApiFormat(
  value: string | undefined,
): ScenarioApiFormat | null {
  const normalized = value?.trim().toLowerCase().replace(/-/g, "_");
  if (
    normalized === "anthropic" ||
    normalized === "anthropic_messages" ||
    normalized === "messages" ||
    normalized === "claude"
  ) {
    return "anthropic";
  }
  if (
    normalized === "openai_chat" ||
    normalized === "openai_chat_completions" ||
    normalized === "chat" ||
    normalized === "chat_completions"
  ) {
    return "openai_chat";
  }
  if (normalized === "openai_responses" || normalized === "responses") {
    return "openai_responses";
  }
  if (
    normalized === "gemini_native" ||
    normalized === "gemini" ||
    normalized === "google_gemini"
  ) {
    return "gemini_native";
  }
  return null;
}

function inferredApiFormat(
  scenario: ProductScenario,
  group: NewApiGroup,
  connection: NewApiConnection,
): ScenarioApiFormat {
  const explicit = canonicalApiFormat(connection.apiFormat);
  if (explicit) return explicit;

  if (scenario.id === "claude") return "anthropic";
  if (scenario.id === "codex") return "openai_responses";
  if (scenario.id === "gemini") return "gemini_native";

  const provider = `${group.apiProvider} ${group.ccProvider}`.toLowerCase();
  if (provider.includes("anthropic")) return "anthropic";
  if (provider.includes("gemini") || provider.includes("google")) {
    return "gemini_native";
  }
  return "openai_chat";
}

function defaultPath(apiFormat: ScenarioApiFormat): string {
  return apiFormat === "openai_chat" || apiFormat === "openai_responses"
    ? "/v1"
    : "";
}

function normalizedPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "/" ? "" : trimmed;
}

function joinPaths(prefix: string, suffix: string): string {
  const left = normalizedPath(prefix);
  const right = normalizedPath(suffix);
  if (!left) return right || "/";
  if (!right || left === right || left.endsWith(right)) return left;
  return `${left}/${right.replace(/^\/+/, "")}`;
}

/**
 * Rebase a scenario-specific inference URL onto the user-selected route.
 *
 * The selected route chooses the network origin (and may contain a shared
 * prefix). The connection returned by bootstrap remains the source of truth
 * for protocol-specific paths. When both are origin-only, OpenAI-compatible
 * scenarios receive the conventional `/v1` base path.
 */
export function resolveScenarioBaseUrl(
  connectionBaseUrl: string,
  routeBaseUrl: string | undefined,
  apiFormat: ScenarioApiFormat,
): string {
  const connectionText = connectionBaseUrl.trim().replace(/\/+$/, "");
  const routeText = routeBaseUrl?.trim().replace(/\/+$/, "") ?? "";

  try {
    const connectionUrl = new URL(connectionText);
    const connectionPath =
      normalizedPath(connectionUrl.pathname) || defaultPath(apiFormat);

    if (!routeText) {
      connectionUrl.pathname = connectionPath || "/";
      return connectionUrl.toString().replace(/\/+$/, "");
    }

    const routeUrl = new URL(routeText);
    routeUrl.pathname = joinPaths(routeUrl.pathname, connectionPath);
    routeUrl.search = "";
    routeUrl.hash = "";
    return routeUrl.toString().replace(/\/+$/, "");
  } catch {
    // Validation remains centralized in validateManagedConnection. Keeping the
    // original value here lets that function return the existing user-facing
    // error instead of hiding malformed bootstrap data.
    return routeText || connectionText;
  }
}

export function resolveGroupConnection(
  scenario: ProductScenario,
  group: NewApiGroup,
  routeBaseUrl?: string,
): NewApiConnection {
  const connection = group.connections?.[scenario.id] ?? {
    baseUrl: group.baseUrl,
    apiKey: group.apiKey,
  };
  const apiFormat = inferredApiFormat(scenario, group, connection);

  return {
    ...connection,
    apiFormat,
    baseUrl: resolveScenarioBaseUrl(
      connection.baseUrl,
      routeBaseUrl,
      apiFormat,
    ),
  };
}
