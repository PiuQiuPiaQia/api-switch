import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { previewBootstrap, previewSession } from "../mockData";
import { AccountPage } from "./AccountPage";

describe("AccountPage", () => {
  it("uses the account username instead of a misleading display name", () => {
    render(
      <AccountPage
        session={{
          ...previewSession,
          username: "alice",
          displayName: "Root User",
        }}
        bootstrap={{
          ...previewBootstrap,
          user: {
            ...previewBootstrap.user,
            username: "alice",
            displayName: "Root User",
          },
        }}
        preview={false}
        onLogout={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "alice", level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByText("@alice")).toBeInTheDocument();
    expect(screen.queryByText(/root user/i)).not.toBeInTheDocument();
    expect(
      screen
        .getByRole("heading", { name: "用户信息", level: 1 })
        .closest(".vv-page-layout--narrow"),
    ).not.toBeNull();
    expect(screen.queryByText("账号中心")).not.toBeInTheDocument();
  });

  it("shows the wallet balance and links to the website recharge page", () => {
    render(
      <AccountPage
        session={previewSession}
        bootstrap={previewBootstrap}
        preview
        onLogout={vi.fn()}
      />,
    );

    expect(screen.getByText("钱包余额")).toBeInTheDocument();
    expect(screen.getByText("$25.00")).toBeInTheDocument();
    expect(screen.getByText("可用额度 12,500,000 点")).toBeInTheDocument();
    expect(screen.getByText("累计消耗")).toBeInTheDocument();
    expect(screen.getByText("$7.44")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: "去充值" })).toHaveAttribute(
      "href",
      "https://vvcode.top/wallet",
    );
  });

  it("shows the selected global Base URL as the service address", () => {
    render(
      <AccountPage
        session={previewSession}
        bootstrap={previewBootstrap}
        preview={false}
        globalBaseUrl="https://hk.vvcode.top"
        onLogout={vi.fn()}
      />,
    );

    expect(screen.getByText("服务地址").nextElementSibling).toHaveTextContent(
      "https://hk.vvcode.top",
    );
    expect(screen.getByRole("link", { name: "去充值" })).toHaveAttribute(
      "href",
      "https://vvcode.top/wallet",
    );
  });
});
