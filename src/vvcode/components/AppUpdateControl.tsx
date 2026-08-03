import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  checkForVvCodeUpdate,
  getCurrentVvCodeVersion,
  installVvCodeUpdate,
  type UpdateDownloadProgress,
  type VvCodeUpdateInfo,
} from "../updater";

type UpdatePhase = "idle" | "checking" | "available" | "installing" | "current";

const AUTO_CHECK_DELAY_MS = 1_500;
const CURRENT_LABEL_DURATION_MS = 3_000;

function formatProgress(progress: UpdateDownloadProgress | null): string {
  if (!progress?.total || progress.total <= 0) return "正在下载";
  const percentage = Math.min(
    100,
    Math.round((progress.downloaded / progress.total) * 100),
  );
  return `下载 ${percentage}%`;
}

function formatVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

export function AppUpdateControl({ className = "" }: { className?: string }) {
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [update, setUpdate] = useState<VvCodeUpdateInfo | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null);
  const checkingRef = useRef(false);
  const currentResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const check = useCallback(async (manual: boolean) => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setPhase("checking");

    try {
      const nextUpdate = await checkForVvCodeUpdate();
      setUpdate(nextUpdate);
      if (nextUpdate) {
        setAppVersion(nextUpdate.currentVersion);
        setPhase("available");
        if (!manual) {
          toast.info(`发现 VV Code ${nextUpdate.availableVersion}`, {
            description: "点击顶部的更新按钮即可下载并安装。",
          });
        }
        return;
      }

      setPhase(manual ? "current" : "idle");
      if (manual) {
        toast.success("当前已是最新版本");
        if (currentResetTimerRef.current) {
          clearTimeout(currentResetTimerRef.current);
        }
        currentResetTimerRef.current = setTimeout(
          () => setPhase("idle"),
          CURRENT_LABEL_DURATION_MS,
        );
      }
    } catch (error) {
      setPhase("idle");
      if (manual) {
        toast.error("检查软件更新失败", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      checkingRef.current = false;
    }
  }, []);

  useEffect(() => {
    let active = true;
    void getCurrentVvCodeVersion()
      .then((version) => {
        if (active) setAppVersion(version);
      })
      .catch(() => {
        // The update action remains usable in browser-only previews.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void check(false), AUTO_CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
      if (currentResetTimerRef.current) {
        clearTimeout(currentResetTimerRef.current);
      }
    };
  }, [check]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<UpdateDownloadProgress>(
      "vvcode-update-download-progress",
      (event) => setProgress(event.payload),
    )
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // Browser-only previews do not expose Tauri's event bridge.
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const install = useCallback(async () => {
    if (!update || phase === "installing") return;

    const accepted = await confirm(
      `将下载并安装 VV Code ${update.availableVersion}，安装完成后应用会自动重启。`,
      {
        title: "安装软件更新",
        kind: "info",
        okLabel: "立即更新",
        cancelLabel: "稍后",
      },
    );
    if (!accepted) return;

    setProgress(null);
    setPhase("installing");
    try {
      const installed = await installVvCodeUpdate();
      if (!installed) {
        setUpdate(null);
        setPhase("current");
        toast.info("更新状态已变化，请重新检查");
      }
    } catch (error) {
      setPhase("available");
      toast.error("软件更新失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [phase, update]);

  let label = "检查更新";
  let icon = <RefreshCw size={14} />;
  if (phase === "checking") {
    label = "检查中";
    icon = <Loader2 className="vv-spin" size={14} />;
  } else if (phase === "available" && update) {
    label = `更新到 ${update.availableVersion}`;
    icon = <Download size={14} />;
  } else if (phase === "installing") {
    label = formatProgress(progress);
    icon = <Loader2 className="vv-spin" size={14} />;
  } else if (phase === "current") {
    label = "已是最新";
  }

  const currentVersion = update?.currentVersion || appVersion;
  const displayVersion = currentVersion ? formatVersion(currentVersion) : "";

  return (
    <button
      type="button"
      className={`vv-update-button${phase === "available" ? " is-available" : ""}${className ? ` ${className}` : ""}`}
      disabled={phase === "checking" || phase === "installing"}
      onClick={() =>
        phase === "available" ? void install() : void check(true)
      }
      title={
        update
          ? `当前版本：${formatVersion(update.currentVersion)}，可用版本：${formatVersion(update.availableVersion)}`
          : currentVersion
            ? `当前版本：${formatVersion(currentVersion)}`
            : "检查 VV Code 更新"
      }
    >
      {displayVersion && (
        <>
          <span className="vv-update-button__version">{displayVersion}</span>
          <span aria-hidden="true">·</span>
        </>
      )}
      {icon}
      <span>{label}</span>
    </button>
  );
}
