import { describe, expect, it } from "vitest";
import type { ToolInstallationReport } from "@/lib/api/settings";
import type { ToolEnvironmentSnapshot, ToolVersionInfo } from "./types";
import {
  hasToolPathMismatch,
  isToolEnvironmentReady,
  toolPathMismatchDescription,
} from "./toolEnvironment";

const info: ToolVersionInfo = {
  name: "Gemini CLI",
  version: "0.53.1",
  latest_version: "0.53.1",
  error: null,
  installed_but_broken: false,
  env_type: "macos",
  wsl_distro: null,
};

function report(isPathDefault: boolean): ToolInstallationReport {
  return {
    tool: "gemini",
    installs: [
      {
        path: "/Users/tester/.nvm/versions/node/v20/bin/gemini",
        version: "0.53.1",
        runnable: true,
        error: null,
        source: "nvm",
        is_path_default: isPathDefault,
      },
    ],
    is_conflict: false,
    needs_confirmation: false,
    command: "npm i -g @google/gemini-cli@latest",
    anchored: true,
  };
}

describe("VV Code tool environment readiness", () => {
  it("requires a runnable PATH-default installation", () => {
    const environment: ToolEnvironmentSnapshot = {
      info,
      installationReport: report(true),
    };

    expect(isToolEnvironmentReady(environment)).toBe(true);
    expect(hasToolPathMismatch(environment)).toBe(false);
  });

  it("rejects a runnable installation hidden in another Node prefix", () => {
    const environment: ToolEnvironmentSnapshot = {
      info,
      installationReport: report(false),
    };

    expect(isToolEnvironmentReady(environment)).toBe(false);
    expect(hasToolPathMismatch(environment)).toBe(true);
    expect(toolPathMismatchDescription("Gemini CLI", environment)).toContain(
      "一键修复",
    );
    expect(toolPathMismatchDescription("Gemini CLI", environment)).not.toContain(
      "/Users/tester/.nvm/versions/node/v20/bin/gemini",
    );
  });

  it("keeps WSL readiness tied to its in-distro shell probe", () => {
    const environment: ToolEnvironmentSnapshot = {
      info: { ...info, env_type: "wsl", wsl_distro: "Ubuntu" },
      installationReport: {
        ...report(false),
        installs: [],
      },
    };

    expect(isToolEnvironmentReady(environment)).toBe(true);
    expect(hasToolPathMismatch(environment)).toBe(false);
  });

  it("rejects missing and non-runnable clients before configuration", () => {
    expect(
      isToolEnvironmentReady({
        info: { ...info, version: null },
        installationReport: { ...report(false), installs: [] },
      }),
    ).toBe(false);
    expect(
      isToolEnvironmentReady({
        info: { ...info, version: null, installed_but_broken: true },
        installationReport: report(false),
      }),
    ).toBe(false);
  });
});
