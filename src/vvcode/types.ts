import type { AppId } from "@/lib/api";

export type ScenarioId =
  | "claude"
  | "claude-desktop"
  | "codex"
  | "gemini"
  | "opencode"
  | "openclaw"
  | "hermes";

export interface ProductScenario {
  id: ScenarioId;
  appId: AppId;
  groupAppId: string;
  tool:
    | "claude"
    | "codex"
    | "gemini"
    | "opencode"
    | "openclaw"
    | "hermes"
    | null;
  name: string;
  shortName: string;
  description: string;
  desktopDownload?: {
    label: string;
    url: string;
  };
  accent: string;
  icon: "claude" | "openai" | "gemini" | "opencode" | "openclaw" | "hermes";
}

export interface NewApiSession {
  serverUrl: string;
  userId: number;
  username: string;
  displayName: string;
  role: number;
  createdAt: number;
}

export interface NewApiBrowserOpenFailed {
  authorizationUrl: string;
  error: string;
}

export interface NewApiUser {
  id: number;
  username: string;
  displayName: string;
  email: string;
  role: number;
  status: number;
  group: string;
  quota: number;
  usedQuota: number;
  requestCount: number;
}

export interface NewApiModel {
  id: string;
  name: string;
  description: string;
  vendor: string;
  quotaType: number;
  modelRatio: number;
  modelPrice: number;
  completionRatio: number;
}

export interface NewApiConnection {
  baseUrl: string;
  apiKey: string;
  apiFormat?:
    | "anthropic"
    | "openai_chat"
    | "openai_responses"
    | "gemini_native"
    | string;
}

export interface NewApiGroup {
  id: string;
  name: string;
  description: string;
  ratio: string;
  baseUrl: string;
  apiKey: string;
  defaultModelId: string;
  apiProvider: string;
  ccProvider: string;
  isDefault: boolean;
  models: NewApiModel[];
  connections?: Partial<Record<ScenarioId, NewApiConnection>>;
}

export interface NewApiBootstrap {
  user: NewApiUser;
  groups: NewApiGroup[];
  source: "desktop-v1" | "vscode-legacy" | "preview" | string;
}

export interface NewApiInfoRoute {
  id: string;
  url: string;
  route: string;
  description: string;
  color: string;
}

export interface NewApiEndpointProbe {
  url: string;
  latency: number | null;
  status?: number | null;
  error?: string | null;
}

export interface ToolVersionInfo {
  name: string;
  version: string | null;
  latest_version: string | null;
  error: string | null;
  installed_but_broken: boolean;
  env_type: "windows" | "wsl" | "macos" | "linux" | "unknown";
  wsl_distro: string | null;
}

export interface ToolEnvironmentState {
  info: ToolVersionInfo | null;
  loading: boolean;
  error: string | null;
}

export type ToolEnvironmentSnapshot = Pick<ToolEnvironmentState, "info">;
