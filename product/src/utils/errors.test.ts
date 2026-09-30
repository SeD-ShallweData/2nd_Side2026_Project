import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { errorPayload, markErrorLogged, resetApiErrorLogForTests, ServiceError } from "@/utils/errors";

let errorSpy: ReturnType<typeof vi.spyOn>;

function loggedEvents(): Record<string, unknown>[] {
  return errorSpy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

beforeEach(() => {
  resetApiErrorLogForTests();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetApiErrorLogForTests();
});

describe("오류 봉투는 내부 사정을 화면에 보내지 않는다", () => {
  it("예상하지 못한 예외는 고정 문구만 응답에 싣는다", () => {
    const payload = errorPayload(new Error('relation "users" does not exist at /srv/moneyworry/web/.next/server/chunk.js'));

    expect(payload.status).toBe(500);
    expect(payload.body.error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "요청을 처리하는 중 오류가 발생했습니다.",
      retryable: true,
    });
    const body = JSON.stringify(payload.body);
    expect(body).not.toContain("users");
    expect(body).not.toContain("/srv");
  });
});

describe("5xx 서버 기록", () => {
  it("request_id 와 코드·오류 이름·정리한 문구를 한 줄로 남긴다", () => {
    const payload = errorPayload(new TypeError("could not connect postgresql://bot:secret@db.test/wageguard"));

    const events = loggedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: "api_error",
      request_id: payload.body.error.request_id,
      status: 500,
      code: "INTERNAL_ERROR",
      error_name: "TypeError",
      pg_code: null,
      message: "could not connect [connection-string]",
    });
    expect(JSON.stringify(events[0])).not.toContain("secret");
  });

  it("pg 오류는 SQLSTATE 만 남기고 detail 의 사용자 값은 남기지 않는다", () => {
    const pgError = Object.assign(new Error("permission denied for table users"), {
      code: "42501",
      detail: "Key (email)=(worker@example.com) is still referenced.",
    });

    errorPayload(pgError);

    const [event] = loggedEvents();
    expect(event).toMatchObject({ pg_code: "42501", message: "permission denied for table users" });
    expect(JSON.stringify(event)).not.toContain("worker@example.com");
  });

  it("5xx ServiceError 도 코드와 함께 남긴다", () => {
    const payload = errorPayload(new ServiceError("DATABASE_UNAVAILABLE", "사용자 인증 데이터베이스에 접근하지 못했습니다.", 503, true));

    expect(loggedEvents()).toEqual([expect.objectContaining({
      request_id: payload.body.error.request_id,
      status: 503,
      code: "DATABASE_UNAVAILABLE",
      error_name: "ServiceError",
    })]);
  });

  it("4xx 는 사용자 요청 문제라 남기지 않는다", () => {
    errorPayload(new ServiceError("VALIDATION_ERROR", "질문 내용을 확인해 주세요.", 400, false));
    errorPayload(new ServiceError("FORBIDDEN", "권한이 없습니다.", 403, false));

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("발생한 자리에서 이미 남긴 오류는 다시 남기지 않는다(postgres.ts 와 두 줄이 되지 않게)", () => {
    const payload = errorPayload(markErrorLogged(
      new ServiceError("DATABASE_UNAVAILABLE", "사업장 데이터베이스를 읽지 못했습니다.", 503, true),
    ));

    expect(payload.status).toBe(503);
    expect(payload.body.error.request_id).toMatch(/^req_/);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("Error 가 아닌 값을 던져도 기록하고 응답은 고정 문구다", () => {
    const payload = errorPayload("boom /srv/secret");

    expect(payload.body.error.message).toBe("요청을 처리하는 중 오류가 발생했습니다.");
    expect(loggedEvents()[0]).toMatchObject({ error_name: "string", message: "boom /srv/secret" });
  });

  it("기록이 실패해도 오류 응답은 그대로 만든다", () => {
    errorSpy.mockImplementation(() => {
      throw new Error("journald unavailable");
    });

    const payload = errorPayload(new Error("boom"));

    expect(payload.status).toBe(500);
    expect(payload.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("1분에 30줄까지만 남기고, 다음 창에서 건너뛴 개수를 한 줄로 알린다", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    for (let index = 0; index < 35; index += 1) errorPayload(new Error(`boom ${index}`));

    expect(errorSpy).toHaveBeenCalledTimes(30);

    now.mockReturnValue(1_000_000 + 60_000);
    errorPayload(new Error("after window"));

    const events = loggedEvents();
    expect(events).toHaveLength(32);
    expect(events[30]).toEqual({ event: "api_error_log_suppressed", suppressed: 5, window_ms: 60_000 });
    expect(events[31]).toMatchObject({ event: "api_error", message: "after window" });
  });
});
