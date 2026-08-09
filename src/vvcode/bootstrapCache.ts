import { BRAND_CONFIG } from "./brand";
import type { NewApiBootstrap } from "./types";

const STORAGE_PREFIX = `${BRAND_CONFIG.distribution.packageName}:bootstrap:v1`;
const ROOT_SCOPE = "__all__";

function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function normalizedAppId(appId?: string): string {
  return appId?.trim() || ROOT_SCOPE;
}

function storageKey(userId: number, appId?: string): string {
  return `${STORAGE_PREFIX}:${userId}:${encodeURIComponent(normalizedAppId(appId))}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBootstrap(value: unknown, userId: number): value is NewApiBootstrap {
  if (
    !isRecord(value) ||
    !isRecord(value.user) ||
    !Array.isArray(value.groups)
  ) {
    return false;
  }
  if (value.user.id !== userId || typeof value.source !== "string")
    return false;

  return value.groups.every(
    (group) =>
      isRecord(group) &&
      typeof group.id === "string" &&
      typeof group.name === "string" &&
      typeof group.apiKey === "string" &&
      Array.isArray(group.models),
  );
}

export function loadCachedBootstrap(
  userId: number,
  appId?: string,
): NewApiBootstrap | null {
  try {
    const raw = storage()?.getItem(storageKey(userId, appId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isBootstrap(parsed, userId) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveCachedBootstrap(
  userId: number,
  appId: string | undefined,
  bootstrap: NewApiBootstrap,
): void {
  if (!isBootstrap(bootstrap, userId)) return;
  try {
    storage()?.setItem(storageKey(userId, appId), JSON.stringify(bootstrap));
  } catch {
    // Cache persistence is best effort; the fresh response remains in memory.
  }
}

export function clearCachedBootstraps(userId: number): void {
  try {
    const currentStorage = storage();
    if (!currentStorage) return;
    const prefix = `${STORAGE_PREFIX}:${userId}:`;
    const keys: string[] = [];
    for (let index = 0; index < currentStorage.length; index += 1) {
      const key = currentStorage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    keys.forEach((key) => currentStorage.removeItem(key));
  } catch {
    // Logout should continue even when local storage is unavailable.
  }
}
