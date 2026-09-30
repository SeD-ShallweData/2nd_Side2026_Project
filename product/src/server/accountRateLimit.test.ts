import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ACCOUNT_RATE_LIMITS,
  FREE_RETRIES_PER_REQUEST,
  accountRateLimitBucketCountForTests,
  assertAccountRateLimit,
  resetAccountRateLimitsForTests,
} from "@/server/accountRateLimit";
import { formatRetryWait } from "@/server/rateLimitCounter";
import { retryAfterHeaders, ServiceError } from "@/utils/errors";

const USER_A = "00000000-0000-4000-8000-00000000000a";
const USER_B = "00000000-0000-4000-8000-00000000000b";
const NOW = Date.parse("2026-10-02T00:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

function limitOf(action: keyof typeof ACCOUNT_RATE_LIMITS, name: "hour" | "day"): number {
  const window = ACCOUNT_RATE_LIMITS[action].perAccount.find((candidate) => candidate.name === name);
  if (!window) throw new Error(`${action} ${name} 한도가 없습니다.`);
  return window.limit;
}

function siteLimitOf(action: keyof typeof ACCOUNT_RATE_LIMITS, name: "hour" | "day"): number {
  const window = ACCOUNT_RATE_LIMITS[action].siteWide?.windows.find((candidate) => candidate.name === name);
  if (!window) throw new Error(`${action} 사이트 전체 ${name} 한도가 없습니다.`);
  return window.limit;
}

function hasSiteLimit(action: keyof typeof ACCOUNT_RATE_LIMITS, name: "hour" | "day"): boolean {
  return ACCOUNT_RATE_LIMITS[action].siteWide?.windows.some((candidate) => candidate.name === name) ?? false;
}

function captureError(action: () => void): ServiceError {
  try {
    action();
  } catch (error) {
    if (error instanceof ServiceError) return error;
    throw error;
  }
  throw new Error("한도 오류가 나지 않았습니다.");
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
});

afterEach(() => {
  resetAccountRateLimitsForTests();
  vi.unstubAllEnvs();
});

