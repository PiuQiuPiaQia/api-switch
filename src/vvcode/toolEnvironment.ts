import type { ToolEnvironmentSnapshot, ToolEnvironmentState } from "./types";

type ToolEnvironmentLike = ToolEnvironmentSnapshot | ToolEnvironmentState;

export function isToolEnvironmentReady(
  environment: ToolEnvironmentLike,
): boolean {
  const info = environment.info;
  return Boolean(info?.version && !info.installed_but_broken);
}
