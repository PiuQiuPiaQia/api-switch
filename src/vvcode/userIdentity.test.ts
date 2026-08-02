import { describe, expect, it } from "vitest";
import { resolveAccountName } from "./userIdentity";

describe("resolveAccountName", () => {
  it("prefers the account username", () => {
    expect(
      resolveAccountName({ username: "alice", displayName: "Root User" }),
    ).toBe("alice");
  });

  it("falls back when the username is unavailable", () => {
    expect(
      resolveAccountName({ username: "  ", displayName: "Alice Chen" }),
    ).toBe("Alice Chen");
  });
});