describe("계정 단위 한도", () => {
  it("시간당 한도까지 통과시키고 다음 요청은 429 와 남은 시간을 돌려준다", () => {
    const hourly = limitOf("contract_review", "hour");
    for (let index = 0; index < hourly; index += 1) {
      assertAccountRateLimit("contract_review", USER_A, { now: NOW + index });
    }

    const error = captureError(() => assertAccountRateLimit("contract_review", USER_A, { now: NOW + hourly }));

    expect(error).toMatchObject({ code: "ACCOUNT_RATE_LIMITED", status: 429, retryable: true });
    const seconds = Math.ceil((HOUR - hourly) / 1_000);
    expect(error.details).toEqual([{ field: "retry_after_seconds", reason: String(seconds) }]);
    expect(error.message).toBe("계약서 분석 요청이 너무 많습니다. 1시간 뒤에 다시 시도해 주세요.");
    expect(retryAfterHeaders(error)).toEqual({ "Retry-After": String(seconds) });
  });

  it("계정과 동작을 따로 센다", () => {
    const hourly = limitOf("contract_review", "hour");
    for (let index = 0; index < hourly; index += 1) {
      assertAccountRateLimit("contract_review", USER_A, { now: NOW });
    }
    expect(() => assertAccountRateLimit("contract_review", USER_A, { now: NOW })).toThrow(ServiceError);

    expect(() => assertAccountRateLimit("contract_review", USER_B, { now: NOW })).not.toThrow();
    expect(() => assertAccountRateLimit("chat", USER_A, { now: NOW })).not.toThrow();
  });

  it("시간 창이 끝나면 다시 허용하지만 하루 창이 차 있으면 하루 창이 풀릴 때까지 막는다", () => {
    const hourly = limitOf("contract_review", "hour");
    const daily = limitOf("contract_review", "day");
    let sent = 0;
    for (let hour = 0; sent < daily; hour += 1) {
      for (let index = 0; index < hourly && sent < daily; index += 1) {
        assertAccountRateLimit("contract_review", USER_A, { now: NOW + hour * HOUR });
        sent += 1;
      }
    }
    const hoursUsed = Math.ceil(daily / hourly);

    const error = captureError(() => assertAccountRateLimit("contract_review", USER_A, { now: NOW + hoursUsed * HOUR }));
    expect(error.code).toBe("ACCOUNT_RATE_LIMITED");
    // 막힌 창 가운데 가장 늦게 풀리는 하루 창 기준으로 알려 준다.
    expect(error.details).toEqual([{ field: "retry_after_seconds", reason: String((DAY - hoursUsed * HOUR) / 1_000) }]);

    expect(() => assertAccountRateLimit("contract_review", USER_A, { now: NOW + DAY })).not.toThrow();
  });

  /*
   * 가입 상한 안에서도 하루 1,000개까지 계정을 만들 수 있다. 계정마다 한도를 새로 받으므로
   * LLM 비용(상담·계약서)과 저장 공간(제보·게시글·신고)은 사이트 전체 상한이 묶는다.
   */
  it.each([
    "chat",
    "contract_review",
    "worksite_tip",
    "community_post",
    "community_report",
  ] as const)("%s: 계정을 바꿔 가며 써도 사이트 전체 하루 상한에서 막는다", (action) => {
    const siteDaily = siteLimitOf(action, "day");
    // 시간당 전체 상한이 있으면 먼저 걸리므로 한 시간에 그만큼씩 나눠 보낸다.
    const siteHourly = hasSiteLimit(action, "hour") ? siteLimitOf(action, "hour") : siteDaily;
    for (let index = 0; index < siteDaily; index += 1) {
      assertAccountRateLimit(action, `site-user-${index}`, { now: NOW + Math.floor(index / siteHourly) * HOUR });
    }
    const nextHour = NOW + Math.ceil(siteDaily / siteHourly) * HOUR;

    const error = captureError(() => assertAccountRateLimit(action, "one-more-user", { now: nextHour }));
    expect(error).toMatchObject({ code: "SITE_RATE_LIMITED", status: 429 });
    // 하루 창은 첫 요청부터 24시간이라 남은 시간으로 안내한다.
    const seconds = (NOW + DAY - nextHour) / 1_000;
    expect(error.message).toBe(`${ACCOUNT_RATE_LIMITS[action].siteWide?.message} ${formatRetryWait(seconds)} 뒤에 다시 시도해 주세요.`);
    expect(error.details).toEqual([{ field: "retry_after_seconds", reason: String(seconds) }]);
  });

  it.each([
    "chat",
    "contract_review",
    "community_post",
    "community_report",
  ] as const)("%s: 사이트 전체 시간당 상한으로 하루치를 한꺼번에 쓰지 못하게 한다", (action) => {
    const siteHourly = siteLimitOf(action, "hour");
    expect(siteHourly).toBeLessThan(siteLimitOf(action, "day"));
    for (let index = 0; index < siteHourly; index += 1) {
      assertAccountRateLimit(action, `burst-user-${index}`, { now: NOW });
    }

    const error = captureError(() => assertAccountRateLimit(action, "one-more-user", { now: NOW + 1 }));
    expect(error).toMatchObject({ code: "SITE_RATE_LIMITED", status: 429 });
    expect(error.details).toEqual([{ field: "retry_after_seconds", reason: String(Math.ceil((HOUR - 1) / 1_000)) }]);

    // 사이트 전체 상한은 다른 동작에 번지지 않고, 시간 창이 끝나면 다시 받는다.
    expect(() => assertAccountRateLimit("conversation_import", "one-more-user", { now: NOW + 1 })).not.toThrow();
    expect(() => assertAccountRateLimit(action, "one-more-user", { now: NOW + HOUR })).not.toThrow();
  });

  it("계정 한도와 사이트 전체 상한에 함께 걸리면 계정 한도로 안내한다", () => {
    const hourly = limitOf("worksite_tip", "hour");
    for (let index = 0; index < hourly; index += 1) {
      assertAccountRateLimit("worksite_tip", USER_A, { now: NOW });
    }
    for (let index = hourly; index < siteLimitOf("worksite_tip", "day"); index += 1) {
      assertAccountRateLimit("worksite_tip", `site-user-${index}`, { now: NOW });
    }

    const error = captureError(() => assertAccountRateLimit("worksite_tip", USER_A, { now: NOW + 1 }));
    expect(error.code).toBe("ACCOUNT_RATE_LIMITED");
    expect(error.message.startsWith(ACCOUNT_RATE_LIMITS.worksite_tip.accountMessage)).toBe(true);
  });
});

