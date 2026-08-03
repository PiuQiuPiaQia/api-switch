import { normalizeProbeUrl } from "./initialization";
import type { ScenarioId } from "./types";
import { BRAND_CONFIG } from "./brand";

const STORAGE_PREFIX = `${BRAND_CONFIG.distribution.packageName}:scenario:v1`;

function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function storageKey(
  serverUrl: string,
  userId: number,
  scenarioId: ScenarioId,
): string {
  const server = encodeURIComponent(normalizeProbeUrl(serverUrl));
  return `${STORAGE_PREFIX}:${server}:${userId}:${scenarioId}:group`;
}

export function loadSelectedScenarioGroup(
  serverUrl: string,
  userId: number,
  scenarioId: ScenarioId,
): string {
  try {
    return (
      storage()
        ?.getItem(storageKey(serverUrl, userId, scenarioId))
        ?.trim() ?? ""
    );
  } catch {
    return "";
  }
}

export function saveSelectedScenarioGroup(
  serverUrl: string,
  userId: number,
  scenarioId: ScenarioId,
  groupId: string,
): void {
  try {
    const key = storageKey(serverUrl, userId, scenarioId);
    const value = groupId.trim();
    if (value) storage()?.setItem(key, value);
    else storage()?.removeItem(key);
  } catch {
    // Preference persistence is best effort; the mounted workspace keeps its state.
  }
}
