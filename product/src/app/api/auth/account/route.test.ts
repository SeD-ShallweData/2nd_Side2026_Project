import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const db = vi.hoisted(() => ({
  queryWrite: vi.fn(),
}));

vi.mock("@/server/postgresWrite", () => ({
  isDatabaseError: (error: unknown) => {
    if (!(error instanceof Error)) return false;
    const code = (error as Error & { code?: unknown }).code;
    return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
  },
  isWriteDatabaseConfigured: () => true,
  queryWrite: db.queryWrite,
  withWriteTransaction: vi.fn(),
}));

import { DELETE } from "@/app/api/auth/account/route";
import { resetApiErrorLogForTests } from "@/utils/errors";

const SESSION_TOKEN = "A".repeat(43);

function deleteRequest(): Request {
  return new Request("http://localhost/api/auth/account", {
    method: "DELETE",
    headers: {
      cookie: `donworry_session=${SESSION_TOKEN}`,
      origin: "http://localhost",
      "content-type": "application/json",
    },
    body: JSON.stringify({ confirmation: "계정 삭제" }),
  });
}

beforeEach(() => {
  vi.stubEnv("AUTH_DATA_MODE", "real");
  resetApiErrorLogForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  db.queryWrite.mockReset();
});

describe("DELETE /api/auth/account", () => {
  it("현장 제보가 있어 외래키에 걸리면 500 이 아니라 409 로 안내하고 세션을 유지한다", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.queryWrite.mockRejectedValueOnce(Object.assign(
      new Error('update or delete on table "users" violates foreign key constraint "worksite_tips_reporter_id_users_id_fk" on table "worksite_tips"'),
      { code: "23503", constraint: "worksite_tips_reporter_id_users_id_fk", table: "worksite_tips" },
    ));

    const response = await DELETE(deleteRequest());

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // 삭제되지 않았으므로 로그인 쿠키를 지우지 않는다.
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "ACCOUNT_DELETE_BLOCKED_BY_WORKSITE_TIP",
        message: "접수한 현장 제보가 있는 계정은 바로 삭제할 수 없습니다. 운영팀에 문의해 주세요.",
        retryable: false,
      },
    });
    // 제약 이름·테이블 이름 같은 DB 구조는 응답에 싣지 않는다.
    expect(JSON.stringify(body)).not.toContain("worksite_tips");
    // 사용자 안내로 끝나는 4xx 라 서버 오류 기록을 남기지 않는다.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("삭제에 성공하면 로그인 쿠키를 지운다", async () => {
    db.queryWrite.mockResolvedValueOnce([{ id: "user-1" }]);

    const response = await DELETE(deleteRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("donworry_session=;");
  });
});
