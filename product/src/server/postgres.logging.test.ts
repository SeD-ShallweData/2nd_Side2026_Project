import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/server/databaseConfig", () => ({
  getDatabaseConnectionString: () => "postgresql://bot:secret@db.test/wageguard",
}));

vi.mock("pg", () => ({
  Pool: class {
    query = database.query;
  },
}));

import { describeQueryFailure, queryReadOnly } from "@/server/postgres";
import { errorPayload, resetApiErrorLogForTests, takeApiErrorLogSlot } from "@/utils/errors";

beforeEach(() => {
  resetApiErrorLogForTests();
});

afterEach(() => {
  database.query.mockReset();
  vi.restoreAllMocks();
  resetApiErrorLogForTests();
});

describe("읽기 전용 조회 실패 기록", () => {
  it("어느 관계가 실패했는지와 pg 오류 코드를 남기고, 화면 문구는 그대로 둔다", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    database.query.mockRejectedValue(Object.assign(new Error("permission denied for view v_current_scored"), { code: "42501" }));

    await expect(queryReadOnly("SELECT 1 FROM public.v_current_scored", [], { relation: "public.v_current_scored" }))
      .rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE", message: "사업장 데이터베이스를 읽지 못했습니다." });

    const logged = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
    expect(logged).toEqual({
      event: "readonly_query_failed",
      relation: "public.v_current_scored",
      pg_code: "42501",
      message: "permission denied for view v_current_scored",
    });
  });

  it("실패를 5xx 로 돌려줄 때는 원인 문구를 되풀이하지 않고 request_id 로 찾을 줄만 더 남긴다", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    database.query.mockRejectedValue(Object.assign(new Error("permission denied for view v_current_scored"), { code: "42501" }));

    const failure = await queryReadOnly("SELECT 1 FROM public.v_current_scored", [], { relation: "public.v_current_scored" })
      .catch((error: unknown) => error);
    const payload = errorPayload(failure);

    expect(payload.status).toBe(503);
    const events = errorSpy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(events.map((event) => event.event)).toEqual(["readonly_query_failed", "api_error"]);
    expect(events[1]).toEqual({
      event: "api_error",
      request_id: payload.body.error.request_id,
      status: 503,
      code: "DATABASE_UNAVAILABLE",
      cause_logged: true,
    });
  });

  it("장애로 기록 상한에 닿으면 원인 줄도 더 남기지 않는다", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    database.query.mockRejectedValue(new Error("connection refused"));
    for (let index = 0; index < 30; index += 1) takeApiErrorLogSlot();

    await expect(queryReadOnly("SELECT 1", [], { relation: "public.v_current_scored" }))
      .rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("접속 문자열과 비밀번호 조각은 로그에 남기지 않는다", () => {
    const described = describeQueryFailure(new Error("could not connect postgresql://bot:secret@db.test/wageguard password=hunter2"));
    expect(described.message).not.toContain("secret");
    expect(described.message).not.toContain("hunter2");
    expect(described.message).toContain("[connection-string]");
    expect(described.code).toBeNull();
  });
});
