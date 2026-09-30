import { describe, expect, it } from "vitest";

import { displayableErrorDetails, retryAfterHeaders, ServiceError } from "@/utils/errors";

function limited(seconds: string): ServiceError {
  return new ServiceError("ACCOUNT_RATE_LIMITED", "한도", 429, true, [{ field: "retry_after_seconds", reason: seconds }]);
}

describe("한도 오류의 재시도 시간", () => {
  it("429 오류의 retry_after_seconds 를 Retry-After 헤더로 옮긴다", () => {
    expect(retryAfterHeaders(limited("90"))).toEqual({ "Retry-After": "90" });
  });

  it("429 가 아니거나 값이 올바르지 않으면 헤더를 붙이지 않는다", () => {
    expect(retryAfterHeaders(new ServiceError("VALIDATION_ERROR", "입력", 400, false, [
      { field: "retry_after_seconds", reason: "90" },
    ]))).toEqual({});
    expect(retryAfterHeaders(limited("0"))).toEqual({});
    expect(retryAfterHeaders(limited("soon"))).toEqual({});
    expect(retryAfterHeaders(new ServiceError("LOGIN_TEMPORARILY_LOCKED", "잠금", 429, true))).toEqual({});
    expect(retryAfterHeaders(new Error("boom"))).toEqual({});
  });

  it("화면에 보일 오류 상세에서는 재시도 초만 빼고 나머지는 그대로 둔다", () => {
    expect(displayableErrorDetails(limited("90").details)).toBeUndefined();
    expect(displayableErrorDetails([
      { field: "retry_after_seconds", reason: "90" },
      { field: "title", reason: "제목을 확인해 주세요." },
    ])).toEqual([{ field: "title", reason: "제목을 확인해 주세요." }]);
    expect(displayableErrorDetails(undefined)).toBeUndefined();
  });
});
