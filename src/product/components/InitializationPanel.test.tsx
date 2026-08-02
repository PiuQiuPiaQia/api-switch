import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveCachedApiInfoRoutes } from "../apiInfoPreferences";
import type { NewApiInfoRoute } from "../types";
import { InitializationPanel } from "./InitializationPanel";

const apiMocks = vi.hoisted(() => ({
  getApiInfoRoutes: vi.fn(),
  testEndpoints: vi.fn(),
}));

vi.mock("../api", () => ({
  newApiApi: {
    getApiInfoRoutes: apiMocks.getApiInfoRoutes,
    testEndpoints: apiMocks.testEndpoints,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

const serverUrl = "https://vvcode.top";
const routes: NewApiInfoRoute[] = [
  {
    id: "1",
    route: "默认线路",
    description: "默认",
    url: "https://vvcode.top",
    color: "green",
  },
];

function panel(onGlobalBaseUrlChange = vi.fn()) {
  return (
    <InitializationPanel
      preview={false}
      serverUrl={serverUrl}
      globalBaseUrl=""
      onGlobalBaseUrlChange={onGlobalBaseUrlChange}
    />
  );
}

describe("InitializationPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    apiMocks.getApiInfoRoutes.mockReset();
    apiMocks.testEndpoints.mockReset();
  });

  it("reuses cached API info when the panel is opened again", async () => {
    apiMocks.getApiInfoRoutes.mockResolvedValue(routes);

    const first = render(panel());
    expect(await screen.findByText("默认线路")).toBeInTheDocument();
    expect(
      screen
        .getByRole("heading", { name: "API 信息", level: 1 })
        .closest(".vv-page-layout--standard"),
    ).not.toBeNull();
    expect(screen.queryByText("连接准备")).not.toBeInTheDocument();
    expect(apiMocks.getApiInfoRoutes).toHaveBeenCalledTimes(1);
    first.unmount();

    render(panel());
    expect(await screen.findByText("默认线路")).toBeInTheDocument();
    expect(apiMocks.getApiInfoRoutes).toHaveBeenCalledTimes(1);
  });

  it("allows a reachable route to become the global Base URL", async () => {
    saveCachedApiInfoRoutes(serverUrl, routes);
    apiMocks.testEndpoints.mockResolvedValue([
      { url: "https://vvcode.top", latency: 88, status: 200, error: null },
    ]);
    const onGlobalBaseUrlChange = vi.fn();
    render(panel(onGlobalBaseUrlChange));

    expect(
      await screen.findByRole("button", { name: "检测后选择" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "一键网络检测" }));

    const select = await screen.findByRole("button", { name: "设为全局" });
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.click(select);

    expect(apiMocks.testEndpoints).toHaveBeenCalledWith(
      ["https://vvcode.top"],
      6,
    );
    expect(onGlobalBaseUrlChange).toHaveBeenCalledWith("https://vvcode.top");
  });
});
