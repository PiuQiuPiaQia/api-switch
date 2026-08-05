import { fireEvent, render, screen } from "@testing-library/react";
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
        syncing={false}
        syncError={null}
        onSync={vi.fn()}
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
        syncing={false}
        syncError={null}
        onSync={vi.fn()}
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
        syncing={false}
        syncError={null}
        onSync={vi.fn()}
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

  it("syncs the latest station configuration from the account page", () => {
    const onSync = vi.fn();
    render(
      <AccountPage
        session={previewSession}
        bootstrap={previewBootstrap}
        preview={false}
        syncing={false}
        syncError={null}
        onSync={onSync}
        onLogout={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "配置同步" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /从中转站重新获取当前账号的可用分组/,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "同步最新配置" }));
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("shows synchronization progress and errors", () => {
    const { rerender } = render(
      <AccountPage
        session={previewSession}
        bootstrap={previewBootstrap}
        preview={false}
        syncing
        syncError={null}
        onSync={vi.fn()}
        onLogout={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "正在同步…" })).toBeDisabled();

    rerender(
      <AccountPage
        session={previewSession}
        bootstrap={previewBootstrap}
        preview={false}
        syncing={false}
        syncError="网络连接失败"
        onSync={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "上次同步失败：网络连接失败",
    );
  });

  it("keeps the sync entry visible but disabled in preview mode", () => {
    render(
      <AccountPage
        session={previewSession}
        bootstrap={previewBootstrap}
        preview
        syncing={false}
        syncError={null}
        onSync={vi.fn()}
        onLogout={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "预览模式不可用" }),
    ).toBeDisabled();
    expect(screen.getByText(/登录账号后可同步最新配置/)).toBeInTheDocument();
  });
});
