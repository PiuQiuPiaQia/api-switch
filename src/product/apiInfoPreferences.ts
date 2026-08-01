import { normalizeProbeUrl } from "./initialization";
import type { NewApiInfoRoute } from "./types";

const STORAGE_PREFIX = "vv-code:api-info:v1";

function storageKey(serverUrl: string, field: "routes" | "selected"): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(normalizeProbeUrl(serverUrl))}:${field}`;
}

function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validHttpBaseUrl(value: string): string {
  const normalized = normalizeProbeUrl(value);
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return "";
    }
    return normalized;
  } catch {
    return "";
  }
}

function parseRoutes(value: unknown): NewApiInfoRoute[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const url = text(record.url);
    if (!url) return [];
    return [
      {
        id: text(record.id),
        url,
        route: text(record.route),
        description: text(record.description),
        color: text(record.color),
      },
    ];
  });
}

export function loadCachedApiInfoRoutes(
  serverUrl: string,
): NewApiInfoRoute[] | null {
  try {
    const value = storage()?.getItem(storageKey(serverUrl, "routes"));
    return value === null || value === undefined
      ? null
      : parseRoutes(JSON.parse(value));
  } catch {
    return null;
  }
}

export function saveCachedApiInfoRoutes(
  serverUrl: string,
  routes: readonly NewApiInfoRoute[],
): void {
  try {
    storage()?.setItem(
      storageKey(serverUrl, "routes"),
      JSON.stringify(parseRoutes(routes)),
    );
  } catch {
    // Cache failures should not block API route detection.
  }
}

export function loadSelectedGlobalBaseUrl(serverUrl: string): string {
  try {
    return validHttpBaseUrl(
      storage()?.getItem(storageKey(serverUrl, "selected")) ?? "",
    );
  } catch {
    return "";
  }
}

export function saveSelectedGlobalBaseUrl(
  serverUrl: string,
  baseUrl: string,
): void {
  try {
    const key = storageKey(serverUrl, "selected");
    const normalized = validHttpBaseUrl(baseUrl);
    if (normalized) storage()?.setItem(key, normalized);
    else storage()?.removeItem(key);
  } catch {
    // Preference persistence is best effort; the in-memory choice still works.
  }
}
