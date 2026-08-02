import { describe, expect, it } from "vitest";
import {
  resolveChatApiBaseUrl,
  shouldShowMessageLoading,
} from "./ChatRuntime";

describe("resolveChatApiBaseUrl", () => {
  it("adds the NewAPI v1 prefix when a group exposes the server root", () => {
    expect(resolveChatApiBaseUrl("https://vvcode.top")).toBe(
      "https://vvcode.top/v1",
    );
  });

  it("keeps an existing v1 base URL without duplicating the prefix", () => {
    expect(resolveChatApiBaseUrl("https://vvcode.top/v1/")).toBe(
      "https://vvcode.top/v1",
    );
  });

  it("preserves a hosted subpath when adding the v1 prefix", () => {
    expect(resolveChatApiBaseUrl("https://example.com/newapi/")).toBe(
      "https://example.com/newapi/v1",
    );
  });
});

describe("shouldShowMessageLoading", () => {
  it("only displays the empty-message loader while the response is running", () => {
    expect(shouldShowMessageLoading({ type: "running" })).toBe(true);
    expect(shouldShowMessageLoading({ type: "complete" })).toBe(false);
    expect(
      shouldShowMessageLoading({
        type: "incomplete",
        reason: "error",
        error: "request failed",
      }),
    ).toBe(false);
  });
});
