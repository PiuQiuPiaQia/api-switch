import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { newApiApi } from "./api";

describe("newApiApi", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("loads groups for the selected desktop application", async () => {
    const bootstrap = { groups: [] };
    invokeMock.mockResolvedValue(bootstrap);

    await expect(newApiApi.getBootstrap("claude-code")).resolves.toBe(
      bootstrap,
    );
    expect(invokeMock).toHaveBeenCalledWith("newapi_get_bootstrap", {
      app: "claude-code",
    });
  });

  it("requests the generic group fallback when no application is selected", async () => {
    const bootstrap = { groups: [] };
    invokeMock.mockResolvedValue(bootstrap);

    await expect(newApiApi.getBootstrap()).resolves.toBe(bootstrap);
    expect(invokeMock).toHaveBeenCalledWith("newapi_get_bootstrap", {
      app: null,
    });
  });

  it("initializes only the selected group", async () => {
    const bootstrap = { groups: [] };
    invokeMock.mockResolvedValue(bootstrap);

    await expect(
      newApiApi.ensureGroupTokens("daily", "claude-code"),
    ).resolves.toBe(bootstrap);
    expect(invokeMock).toHaveBeenCalledWith("newapi_ensure_group_tokens", {
      groupId: "daily",
      app: "claude-code",
    });
  });

  it("requests a replacement key only after an explicit retry", async () => {
    const bootstrap = { groups: [] };
    invokeMock.mockResolvedValue(bootstrap);

    await expect(
      newApiApi.ensureGroupTokens("daily", "claude-code", true),
    ).resolves.toBe(bootstrap);
    expect(invokeMock).toHaveBeenCalledWith("newapi_ensure_group_tokens", {
      groupId: "daily",
      app: "claude-code",
      createReplacementKey: true,
    });
  });

  it("loads the routes configured by the website API info feature", async () => {
    const routes = [{ id: "1", url: "https://vvcode.top" }];
    invokeMock.mockResolvedValue(routes);

    await expect(newApiApi.getApiInfoRoutes()).resolves.toBe(routes);
    expect(invokeMock).toHaveBeenCalledWith("newapi_get_api_info_routes");
  });

  it("loads the models enabled for the selected website group", async () => {
    const models = ["model-a", "model-b"];
    invokeMock.mockResolvedValue(models);

    await expect(newApiApi.getGroupModels("daily")).resolves.toBe(models);
    expect(invokeMock).toHaveBeenCalledWith("newapi_get_group_models", {
      groupId: "daily",
    });
  });

  it("reuses the endpoint speed-test command for API network checks", async () => {
    const results = [
      { url: "https://api.example/v1", latency: 92, status: 200 },
    ];
    invokeMock.mockResolvedValue(results);

    await expect(
      newApiApi.testEndpoints(["https://api.example/v1"], 6),
    ).resolves.toBe(results);
    expect(invokeMock).toHaveBeenCalledWith("test_api_endpoints", {
      urls: ["https://api.example/v1"],
      timeoutSecs: 6,
    });
  });

  it("restores the selected tool through the native configuration command", async () => {
    invokeMock.mockResolvedValue(undefined);

    await expect(
      newApiApi.restoreOfficialConfiguration("codex"),
    ).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith("restore_official_configuration", {
      app: "codex",
    });
  });
});
