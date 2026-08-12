import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryReadOnlyMock } = vi.hoisted(() => ({
  queryReadOnlyMock: vi.fn(),
}));

vi.mock("@/server/postgres", () => ({
  queryReadOnly: queryReadOnlyMock,
}));
vi.mock("server-only", () => ({}));

import { MlRiskProvider } from "@/adapters/real/MlRiskProvider";
import { RealCompanyRepository } from "@/adapters/real/RealCompanyRepository";
import { getInspectorCompanyDetail, getInspectorOverview } from "@/services/inspectorService";

function expectCurrentBatchSelection(sql: unknown): void {
  expect(typeof sql).toBe("string");
  const normalized = String(sql).replace(/\s+/g, " ").trim();

  expect(normalized).toContain("WHERE as_of_date IS NOT NULL");
  expect(normalized).toContain(
    "ORDER BY as_of_date DESC, ingested_at DESC, id DESC LIMIT 1",
  );
  expect(normalized).not.toContain("ORDER BY ingested_at DESC, id DESC LIMIT 1");
}

describe("최신 배치 선택 회귀", () => {
  beforeEach(() => {
    queryReadOnlyMock.mockReset();
    queryReadOnlyMock.mockResolvedValue([]);
  });

  it("사업장 상세가 늦게 적재된 과거월보다 최신 기준월을 선택한다", async () => {
    await new RealCompanyRepository().getById("firm-1");
    expectCurrentBatchSelection(queryReadOnlyMock.mock.calls[0]?.[0]);
  });

  it("공개 위험 조회가 늦게 적재된 과거월보다 최신 기준월을 선택한다", async () => {
    await new MlRiskProvider().getCompanyRisk("firm-1");
    expectCurrentBatchSelection(queryReadOnlyMock.mock.calls[0]?.[0]);
  });

  it("감독관 요약이 늦게 적재된 과거월보다 최신 기준월을 선택한다", async () => {
    await expect(getInspectorOverview()).rejects.toMatchObject({
      code: "INSPECTOR_DATA_NOT_FOUND",
    });
    expectCurrentBatchSelection(queryReadOnlyMock.mock.calls[0]?.[0]);
  });

  it("감독관 사업장 상세가 늦게 적재된 과거월보다 최신 기준월을 선택한다", async () => {
    await expect(getInspectorCompanyDetail("firm-1")).rejects.toMatchObject({
      code: "COMPANY_NOT_FOUND",
    });
    expectCurrentBatchSelection(queryReadOnlyMock.mock.calls[0]?.[0]);
  });
});
