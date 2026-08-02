import { describe, expect, it } from "vitest";
import type { ToolEnvironmentSnapshot, ToolVersionInfo } from "./types";
import { isToolEnvironmentReady } from "./toolEnvironment";

const info: ToolVersionInfo = {
  name: "Gemini CLI",
  version: "0.53.1",
  latest_version: "0.53.1",
  error: null,
  installed_but_broken: false,
  env_type: "macos",
  wsl_distro: null,
};

describe("VV Code tool environment readiness", () => {
  it("uses the same successful version probe as CC Switch", () => {
    const environment: ToolEnvironmentSnapshot = {
      info,
    };

    expect(isToolEnvironmentReady(environment)).toBe(true);
  });

  it("accepts every environment type after the shared version probe succeeds", () => {
    const environment: ToolEnvironmentSnapshot = {
      info: { ...info, env_type: "wsl", wsl_distro: "Ubuntu" },
    };

    expect(isToolEnvironmentReady(environment)).toBe(true);
  });

  it("rejects missing and non-runnable clients before configuration", () => {
    expect(
      isToolEnvironmentReady({
        info: { ...info, version: null },
      }),
    ).toBe(false);
    expect(
      isToolEnvironmentReady({
        info: { ...info, version: null, installed_but_broken: true },
      }),
    ).toBe(false);
  });
});
