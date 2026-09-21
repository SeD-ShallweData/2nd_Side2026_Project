import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { searchCompanies } from "@/services/companyService";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("public company search request bounds", () => {
  it("does not allow an unfiltered full-directory request", async () => {
    vi.stubEnv("APP_DATA_MODE", "mock");
    await expect(searchCompanies("", 20, 1)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it.each([
    ["회사", 21, 1],
    ["회사", 20, 100_001],
  ] as const)("rejects an out-of-bound public search (%s, %i, %i)", async (query, limit, page) => {
    vi.stubEnv("APP_DATA_MODE", "mock");
    await expect(searchCompanies(query, limit, page)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
