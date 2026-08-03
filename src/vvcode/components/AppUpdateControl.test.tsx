import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppUpdateControl } from "./AppUpdateControl";

const mocks = vi.hoisted(() => ({
  getCurrentVersion: vi.fn(),
  check: vi.fn(),
  install: vi.fn(),
  confirm: vi.fn(),
  listen: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../updater", () => ({
  getCurrentVvCodeVersion: mocks.getCurrentVersion,
  checkForVvCodeUpdate: mocks.check,
  installVvCodeUpdate: mocks.install,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: mocks.confirm,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("sonner", () => ({
  toast: {
    info: mocks.info,
    success: mocks.success,
    error: mocks.error,
  },
}));

describe("AppUpdateControl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.getCurrentVersion.mockReset();
    mocks.getCurrentVersion.mockResolvedValue("0.0.1-beta.3");
    mocks.check.mockReset();
    mocks.install.mockReset();
    mocks.confirm.mockReset();
    mocks.listen.mockReset();
    mocks.info.mockReset();
    mocks.success.mockReset();
    mocks.error.mockReset();
    mocks.listen.mockResolvedValue(vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("finds a prerelease automatically and installs it after confirmation", async () => {
    mocks.check.mockResolvedValue({
      currentVersion: "0.0.1-beta.3",
      availableVersion: "0.0.1-beta.4",
      releaseUrl: "https://example.test/v0.0.1-beta.4",
      channel: "beta",
    });
    mocks.confirm.mockResolvedValue(true);
    mocks.install.mockResolvedValue(true);

    render(<AppUpdateControl />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    const updateButton = screen.getByRole("button", {
      name: "v0.0.1-beta.3 更新到 0.0.1-beta.4",
    });
    expect(updateButton).toHaveAttribute(
      "title",
      "当前版本：v0.0.1-beta.3，可用版本：v0.0.1-beta.4",
    );
    expect(mocks.info).toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(updateButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.confirm).toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalled();
  });

  it("reports an up-to-date result for a manual check", async () => {
    mocks.check.mockResolvedValue(null);
    render(<AppUpdateControl />);

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "v0.0.1-beta.3 检查更新",
        }),
      );
      await Promise.resolve();
    });

    expect(mocks.success).toHaveBeenCalled();
    expect(
      screen.getByRole("button", {
        name: "v0.0.1-beta.3 已是最新",
      }),
    ).toBeInTheDocument();
  });

  it("shows the installed application version before checking for updates", async () => {
    mocks.check.mockResolvedValue(null);
    render(<AppUpdateControl />);

    await act(async () => {
      await Promise.resolve();
    });

    const updateButton = screen.getByRole("button", {
      name: "v0.0.1-beta.3 检查更新",
    });
    expect(updateButton).toHaveAttribute(
      "title",
      "当前版本：v0.0.1-beta.3",
    );
  });
});
