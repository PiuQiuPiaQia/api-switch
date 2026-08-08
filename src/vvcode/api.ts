import { invoke } from "@tauri-apps/api/core";
import type {
  NewApiBootstrap,
  NewApiEndpointProbe,
  NewApiInfoRoute,
  NewApiSession,
} from "./types";
import type { AppId } from "@/lib/api/types";

export const newApiApi = {
  async beginOAuth(serverUrl: string): Promise<NewApiSession> {
    return await invoke("newapi_oauth_begin", { serverUrl });
  },

  async getSession(): Promise<NewApiSession | null> {
    return await invoke("newapi_get_session");
  },

  async logout(): Promise<void> {
    await invoke("newapi_logout");
  },

  async getBootstrap(app?: string): Promise<NewApiBootstrap> {
    return await invoke("newapi_get_bootstrap", { app: app ?? null });
  },

  async getApiInfoRoutes(): Promise<NewApiInfoRoute[]> {
    return await invoke("newapi_get_api_info_routes");
  },

  async getGroupModels(groupId: string): Promise<string[]> {
    return await invoke("newapi_get_group_models", { groupId });
  },

  async ensureGroupTokens(
    groupId: string,
    app?: string,
  ): Promise<NewApiBootstrap> {
    return await invoke("newapi_ensure_group_tokens", {
      groupId,
      app: app ?? null,
    });
  },

  async restoreOfficialConfiguration(app: AppId): Promise<void> {
    await invoke("restore_official_configuration", { app });
  },

  async testEndpoints(
    urls: string[],
    timeoutSecs: number = 6,
  ): Promise<NewApiEndpointProbe[]> {
    return await invoke("test_api_endpoints", { urls, timeoutSecs });
  },
};
