import { invoke } from "@tauri-apps/api/core";

export interface VvCodeUpdateInfo {
  currentVersion: string;
  availableVersion: string;
  notes?: string;
  pubDate?: string;
  releaseUrl: string;
  channel: "stable" | "beta";
}

export interface UpdateDownloadProgress {
  downloaded: number;
  total?: number;
}

export async function checkForVvCodeUpdate(): Promise<VvCodeUpdateInfo | null> {
  return invoke<VvCodeUpdateInfo | null>("vvcode_check_for_update");
}

export async function installVvCodeUpdate(): Promise<boolean> {
  return invoke<boolean>("vvcode_install_update_and_restart");
}
