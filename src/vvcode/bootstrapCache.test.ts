import { beforeEach, describe, expect, it } from "vitest";
import { previewBootstrap } from "./mockData";
import {
  clearCachedBootstraps,
  loadCachedBootstrap,
  saveCachedBootstrap,
} from "./bootstrapCache";

describe("bootstrap cache", () => {
  beforeEach(() => window.localStorage.clear());

  it("stores bootstrap data by user and application", () => {
    saveCachedBootstrap(1024, "claude-code", previewBootstrap);

    expect(loadCachedBootstrap(1024, "claude-code")).toEqual(previewBootstrap);
    expect(loadCachedBootstrap(1024, "codex")).toBeNull();
    expect(loadCachedBootstrap(2048, "claude-code")).toBeNull();
  });

  it("ignores malformed or mismatched cached users", () => {
    saveCachedBootstrap(2048, "claude-code", previewBootstrap);

    expect(loadCachedBootstrap(2048, "claude-code")).toBeNull();
  });

  it("clears only the selected user's bootstrap entries", () => {
    saveCachedBootstrap(1024, undefined, previewBootstrap);
    saveCachedBootstrap(1024, "claude-code", previewBootstrap);
    const otherUserBootstrap = {
      ...previewBootstrap,
      user: { ...previewBootstrap.user, id: 2048 },
    };
    saveCachedBootstrap(2048, "claude-code", otherUserBootstrap);

    clearCachedBootstraps(1024);

    expect(loadCachedBootstrap(1024, undefined)).toBeNull();
    expect(loadCachedBootstrap(1024, "claude-code")).toBeNull();
    expect(loadCachedBootstrap(2048, "claude-code")).toEqual(
      otherUserBootstrap,
    );
  });
});
