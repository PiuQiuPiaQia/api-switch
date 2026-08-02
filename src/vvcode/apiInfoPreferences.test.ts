import { beforeEach, describe, expect, it } from "vitest";
import {
  loadCachedApiInfoRoutes,
  loadSelectedGlobalBaseUrl,
  saveCachedApiInfoRoutes,
  saveSelectedGlobalBaseUrl,
} from "./apiInfoPreferences";
import type { NewApiInfoRoute } from "./types";

const routes: NewApiInfoRoute[] = [
  {
    id: "1",
    route: "默认线路",
    description: "默认",
    url: "https://vvcode.top",
    color: "green",
  },
];

describe("API info preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("caches API info routes per website", () => {
    saveCachedApiInfoRoutes("https://vvcode.top/", routes);

    expect(loadCachedApiInfoRoutes("https://vvcode.top")).toEqual(routes);
    expect(loadCachedApiInfoRoutes("https://another.example")).toBeNull();
  });

  it("persists a normalized global Base URL", () => {
    saveSelectedGlobalBaseUrl(
      "https://vvcode.top",
      " https://cf.vvcode.top/// ",
    );
    expect(loadSelectedGlobalBaseUrl("https://vvcode.top/")).toBe(
      "https://cf.vvcode.top",
    );

    saveSelectedGlobalBaseUrl("https://vvcode.top", "");
    expect(loadSelectedGlobalBaseUrl("https://vvcode.top")).toBe("");
  });

  it("does not restore unsafe global Base URLs", () => {
    saveSelectedGlobalBaseUrl("https://vvcode.top", "file:///tmp/gateway");
    expect(loadSelectedGlobalBaseUrl("https://vvcode.top")).toBe("");
  });
});
