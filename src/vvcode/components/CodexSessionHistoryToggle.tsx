import { useCallback, useEffect, useState } from "react";
import { History, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { Settings } from "@/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { settingsApi } from "@/lib/api/settings";

interface CodexSessionHistoryToggleProps {
  preview: boolean;
}

const ENABLE_MESSAGE =
  "开启后，官方订阅与第三方供应商会共用同一个 Codex 会话历史列表。跨供应商继续旧会话时，可能因 encrypted_content 无法解密而失败。";
const ENABLE_MIGRATION_LABEL =
  "同时迁入现有官方会话历史（迁移前自动备份，关闭时可恢复）";
const DISABLE_MESSAGE =
  "关闭后，官方订阅与第三方会恢复各自独立的会话历史列表。开启期间产生的会话会保留在第三方历史中。";
const RESTORE_LABEL = "按备份恢复开启时迁入的官方会话历史";

export function CodexSessionHistoryToggle({
  preview,
}: CodexSessionHistoryToggleProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(!preview);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showEnableConfirm, setShowEnableConfirm] = useState(false);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [hasBackup, setHasBackup] = useState(false);
  const [checkingBackup, setCheckingBackup] = useState(false);

  const loadSettings = useCallback(async () => {
    if (preview) return;

    setLoading(true);
    setLoadError(null);
    try {
      const current = await settingsApi.get();
      setSettings(current);
      setEnabled(current.unifyCodexSessionHistory ?? false);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [preview]);

  useEffect(() => {
    if (preview) {
      setLoading(false);
      return;
    }
    void loadSettings();
  }, [loadSettings, preview]);

  const persist = useCallback(
    async (updates: Partial<Settings>): Promise<boolean> => {
      setSaving(true);
      try {
        // 重新读取完整设置，避免 VV Code 场景保存时覆盖其他设置字段。
        const current = await settingsApi.get();
        const next = { ...current, ...updates };
        const saved = await settingsApi.save(next);
        if (saved === false) throw new Error("设置保存失败");
        setSettings(next);
        setEnabled(next.unifyCodexSessionHistory ?? false);
        return true;
      } catch (error) {
        toast.error("统一会话历史设置失败", {
          description: error instanceof Error ? error.message : String(error),
        });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const handleEnableConfirm = async (migrateExisting: boolean) => {
    setShowEnableConfirm(false);
    await persist({
      unifyCodexSessionHistory: true,
      unifyCodexMigrateExisting: migrateExisting,
    });
  };

  const handleDisableConfirm = async (restoreBackup: boolean) => {
    setShowDisableConfirm(false);
    const saved = await persist({
      unifyCodexSessionHistory: false,
      unifyCodexMigrateExisting: false,
    });
    if (!saved || !restoreBackup) return;

    try {
      const result = await settingsApi.restoreCodexUnifiedHistory();
      if (result.skippedReason) {
        toast.info(
          result.skippedReason === "unify_toggle_on"
            ? "统一会话历史已重新开启，已跳过还原"
            : "当前 Codex 目录没有可恢复的迁移备份",
        );
        return;
      }
      toast.success(
        `已恢复官方会话历史（${result.restoredJsonlFiles} 个会话文件、${result.restoredStateRows} 条索引记录）`,
      );
    } catch (error) {
      toast.error("还原官方会话历史失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleChange = async (checked: boolean) => {
    if (preview || loading || saving || loadError) return;
    if (checked) {
      setShowEnableConfirm(true);
      return;
    }

    setCheckingBackup(true);
    try {
      const backup = await settingsApi.hasCodexUnifyHistoryBackup();
      setHasBackup(backup);
      setShowDisableConfirm(true);
    } catch (error) {
      toast.error("无法检查统一会话历史备份", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCheckingBackup(false);
    }
  };

  const showRestoreOption =
    hasBackup || (settings?.unifyCodexMigrateExisting ?? false);
  const disabled =
    preview || loading || saving || checkingBackup || Boolean(loadError);

  return (
    <>
      <section
        className="vv-codex-history-toggle"
        aria-labelledby="vv-codex-history-title"
      >
        <div className="vv-codex-history-toggle__icon" aria-hidden="true">
          <History size={18} />
        </div>
        <div className="vv-codex-history-toggle__body">
          <div className="vv-codex-history-toggle__heading">
            <div>
              <h2 id="vv-codex-history-title">统一 Codex 会话历史</h2>
              <p>让官方订阅和第三方供应商的会话出现在同一个历史列表中。</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="统一 Codex 会话历史"
              className={`vv-codex-history-switch ${enabled ? "is-on" : ""}`}
              disabled={disabled}
              onClick={() => void handleChange(!enabled)}
            >
              <span />
            </button>
          </div>
          <div className="vv-codex-history-toggle__status" aria-live="polite">
            {loading || checkingBackup ? (
              <>
                <Loader2 className="vv-spin" size={13} />
                <span>{loading ? "正在读取设置…" : "正在检查备份…"}</span>
              </>
            ) : loadError ? (
              <>
                <span>读取设置失败：{loadError}</span>
                <button
                  type="button"
                  className="vv-text-button"
                  onClick={() => void loadSettings()}
                >
                  <RefreshCw size={13} /> 重试
                </button>
              </>
            ) : (
              <span>{enabled ? "已开启统一历史" : "当前使用独立历史"}</span>
            )}
          </div>
        </div>
      </section>

      <ConfirmDialog
        isOpen={showEnableConfirm}
        title="统一 Codex 会话历史"
        message={ENABLE_MESSAGE}
        checkboxLabel={ENABLE_MIGRATION_LABEL}
        confirmText="继续开启"
        variant="info"
        onConfirm={(migrateExisting) =>
          void handleEnableConfirm(migrateExisting)
        }
        onCancel={() => setShowEnableConfirm(false)}
      />

      <ConfirmDialog
        isOpen={showDisableConfirm}
        title="关闭统一会话历史"
        message={DISABLE_MESSAGE}
        checkboxLabel={showRestoreOption ? RESTORE_LABEL : undefined}
        checkboxDefaultChecked
        confirmText="关闭"
        onConfirm={(restoreBackup) => void handleDisableConfirm(restoreBackup)}
        onCancel={() => setShowDisableConfirm(false)}
      />
    </>
  );
}
