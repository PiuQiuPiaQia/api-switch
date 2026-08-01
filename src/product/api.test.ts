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

  it("initializes only the selected group", async () => {
    const bootstrap = { groups: [] };
    invokeMock.mockResolvedValue(bootstrap);

    await expect(newApiApi.ensureGroupTokens("daily")).resolves.toBe(bootstrap);
    expect(invokeMock).toHaveBeenCalledWith("newapi_ensure_group_tokens", {
      groupId: "daily",
    });
  });

  it("loads the routes configured by the website API info feature", async () => {
    const routes = [{ id: "1", url: "https://vvcode.top" }];
    invokeMock.mockResolvedValue(routes);

    await expect(newApiApi.getApiInfoRoutes()).resolves.toBe(routes);
    expect(invokeMock).toHaveBeenCalledWith("newapi_get_api_info_routes");
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
});
