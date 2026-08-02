import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT } from "./config";
import {
  applyPreparedManagedConfiguration,
  buildManagedProvider,
} from "./configuration";
import type { NewApiGroup } from "./types";

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  addProvider: vi.fn(),
  updateProvider: vi.fn(),
  switchProvider: vi.fn(),
}));

vi.mock("@/lib/api/providers", () => ({
  providersApi: {
    getAll: mocks.getProviders,
    add: mocks.addProvider,
    update: mocks.updateProvider,
    switch: mocks.switchProvider,
  },
}));

const group: NewApiGroup = {
  id: "daily",
  name: "日常开发",
  description: "",
  ratio: "1",
  baseUrl: "https://api.example.com",
  apiKey: "sk-test",
  defaultModelId: "model-primary",
  apiProvider: "anthropic",
  ccProvider: "anthropic",
  isDefault: true,
  models: [],
};

describe("managed configuration application", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviders.mockResolvedValue({});
    mocks.addProvider.mockResolvedValue(undefined);
    mocks.switchProvider.mockResolvedValue(undefined);
  });

  it("activates Claude Desktop through the direct profile", async () => {
    const scenario = PRODUCT.scenarios.find(
      (item) => item.id === "claude-desktop",
    )!;
    const provider = buildManagedProvider(scenario, group);

    await applyPreparedManagedConfiguration(scenario, group, provider);

    expect(mocks.switchProvider).toHaveBeenCalledWith(
      PRODUCT.managedProviderId,
      "claude-desktop",
    );
  });
});
