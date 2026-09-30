import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/utils/errors";

const { queryReadOnlyMock } = vi.hoisted(() => ({
  queryReadOnlyMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/postgres", () => ({
  queryReadOnly: queryReadOnlyMock,
}));

import { LATEST_DRIFT_CHECK } from "@/config/driftCheckRecord";
import type { BatchDomainStatus, BatchStatus } from "@/domain/batch";
import { clearAggregateCache } from "@/server/aggregateCache";
import { listBatchStatuses, SAFETY_GRADE_SQL, WAGE_GRADE_SQL } from "@/services/batchService";

const NOW = new Date("2026-09-30T03:00:00Z"); // 한국 시각 2026-09-30 12:00

const BATCH_ROWS: BatchStatus[] = [
  {
    batch_id: 7,
    data_as_of: "2026-06-01",
    target_month: "2026-12-01",
    model_version: "model-v1",
    model_sha: "abc123",
    ingested_at: "2026-09-20 15:26:00+09",
    ingested_date: "2026-09-20",
    source: "canonical",
    n_scored: 553598,
    n_queue: 3000,
    n_safe: 503887,
    is_active: true,
    is_pinned: false,
  },
  {
    batch_id: 8,
    data_as_of: null,
    target_month: null,
    model_version: "draft-v1",
    model_sha: null,
    ingested_at: "2026-09-01 00:00:00+09",
    ingested_date: "2026-09-01",
    source: null,
    n_scored: 0,
    n_queue: 0,
    n_safe: 0,
    is_active: false,
    is_pinned: false,
  },
];

/* aggregation-spec.md §2 · §8.3 의 비율에 맞춘 값. */
const WAGE_GRADES = { total: 553598, normal_count: 32607, watch_count: 431641, review_count: 22088, unknown_count: 67262 };
const SAFETY_GRADES = {
  total: 515608, top1_count: 5156, top5_count: 20727, top10_count: 25677, normal_count: 464048,
  prediction_as_of: "2026-04-19", target_week_start: "2026-04-20", target_week_end: "2026-04-26", stale_count: 515608,
};

type Handler = (values: unknown[]) => unknown[];

function route({ batches = BATCH_ROWS as unknown[], wage, safety }: { batches?: unknown[]; wage?: Handler; safety?: Handler } = {}) {
  queryReadOnlyMock.mockImplementation(async (sql: string, values: unknown[] = []) => {
    if (sql === WAGE_GRADE_SQL) return wage ? wage(values) : [WAGE_GRADES];
    if (sql === SAFETY_GRADE_SQL) return safety ? safety(values) : [SAFETY_GRADES];
    if (sql.includes("FROM public.batches b")) return batches;
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  });
}

function domain(domains: BatchDomainStatus[] | undefined, key: "wage" | "safety"): BatchDomainStatus {
  const found = domains?.find((item) => item.domain === key);
  if (!found) throw new Error(`missing ${key}`);
  return found;
}

const unreadable = () => new ServiceError("DATABASE_UNAVAILABLE", "사업장 데이터베이스를 읽지 못했습니다.", 503, true);

