import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppUpdateControl } from "./AppUpdateControl";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  install: vi.fn(),
  confirm: vi.fn(),
  listen: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../updater", () => ({
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
      name: "更新到 0.0.1-beta.4",
    });
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
      fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
      await Promise.resolve();
    });

    expect(mocks.success).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "已是最新" })).toBeInTheDocument();
  });
});
