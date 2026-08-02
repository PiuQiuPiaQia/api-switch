import { describe, expect, it } from "vitest";
import {
  latencyGrade,
  normalizeProbeUrl,
  uniqueProbeUrls,
} from "./initialization";
import type { NewApiInfoRoute } from "./types";

const routes: NewApiInfoRoute[] = [
  {
    id: "1",
    route: "默认线路",
    description: "默认",
    url: "https://vvcode.top/",
    color: "green",
  },
  {
    id: "2",
    route: "CF全球加速",
    description: "CF全球加速",
    url: "https://cf.vvcode.top",
    color: "orange",
  },
];

describe("initialization panel data", () => {
  it("normalizes configured URLs for probe matching", () => {
    expect(normalizeProbeUrl("  https://vvcode.top/// ")).toBe(
      "https://vvcode.top",
    );
  });

  it("deduplicates URLs before a one-click network test", () => {
    expect(uniqueProbeUrls([...routes, routes[0]])).toEqual([
      "https://vvcode.top",
      "https://cf.vvcode.top",
    ]);
  });

  it("grades latency consistently", () => {
    expect(latencyGrade(180)).toBe("excellent");
    expect(latencyGrade(620)).toBe("healthy");
    expect(latencyGrade(1200)).toBe("slow");
    expect(latencyGrade(null)).toBe("failed");
  });
});