describe("배치 현황 조회", () => {
  beforeEach(() => {
    queryReadOnlyMock.mockReset();
    clearAggregateCache();
  });

  it("실제 batches 테이블에서 현재 배치와 전체 이력을 함께 읽는다", async () => {
    route();
    const result = await listBatchStatuses(NOW);
    const sql = String(queryReadOnlyMock.mock.calls[0]?.[0]).replace(/\s+/g, " ").trim();

    expect(sql).toContain("FROM public.batches");
    expect(sql).toContain("WHERE as_of_date IS NOT NULL");
    expect(sql).toContain("AND (is_active OR NOT EXISTS (SELECT 1 FROM public.batches pinned WHERE pinned.is_active))");
    expect(sql).toContain("b.is_active AS is_pinned");
    expect(sql).toContain("to_char(b.ingested_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS ingested_date");
    expect(sql).toContain("ORDER BY as_of_date DESC, ingested_at DESC, id DESC LIMIT 1");
    expect(sql).toContain("ORDER BY b.as_of_date DESC NULLS LAST, b.ingested_at DESC, b.id DESC");
    expect(result.selection_mode).toBe("auto");
    expect(result.current?.batch_id).toBe(7);
    expect(result.batches.map((batch) => batch.batch_id)).toEqual([7, 8]);
    expect(result.generated_at).toBe(NOW.toISOString());
  });

  it("운영자가 고정한 배치가 있으면 selection_mode 가 pinned 다", async () => {
    route({
      batches: [
        { ...BATCH_ROWS[0], batch_id: 7, is_active: false, is_pinned: false },
        { ...BATCH_ROWS[0], batch_id: 6, data_as_of: "2026-05-01", is_active: true, is_pinned: true },
      ],
    });
    const result = await listBatchStatuses(NOW);
    expect(result.selection_mode).toBe("pinned");
    expect(result.current?.batch_id).toBe(6);
    // 임금 등급 분포는 서비스(고정) 배치로 센다.
    const wageCall = queryReadOnlyMock.mock.calls.find(([sql]) => sql === WAGE_GRADE_SQL);
    expect(wageCall?.[1]).toEqual([6]);
  });

  it("임금체불·산업재해를 따로 내보내고 각자 정의서의 4종 등급을 쓴다", async () => {
    route();
    const result = await listBatchStatuses(NOW);

    expect(result.domains?.map((item) => item.domain)).toEqual(["wage", "safety"]);
    const wage = domain(result.domains, "wage");
    const safety = domain(result.domains, "safety");

    expect(wage.grades.status).toBe("ok");
    if (wage.grades.status !== "ok") throw new Error("unreachable");
    expect(wage.grades.items.map((item) => item.label)).toEqual([
      "뚜렷한 이상 신호 없음", "안전 신호 미확인", "우선 확인 필요", "분석 자료 부족",
    ]);
    expect(wage.grades.items.map((item) => item.ratio)).toEqual([5.89, 77.97, 3.99, 12.15]);
    // watch 는 회색(중립)만, unknown 은 자료 부족 톤 — 임금 쪽에는 긍정 톤이 없다.
    expect(wage.grades.items.map((item) => item.tone)).toEqual(["neutral", "neutral", "priority", "insufficient"]);

    expect(safety.grades.status).toBe("ok");
    if (safety.grades.status !== "ok") throw new Error("unreachable");
    expect(safety.grades.items.map((item) => item.label)).toEqual(["상위1%", "상위5%", "상위10%", "일반"]);
    expect(safety.grades.items.map((item) => item.ratio)).toEqual([1, 4.02, 4.98, 90]);

    expect(wage.row_count).toBe(553598);
    expect(safety.row_count).toBe(515608);
    expect(wage.reference_row_count).toBe(553598);
    expect(safety.reference_row_count).toBe(515608);
  });

  it("wg_bot 기본 권한 안의 관계만 읽는다", () => {
    const readable = new Set(["public.scored_active", "public.safe_recommendation", "industrial_safety.v_llm_firm_safety_context"]);
    for (const sql of [WAGE_GRADE_SQL, SAFETY_GRADE_SQL]) {
      const relations = [...sql.matchAll(/\b(?:FROM|JOIN)\s+((?:public|industrial_safety)\.[a-z_]+)/gi)].map((match) => match[1]);
      expect(relations.length).toBeGreaterThan(0);
      for (const relation of relations) expect(readable.has(relation!), relation).toBe(true);
    }
    expect(WAGE_GRADE_SQL).not.toContain("v_current");
    expect(WAGE_GRADE_SQL).toContain("s.batch_id = $1");
  });

  it("§1 산업재해는 대상 주가 지나 stale, 임금은 대상 월 전이라 stale 아님, 둘 다 M2 는 검사 불가", async () => {
    route();
    const result = await listBatchStatuses(NOW);
    const wage = domain(result.domains, "wage");
    const safety = domain(result.domains, "safety");

    expect(wage).toMatchObject({ as_of: "2026-06-01", target: "2026-12-01", stale: false, as_of_window_check: "unverifiable" });
    expect(safety).toMatchObject({ as_of: "2026-04-19", target: "2026-04-20 ~ 2026-04-26", stale: true, as_of_window_check: "unverifiable" });
    expect(safety.stale_detail).toContain("515,608곳 / 515,608곳");
  });

  it("§5 유효기간은 임금만 적재일+1개월 추정, 산업재해는 null 이라 '갱신 확인 필요'", async () => {
    route();
    const result = await listBatchStatuses(NOW);
    const wage = domain(result.domains, "wage");
    const safety = domain(result.domains, "safety");

    expect(wage.valid_until).toBe("2026-10-20");
    expect(wage.valid_until_note).toContain("추정");
    expect(safety.valid_until).toBeNull();
    expect(safety.valid_until_note).toContain("갱신 확인 필요");
  });

  it("추정 기한이 지났으면 '기한 지남 — 갱신 확인 필요'", async () => {
    route({ batches: [{ ...BATCH_ROWS[0], ingested_date: "2026-08-01" }] });
    const result = await listBatchStatuses(NOW);
    expect(domain(result.domains, "wage").valid_until_note).toContain("기한 지남");
  });

  it("등급 집계를 읽지 못해도 페이지는 실패하지 않고 그 칸만 검사 불가가 된다", async () => {
    route({
      wage: () => { throw unreadable(); },
      safety: () => { throw unreadable(); },
    });
    const result = await listBatchStatuses(NOW);
    const wage = domain(result.domains, "wage");
    const safety = domain(result.domains, "safety");

    expect(result.batches).toHaveLength(2);
    expect(wage.grades).toEqual({ status: "unavailable", reason: "현재 읽기 권한으로 이 집계를 읽지 못했습니다." });
    expect(safety.grades.status).toBe("unavailable");
    // batches 에서 오는 값은 그대로 보인다.
    expect(wage.row_count).toBe(553598);
    // 산업재해 행수·stale 은 읽지 못했으므로 추정하지 않는다.
    expect(safety.row_count).toBeNull();
    expect(safety.stale).toBeNull();
    expect(safety.target).toBeNull();
  });

  it("같은 배치의 등급 집계는 캐시하고, 실패는 캐시하지 않는다", async () => {
    let wageCalls = 0;
    route({
      wage: () => {
        wageCalls += 1;
        if (wageCalls === 1) throw unreadable();
        return [WAGE_GRADES];
      },
    });
    const first = await listBatchStatuses(NOW);
    expect(domain(first.domains, "wage").grades.status).toBe("unavailable");
    const second = await listBatchStatuses(NOW);
    expect(domain(second.domains, "wage").grades.status).toBe("ok");
    await listBatchStatuses(NOW);
    expect(wageCalls).toBe(2);
    expect(queryReadOnlyMock.mock.calls.filter(([sql]) => sql === SAFETY_GRADE_SQL)).toHaveLength(1);
  });

  it("채점 행수가 batches.n_scored 와 다르면 행수 출처에 적재 확인 필요를 적는다", async () => {
    route({ wage: () => [{ ...WAGE_GRADES, total: 500000 }] });
    const result = await listBatchStatuses(NOW);
    expect(domain(result.domains, "wage").row_count_source).toContain("적재 확인 필요");
  });

  it("서비스 배치가 없으면 임금 등급은 검사 불가, 산업재해는 따로 계산한다", async () => {
    route({ batches: [] });
    const result = await listBatchStatuses(NOW);
    expect(domain(result.domains, "wage").grades.status).toBe("unavailable");
    expect(domain(result.domains, "wage").stale).toBeNull();
    expect(domain(result.domains, "safety").grades.status).toBe("ok");
    expect(queryReadOnlyMock.mock.calls.some(([sql]) => sql === WAGE_GRADE_SQL)).toBe(false);
  });

  it("최근 드리프트 검사 결과(수동 기입)를 함께 내보낸다", async () => {
    route();
    const result = await listBatchStatuses(NOW);
    expect(result.drift).toBe(LATEST_DRIFT_CHECK);
    expect(result.drift).toMatchObject({ source: "manual", checked_at: "2026-09-29", result: "aligned" });
  });
});
