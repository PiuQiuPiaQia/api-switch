import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoginScreen } from "./LoginScreen";

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
  it("keeps the signed-out page focused on the primary login action", () => {
    const onLogin = vi.fn();

    render(
      <LoginScreen
        busy={false}
        error={null}
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
      <LoginScreen busy error={null} onLogin={vi.fn()} onPreview={vi.fn()} />,
    );

    expect(
      screen.getByRole("button", { name: "等待登录完成…" }),
    ).toBeDisabled();
  });

  it("keeps login failures next to the primary action", () => {
    render(
      <LoginScreen
        busy={false}
        error="登录已失效，请重试"
        onLogin={vi.fn()}
        onPreview={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("登录已失效，请重试");
  });
});
