import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryReadOnlyMock } = vi.hoisted(() => ({
  queryReadOnlyMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/postgres", () => ({
  queryReadOnly: queryReadOnlyMock,
}));

import { listBatchStatuses } from "@/services/batchService";

describe("배치 현황 조회", () => {
  beforeEach(() => {
    queryReadOnlyMock.mockReset();
    queryReadOnlyMock.mockResolvedValue([
      {
        batch_id: 7,
        data_as_of: "2026-06-01",
        target_month: "2026-12-01",
        model_version: "model-v1",
        model_sha: "abc123",
        ingested_at: "2026-08-07T06:26:00Z",
        source: "canonical",
        n_scored: 553598,
        n_queue: 3000,
        n_safe: 503887,
        is_active: true,
      },
      {
        batch_id: 8,
        data_as_of: null,
        target_month: null,
        model_version: "draft-v1",
        model_sha: null,
        ingested_at: "2026-09-01T00:00:00Z",
        source: null,
        n_scored: 0,
        n_queue: 0,
        n_safe: 0,
        is_active: false,
      },
    ]);
  });

  it("실제 batches 테이블에서 현재 배치와 전체 이력을 함께 읽는다", async () => {
    const result = await listBatchStatuses();
    const sql = String(queryReadOnlyMock.mock.calls[0]?.[0]).replace(/\s+/g, " ").trim();

    expect(queryReadOnlyMock).toHaveBeenCalledOnce();
    expect(sql).toContain("FROM public.batches");
    expect(sql).toContain("WHERE as_of_date IS NOT NULL");
    expect(sql).toContain("ORDER BY as_of_date DESC, ingested_at DESC, id DESC LIMIT 1");
    expect(sql).toContain("ORDER BY b.as_of_date DESC NULLS LAST, b.ingested_at DESC, b.id DESC");
    expect(result.selection_mode).toBe("auto");
    expect(result.current?.batch_id).toBe(7);
    expect(result.batches.map((batch) => batch.batch_id)).toEqual([7, 8]);
    expect(Number.isNaN(Date.parse(result.generated_at))).toBe(false);
  });
});
