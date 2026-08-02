import type { NewApiInfoRoute } from "./types";

export type LatencyGrade = "excellent" | "healthy" | "slow" | "failed";

export function normalizeProbeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function uniqueProbeUrls(routes: readonly NewApiInfoRoute[]): string[] {
  return Array.from(
    new Set(
      routes.map((route) => normalizeProbeUrl(route.url)).filter(Boolean),
    ),
  );
}

export function latencyGrade(latency: number | null | undefined): LatencyGrade {
  if (typeof latency !== "number") return "failed";
  if (latency <= 250) return "excellent";
  if (latency <= 800) return "healthy";
  return "slow";
}
