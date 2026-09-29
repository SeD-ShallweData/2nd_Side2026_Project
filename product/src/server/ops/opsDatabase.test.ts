import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryWriteMock } = vi.hoisted(() => ({ queryWriteMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/server/postgresWrite", () => ({
  queryWrite: queryWriteMock,
  isWriteDatabaseConfigured: () => Boolean(process.env.OPS_DATABASE_URL),
}));

import { activateBatch, activatePromptVersion } from "@/server/ops/opsDatabase";
import { getPromptOverride, refreshPromptOverrides, setPromptOverrides } from "@/server/promptLoader";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  queryWriteMock.mockReset();
  vi.stubEnv("AUTH_DATA_MODE", "real");
  vi.stubEnv("OPS_DATABASE_URL", "postgresql://wg_ops:pw@127.0.0.1:5432/wg");
});

afterEach(() => {
  vi.unstubAllEnvs();
  setPromptOverrides(new Map());
});

describe("ops 함수 오류를 사용자 안내로 바꾼다", () => {
  it.each([
    ["42501", "operator must be an admin user", 403, "FORBIDDEN"],
    ["P0002", "batch 99 not found", 404, "NOT_FOUND"],
    ["23514", "batch 8 is incomplete and cannot be served", 409, "BATCH_INCOMPLETE"],
    ["23514", "reason must be 2-300 characters", 400, "INVALID_REASON"],
  ])("%s %s → %i", async (code, message, status, serviceCode) => {
    queryWriteMock.mockRejectedValueOnce(pgError(code, message));
    await expect(activateBatch(8, "u", "사유")).rejects.toMatchObject({ status, code: serviceCode });
  });

  it("검증 실패·해시 불일치 버전 적용은 409", async () => {
    queryWriteMock.mockRejectedValueOnce(pgError("23514", "prompt version 3 failed validation"));
    await expect(activatePromptVersion("3", "u", "적용")).rejects.toMatchObject({ status: 409, code: "PROMPT_INVALID" });
    queryWriteMock.mockRejectedValueOnce(pgError("XX001", "prompt version 3 hash mismatch"));
    await expect(activatePromptVersion("3", "u", "적용")).rejects.toMatchObject({ status: 409, code: "PROMPT_HASH_MISMATCH" });
  });

  it("Mock 인증에서는 DB 를 부르지 않는다", async () => {
    vi.stubEnv("AUTH_DATA_MODE", "mock");
    await expect(activateBatch(6, "u", "사유")).rejects.toMatchObject({ status: 503 });
    expect(queryWriteMock).not.toHaveBeenCalled();
  });
});

describe("적용된 프롬프트 반영", () => {
  it("적용 직후 DB 값을 로더에 채우고, 이후 DB 가 실패하면 마지막 값을 유지한다", async () => {
    queryWriteMock
      .mockResolvedValueOnce([{ name: "rewrite/system", version: 4, body_sha256: "abc" }])
      .mockResolvedValueOnce([{ name: "rewrite/system", version: 4, body: "DB 지침", body_sha256: "abc", activated_at: null }]);
    await activatePromptVersion("11", "u", "적용");
    expect(getPromptOverride("rewrite/system")?.body).toBe("DB 지침");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    queryWriteMock.mockRejectedValueOnce(pgError("08006", "connection failure"));
    await refreshPromptOverrides(true);
    expect(getPromptOverride("rewrite/system")?.body).toBe("DB 지침");
    warn.mockRestore();
  });

  it("알 수 없는 이름의 행은 무시한다", async () => {
    queryWriteMock.mockResolvedValueOnce([{ name: "evil/system", version: 1, body: "x", body_sha256: "y", activated_at: null }]);
    await refreshPromptOverrides(true);
    expect(getPromptOverride("evil/system")).toBeUndefined();
  });
});
