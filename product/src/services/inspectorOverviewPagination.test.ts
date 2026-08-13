import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryReadOnlyMock } = vi.hoisted(() => ({
  queryReadOnlyMock: vi.fn(),
}));

vi.mock("@/server/postgres", () => ({
  queryReadOnly: queryReadOnlyMock,
}));
vi.mock("server-only", () => ({}));

import { getInspectorOverview } from "@/services/inspectorService";

const batch = {
  batch_id: 17,
  data_as_of: "2026-07-31",
  target_month: "2026-08-01",
  model_version: "test-v1",
  ingested_at: "2026-08-01T00:00:00Z",
  n_scored: 1_000,
  n_queue: 3_000,
  n_safe: 200,
};

describe("근로감독관 위험큐 페이지네이션", () => {
  beforeEach(() => {
    queryReadOnlyMock.mockReset();
  });

  it("10개 단위 페이지를 상위 100위 안에서 조회한다", async () => {
    queryReadOnlyMock
      .mockResolvedValueOnce([batch])
      .mockResolvedValueOnce([{ grade: "긴급", count: 100 }])
      .mockResolvedValueOnce([{
        firm_id: "firm-31",
        name: "테스트건설",
        sido: "경기도",
        industry: "건설업",
        rank: 31,
        grade: "긴급",
        risk_full: 0.91,
        reasons: ["확인 사유"],
      }]);

    const result = await getInspectorOverview(10, 4);
    const queueQuery = queryReadOnlyMock.mock.calls[2];

    expect(String(queueQuery?.[0]).replace(/\s+/g, " ")).toContain("q.rank <= $4");
    expect(String(queueQuery?.[0]).replace(/\s+/g, " ")).toContain("LIMIT $2 OFFSET $3");
    expect(queueQuery?.[1]).toEqual([17, 10, 30, 100]);
    expect(result.queue_pagination).toEqual({
      page: 4,
      page_size: 10,
      total_items: 100,
      total_pages: 10,
      has_previous: true,
      has_more: true,
    });
    expect(result.top_queue[0]?.rank).toBe(31);
  });

  it("100위를 넘는 페이지 요청을 거절한다", async () => {
    await expect(getInspectorOverview(10, 11)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    });
    expect(queryReadOnlyMock).not.toHaveBeenCalled();
  });
});
