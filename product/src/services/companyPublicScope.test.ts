import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { publicCountBand, searchCompanies } from "@/services/companyService";

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
    ["회사", 20, 51],
  ] as const)("rejects an out-of-bound public search (%s, %i, %i)", async (query, limit, page) => {
    vi.stubEnv("APP_DATA_MODE", "mock");
    await expect(searchCompanies(query, limit, page)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it.each([
    [0, 0, "0"], [1, 1, "1–9"], [49, 10, "10–49"],
    [99, 50, "50–99"], [499, 100, "100–499"], [999, 500, "500–999"], [1_000, 1_000, "1,000+"],
  ] as const)("publishes count %i as a range", (raw, count, label) => {
    expect(publicCountBand(raw)).toEqual({ count, count_label: label });
  });
});
