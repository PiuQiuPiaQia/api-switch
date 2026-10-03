import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyText } from "@/lib/clipboard";
import { LoginScreen } from "./LoginScreen";

vi.mock("@/lib/clipboard", () => ({
  copyText: vi.fn(() => Promise.resolve()),
}));

vi.mock("../config", () => ({
  PRODUCT: {
    brand: { name: "VV Code" },
    newApiBaseUrl: "https://api.example.com",
  },
  IS_PRODUCT_PREVIEW_AVAILABLE: false,
}));

vi.mock("./AppUpdateControl", () => ({
  AppUpdateControl: () => null,
}));

describe("LoginScreen", () => {
  beforeEach(() => {
    vi.mocked(copyText).mockClear();
  });

  it("keeps the signed-out page focused on the primary login action", () => {
    const onLogin = vi.fn();

    render(
      <LoginScreen
        busy={false}
        error={null}
        manualAuthUrl={null}
        onLogin={onLogin}
        onPreview={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "登录 VV Code" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("集中管理 Claude Code、Codex CLI 等工具的模型配置。"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/OAuth \+ PKCE/)).not.toBeInTheDocument();
    expect(screen.queryByText(/服务条款与隐私政策/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "一键登录" }));
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it("shows a compact pending state while browser authorization is active", () => {
    render(
      <LoginScreen
        busy
        error={null}
        manualAuthUrl={null}
        onLogin={vi.fn()}
        onPreview={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "等待登录完成…" }),
    ).toBeDisabled();
  });

  it("offers the authorization URL for manual opening when the browser launch fails", async () => {
    const authUrl = "https://auth.example.com/api/oauth/vscode?state=abc";
    vi.mocked(copyText).mockResolvedValueOnce(undefined);

    render(
      <LoginScreen
        busy
        error={null}
        manualAuthUrl={authUrl}
        onLogin={vi.fn()}
        onPreview={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("无法自动打开浏览器");
    expect(screen.getByRole("status")).toHaveTextContent(authUrl);

    fireEvent.click(screen.getByRole("button", { name: "复制授权链接" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(authUrl));
    expect(
      await screen.findByRole("button", { name: "已复制" }),
    ).toBeInTheDocument();
  });

  it("hides the manual authorization notice once it is not needed", () => {
    render(
      <LoginScreen
        busy={false}
        error={null}
        manualAuthUrl={null}
        onLogin={vi.fn()}
        onPreview={vi.fn()}
      />,
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制授权链接" })).toBeNull();
  });

  it("keeps login failures next to the primary action", () => {
    render(
      <LoginScreen
        busy={false}
        error="登录已失效，请重试"
        manualAuthUrl={null}
        onLogin={vi.fn()}
        onPreview={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("登录已失效，请重试");
  });
});
