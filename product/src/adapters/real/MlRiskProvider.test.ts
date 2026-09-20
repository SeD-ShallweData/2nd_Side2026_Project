import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeFreshness, getNextBatchDueDate } from "@/adapters/real/MlRiskProvider";

describe("getNextBatchDueDate", () => {
  it("입력한 날짜에서 정확히 1개월 뒤를 반환한다", () => {
    expect(getNextBatchDueDate("2026-06-15")).toBe("2026-07-15");
  });

  it("배치 실행 시각(ingested_at) 기준으로 계산한다 — as_of_date(t-6)와는 다른 값이 나온다", () => {
    // as_of_date=2026-06-01(국민연금 관측월)이어도, 실제 배치 실행일(ingested_at)이
    // 2026-08-11이면 화면 유효기간은 반드시 2026-09-11이어야 한다.
    expect(getNextBatchDueDate("2026-08-11")).toBe("2026-09-11");
  });

  it("말일 기준일은 다음달 말일로 clamp한다", () => {
    expect(getNextBatchDueDate("2026-01-31")).toBe("2026-02-28");
  });

  it("잘못된 형식이나 null은 null을 반환한다", () => {
    expect(getNextBatchDueDate(null)).toBeNull();
    expect(getNextBatchDueDate("2026-13-40")).toBeNull();
    expect(getNextBatchDueDate("not-a-date")).toBeNull();
  });
});

describe("computeFreshness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("유효기간을 계산할 수 없으면 unknown이다", () => {
    expect(computeFreshness(null)).toBe("unknown");
  });

  it("오늘이 유효기간 이전이거나 당일이면 current이다", () => {
    expect(computeFreshness("2026-09-16")).toBe("current");
    expect(computeFreshness("2026-09-15")).toBe("current");
  });

  it("오늘이 유효기간을 지났으면 expired이다", () => {
    expect(computeFreshness("2026-09-14")).toBe("expired");
  });
});
