import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/types";
import { CodexSessionHistoryToggle } from "./CodexSessionHistoryToggle";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  hasBackup: vi.fn(),
  restore: vi.fn(),
}));

vi.mock("@/lib/api/settings", () => ({
  settingsApi: {
    get: mocks.get,
    save: mocks.save,
    hasCodexUnifyHistoryBackup: mocks.hasBackup,
    restoreCodexUnifiedHistory: mocks.restore,
  },
}));

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    checkboxLabel,
    onConfirm,
  }: {
    isOpen: boolean;
    title: string;
    checkboxLabel?: string;
    onConfirm: (checked: boolean) => void;
  }) =>
    isOpen ? (
      <div role="dialog" aria-label={title}>
        {checkboxLabel && <span>{checkboxLabel}</span>}
        <button type="button" onClick={() => onConfirm(Boolean(checkboxLabel))}>
          确认并勾选
        </button>
        <button type="button" onClick={() => onConfirm(false)}>
          确认但不勾选
        </button>
      </div>
    ) : null,
}));

const baseSettings: Settings = {
  showInTray: true,
  minimizeToTrayOnClose: true,
  unifyCodexSessionHistory: false,
};

describe("CodexSessionHistoryToggle", () => {
  beforeEach(() => {
    mocks.get.mockResolvedValue({ ...baseSettings });
    mocks.save.mockResolvedValue(true);
    mocks.hasBackup.mockResolvedValue(false);
    mocks.restore.mockResolvedValue({
      restoredJsonlFiles: 0,
      restoredStateRows: 0,
    });
  });

  it("loads the persisted unified-history state", async () => {
    mocks.get.mockResolvedValue({
      ...baseSettings,
      unifyCodexSessionHistory: true,
    });

    render(<CodexSessionHistoryToggle preview={false} />);

    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "统一 Codex 会话历史" }),
      ).toHaveAttribute("aria-checked", "true"),
    );
    expect(screen.getByText("已开启统一历史")).toBeInTheDocument();
  });

  it("enables unified history and requests existing-session migration", async () => {
    render(<CodexSessionHistoryToggle preview={false} />);
    const toggle = await screen.findByRole("switch", {
      name: "统一 Codex 会话历史",
    });

    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    expect(
      screen.getByRole("dialog", { name: "统一 Codex 会话历史" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认并勾选" }));

    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        ...baseSettings,
        unifyCodexSessionHistory: true,
        unifyCodexMigrateExisting: true,
      }),
    );
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("restores migrated official history when disabling", async () => {
    mocks.get.mockResolvedValue({
      ...baseSettings,
      unifyCodexSessionHistory: true,
      unifyCodexMigrateExisting: true,
    });
    mocks.hasBackup.mockResolvedValue(true);
    mocks.restore.mockResolvedValue({
      restoredJsonlFiles: 3,
      restoredStateRows: 3,
    });

    render(<CodexSessionHistoryToggle preview={false} />);
    const toggle = await screen.findByRole("switch", {
      name: "统一 Codex 会话历史",
    });

    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "关闭统一会话历史" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认并勾选" }));

    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        ...baseSettings,
        unifyCodexSessionHistory: false,
        unifyCodexMigrateExisting: false,
      }),
    );
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledTimes(1));
  });
});
