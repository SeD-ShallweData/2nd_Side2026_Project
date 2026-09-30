import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getCompanyFilterOptions, searchCompanies } from "@/services/companyService";

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
    ["회사", 20, 101],
  ] as const)("rejects an out-of-bound public search (%s, %i, %i)", async (query, limit, page) => {
    vi.stubEnv("APP_DATA_MODE", "mock");
    await expect(searchCompanies(query, limit, page)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("accepts page 100 at the expanded search boundary", async () => {
    vi.stubEnv("APP_DATA_MODE", "mock");
    await expect(searchCompanies("회사", 20, 100)).resolves.toMatchObject({ page: 100 });
  });

  it("publishes exact filter counts and the exact total", async () => {
    vi.stubEnv("APP_DATA_MODE", "mock");
    const options = await getCompanyFilterOptions();
    expect(options.total).toBe(9);
    expect(options.regions.reduce((sum, entry) => sum + entry.count, 0)).toBe(9);
    expect(options.regions[0]).toEqual({ value: "서울특별시", count: 1 });
  });
});
