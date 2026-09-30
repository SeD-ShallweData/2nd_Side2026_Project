import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), importGuest: vi.fn() }));

vi.mock("@/services/authService", () => ({ getOptionalSessionUser: mocks.getUser }));
vi.mock("@/services/conversationService", () => ({ importGuestConversation: mocks.importGuest }));

import { POST } from "@/app/api/conversations/import/route";
import { ACCOUNT_RATE_LIMITS, resetAccountRateLimitsForTests } from "@/server/accountRateLimit";

const USER = {
  user_id: "00000000-0000-4000-8000-000000000041",
  email: "importer@example.com",
  display_name: "가져오기 사용자",
  role: "user" as const,
};
const IMPORT_URL = "http://localhost/api/conversations/import";
const HOURLY = ACCOUNT_RATE_LIMITS.conversation_import.perAccount.find((window) => window.name === "hour")!.limit;

function importRequest(body = "{\"import_id\":\"guest_import_000000000001\",\"turns\":[]}", contentType = "application/json") {
  return new Request(IMPORT_URL, {
    method: "POST",
    headers: { "content-type": contentType, origin: "http://localhost", cookie: "donworry_session=session-token" },
    body,
  });
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  mocks.getUser.mockResolvedValue(USER);
  mocks.importGuest.mockResolvedValue({ imported: true, conversation_id: "00000000-0000-4000-8000-000000000051", reused: false });
});

afterEach(() => {
  resetAccountRateLimitsForTests();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("익명 상담 가져오기 계정 한도", () => {
  it("계정 한도를 넘으면 최대 1MB 본문을 읽기 전에 429 로 막는다", async () => {
    for (let index = 0; index < HOURLY; index += 1) {
      expect((await POST(importRequest())).status).toBe(200);
    }

    // 본문을 읽었다면 415 가 났을 요청이다. 한도가 먼저 걸리는지 본다.
    const limited = await POST(importRequest("not json", "text/plain"));

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    expect(await limited.json()).toMatchObject({
      error: { code: "ACCOUNT_RATE_LIMITED", message: expect.stringContaining("대화 가져오기 요청이 너무 많습니다.") },
    });
    expect(mocks.importGuest).toHaveBeenCalledTimes(HOURLY);
  });

  it("로그인하지 않은 요청은 한도를 쓰지 않고 401 로 거절한다", async () => {
    mocks.getUser.mockResolvedValue(null);
    for (let index = 0; index <= HOURLY; index += 1) {
      expect((await POST(importRequest())).status).toBe(401);
    }

    mocks.getUser.mockResolvedValue(USER);
    expect((await POST(importRequest())).status).toBe(200);
  });
});