describe("상담 재전송", () => {
  it("같은 request_id 로 다시 보낸 요청은 새 상담으로 세지 않는다", () => {
    const hourly = limitOf("chat", "hour");
    assertAccountRateLimit("chat", USER_A, { requestId: "request_retry_000000001", now: NOW });
    for (let retry = 0; retry < FREE_RETRIES_PER_REQUEST; retry += 1) {
      assertAccountRateLimit("chat", USER_A, { requestId: "request_retry_000000001", now: NOW });
    }
    for (let index = 1; index < hourly; index += 1) {
      assertAccountRateLimit("chat", USER_A, { requestId: `request_new_${String(index).padStart(10, "0")}`, now: NOW });
    }

    expect(() => assertAccountRateLimit("chat", USER_A, { requestId: "request_over_0000000001", now: NOW }))
      .toThrow(expect.objectContaining({ code: "ACCOUNT_RATE_LIMITED" }));
  });

  it("한도에 닿아도 이미 센 요청의 재전송은 통과시키되 세지 않는 재전송 횟수는 묶는다", () => {
    const hourly = limitOf("chat", "hour");
    assertAccountRateLimit("chat", USER_A, { requestId: "request_retry_000000001", now: NOW });
    for (let index = 1; index < hourly; index += 1) {
      assertAccountRateLimit("chat", USER_A, { requestId: `request_new_${String(index).padStart(10, "0")}`, now: NOW });
    }
    expect(() => assertAccountRateLimit("chat", USER_A, { requestId: "request_over_0000000001", now: NOW }))
      .toThrow(ServiceError);

    for (let retry = 0; retry < FREE_RETRIES_PER_REQUEST; retry += 1) {
      expect(() => assertAccountRateLimit("chat", USER_A, { requestId: "request_retry_000000001", now: NOW }))
        .not.toThrow();
    }
    // 저장소 장애 중에는 재전송도 새 답변을 만들 수 있어, 공짜 재전송을 다 쓰면 새 요청처럼 센다.
    expect(() => assertAccountRateLimit("chat", USER_A, { requestId: "request_retry_000000001", now: NOW }))
      .toThrow(expect.objectContaining({ code: "ACCOUNT_RATE_LIMITED" }));
  });

  it("다른 계정이 같은 request_id 를 보내면 재전송으로 보지 않는다", () => {
    const hourly = limitOf("chat", "hour");
    assertAccountRateLimit("chat", USER_A, { requestId: "request_shared_00000001", now: NOW });
    for (let index = 0; index < hourly; index += 1) {
      assertAccountRateLimit("chat", USER_B, { requestId: `request_b_${String(index).padStart(12, "0")}`, now: NOW });
    }

    expect(() => assertAccountRateLimit("chat", USER_B, { requestId: "request_shared_00000001", now: NOW }))
      .toThrow(expect.objectContaining({ code: "ACCOUNT_RATE_LIMITED" }));
  });
});

describe("한도 저장소 관리", () => {
  it("테스트 실행 환경에서는 한도를 크게 늘려 기존 테스트의 반복 호출이 걸리지 않게 한다", () => {
    vi.stubEnv("NODE_ENV", "test");
    for (let index = 0; index <= limitOf("worksite_tip", "hour"); index += 1) {
      assertAccountRateLimit("worksite_tip", USER_A, { now: NOW });
    }
  });

  it("끝난 창의 버킷은 지워서 메모리가 계속 늘지 않게 한다", () => {
    // 사이트 전체 상한이 없는 동작이라 계정마다 시간·하루 버킷 두 개씩만 생긴다.
    for (let index = 0; index < 50; index += 1) {
      assertAccountRateLimit("conversation_import", `user-${index}`, { now: NOW });
    }
    expect(accountRateLimitBucketCountForTests()).toBe(100);

    assertAccountRateLimit("conversation_import", USER_A, { now: NOW + DAY });

    expect(accountRateLimitBucketCountForTests()).toBe(2);
  });

  it.each([
    [1, "1초"],
    [59, "59초"],
    [60, "1분"],
    [61, "2분"],
    [3_540, "59분"],
    [3_599, "1시간"],
    [3_661, "1시간 2분"],
    [86_400, "24시간"],
  ])("남은 %i초를 '%s'로 안내한다", (seconds, expected) => {
    expect(formatRetryWait(seconds)).toBe(expected);
  });
});
