import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { exit } from "@tauri-apps/plugin-process";
import { AlertTriangle, FolderOpen, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

interface DatabaseUpgradeProps {
  payload: {
    path?: string;
    error?: string;
    kind?: string;
    db_version?: number;
    supported_version?: number;
  };
}

/**
 * 数据库版本过新时进入只读恢复界面。VV Code 的自有更新服务尚未接入，
 * 因此这里不会跳转到上游项目或尝试安装来源不明的更新包。
 */
export function DatabaseUpgrade({ payload }: DatabaseUpgradeProps) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-lg space-y-5 rounded-2xl border border-border/60 bg-card/80 p-7 shadow-xl">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">
              {t("dbUpgrade.title", "数据库版本过新")}
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              {t(
                "dbUpgrade.descriptionVvCode",
                "当前数据由更新版本的 VV Code 创建。为保护配置，本版本不会继续写入数据库；请安装兼容版本后再打开。",
              )}
            </p>
            {payload.db_version != null &&
              payload.supported_version != null && (
                <p className="pt-0.5 text-xs tabular-nums text-muted-foreground">
                  {t("dbUpgrade.versionInfo", {
                    db: payload.db_version,
                    supported: payload.supported_version,
                    defaultValue:
                      "数据库版本 v{{db}} · 应用支持 v{{supported}}",
                  })}
                </p>
              )}
          </div>
        </div>

        <div className="space-y-1 rounded-lg border border-border/50 bg-muted/40 p-3 text-xs text-muted-foreground">
          {payload.error && (
            <p className="break-words font-mono">{payload.error}</p>
          )}
          {payload.path && (
            <p className="break-all">
              {t("dbUpgrade.dbPath", "数据库文件")}：{payload.path}
            </p>
          )}
        </div>

        <p className="rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-sm leading-6 text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200">
          {t(
            "dbUpgrade.releaseHintVvCode",
            "自有更新服务接入前，请从 VV Code 的正式发布渠道获取安装包。不要使用 CC Switch 的更新包覆盖本应用。",
          )}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => void invoke("open_app_config_folder")}
          >
            <FolderOpen className="h-4 w-4" />
            {t("dbUpgrade.openConfigDir", "打开配置目录")}
          </Button>
          <Button
            variant="ghost"
            className="ml-auto gap-2 text-muted-foreground"
            onClick={() => void exit(0)}
          >
            <LogOut className="h-4 w-4" />
            {t("dbUpgrade.quit", "退出")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default DatabaseUpgrade;
