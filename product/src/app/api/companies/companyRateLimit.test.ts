import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/services/companyService", () => ({
  searchCompanies: async () => ({ items: [], total: 0 }),
  getCompanyFilterOptions: async () => ({ regions: [], industries: [] }),
}));
vi.mock("@/services/riskService", () => ({
  getCompanyRisk: async (companyId: string) => ({ company_id: companyId }),
}));

import { GET as riskRoute } from "@/app/api/companies/[companyId]/risk/route";
import { GET as filtersRoute } from "@/app/api/companies/filters/route";
import { GET as searchRoute } from "@/app/api/companies/search/route";
import { resetPublicRateLimitsForTests } from "@/server/publicRateLimit";

const MARKER = "00000000-0000-4000-8000-0000000000c1";

function request(path: string): Request {
  return new Request(`http://localhost${path}`, { headers: { "x-moneyworry-client-id": MARKER } });
}

const ROUTES = [
  ["GET /api/companies/search", () => searchRoute(request("/api/companies/search?q=company"))],
  ["GET /api/companies/filters", () => filtersRoute(request("/api/companies/filters"))],
  ["GET /api/companies/{companyId}/risk", () => riskRoute(
    request("/api/companies/COMPANY_DEMO_001/risk"),
    { params: Promise.resolve({ companyId: "COMPANY_DEMO_001" }) },
  )],
] as const;

beforeEach(() => {
  // 시연 면제가 끝난 시각, 방문자 주소를 모르는 운영 설정 그대로 탭 표시값 한 개로 센다.
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("PUBLIC_COMPANY_SEARCH_PER_MINUTE", "1");
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-01T15:00:00.000Z"));
});

afterEach(() => {
  resetPublicRateLimitsForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("회사 조회 호출 한도 응답", () => {
  it.each(ROUTES)("%s: 한도를 넘으면 429 와 함께 남은 시간을 Retry-After 헤더로도 보낸다", async (_name, call) => {
    expect((await call()).status).toBe(200);

    const limited = await call();

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toMatchObject({
      error: { code: "PUBLIC_RATE_LIMITED", details: [{ field: "retry_after_seconds", reason: "60" }] },
    });
  });
});
