import type {
  ToolInstallation,
  ToolInstallationReport,
} from "@/lib/api/settings";
import type { ToolEnvironmentSnapshot, ToolEnvironmentState } from "./types";

type ToolEnvironmentLike = ToolEnvironmentSnapshot | ToolEnvironmentState;

export function defaultRunnableInstallation(
  report: ToolInstallationReport | null,
): ToolInstallation | null {
  return (
    report?.installs.find(
      (installation) => installation.is_path_default && installation.runnable,
    ) ?? null
  );
}

export function hiddenRunnableInstallation(
  report: ToolInstallationReport | null,
): ToolInstallation | null {
  return (
    report?.installs.find(
      (installation) => !installation.is_path_default && installation.runnable,
    ) ?? null
  );
}

export function isToolEnvironmentReady(
  environment: ToolEnvironmentLike,
): boolean {
  const info = environment.info;
  if (!info?.version || info.installed_but_broken) return false;

  // WSL 的版本探测本身就在目标发行版的登录 shell 中执行；共享安装分布接口
  // 当前只枚举 Windows 主机文件系统，不能拿它反向否定已经通过的 WSL 探测。
  if (info.env_type === "wsl") return true;

  return Boolean(defaultRunnableInstallation(environment.installationReport));
}

export function hasToolPathMismatch(environment: ToolEnvironmentLike): boolean {
  const info = environment.info;
  return Boolean(
    info?.version &&
      !info.installed_but_broken &&
      info.env_type !== "wsl" &&
      environment.installationReport &&
      !defaultRunnableInstallation(environment.installationReport),
  );
}

export function toolPathMismatchDescription(
  toolName: string,
  environment: ToolEnvironmentLike,
): string {
  const hidden = hiddenRunnableInstallation(environment.installationReport);
  if (hidden) {
    const version = hidden.version ? `（v${hidden.version}）` : "";
    return `已找到可运行的 ${toolName}${version}，但当前终端还不能直接使用。点击“一键修复”即可连接现有安装，无需重装或手动修改 PATH。`;
  }
  return `检测到了 ${toolName} 安装，但当前终端还不能直接使用。点击“一键修复”即可自动处理。`;
}
