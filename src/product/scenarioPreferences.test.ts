import { beforeEach, describe, expect, it } from "vitest";
import {
  loadSelectedScenarioGroup,
  saveSelectedScenarioGroup,
} from "./scenarioPreferences";

describe("scenario preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("persists group selections per website, user, and scenario", () => {
    saveSelectedScenarioGroup("https://vvcode.top/", 7, "claude", "pro");

    expect(loadSelectedScenarioGroup("https://vvcode.top", 7, "claude")).toBe(
      "pro",
    );
    expect(loadSelectedScenarioGroup("https://vvcode.top", 8, "claude")).toBe(
      "",
    );
    expect(loadSelectedScenarioGroup("https://vvcode.top", 7, "codex")).toBe(
      "",
    );
    expect(
      loadSelectedScenarioGroup("https://other.example", 7, "claude"),
    ).toBe("");
  });

  it("removes an empty selection", () => {
    saveSelectedScenarioGroup("https://vvcode.top", 7, "claude", "pro");
    saveSelectedScenarioGroup("https://vvcode.top", 7, "claude", "  ");

    expect(loadSelectedScenarioGroup("https://vvcode.top", 7, "claude")).toBe(
      "",
    );
  });
});
