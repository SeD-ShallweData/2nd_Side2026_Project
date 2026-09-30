import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  usersByToken: new Map<string, { user_id: string; email: string; display_name: string; role: "user" | "admin" | "inspector" }>(),
  getOptionalSessionUser: vi.fn(async (token: string | null) => (
    token ? state.usersByToken.get(token) ?? null : null
  )),
  activateBatch: vi.fn(async (batchId: number) => ({ batch_id: batchId, as_of_date: "2026-05-01" })),
  deactivateBatches: vi.fn(async () => ({ batch_id: 7, as_of_date: "2026-06-01" })),
  savePromptDraft: vi.fn(async () => ({ id: "11", version: 4, body_sha256: "abc" })),
  activatePromptVersion: vi.fn(async () => ({ name: "rewrite/system", version: 4, body_sha256: "abc" })),
  resetPrompt: vi.fn(async () => undefined),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/services/authService", () => ({ getOptionalSessionUser: state.getOptionalSessionUser }));
vi.mock("@/server/ops/opsDatabase", () => ({
  activateBatch: state.activateBatch,
  deactivateBatches: state.deactivateBatches,
  savePromptDraft: state.savePromptDraft,
  activatePromptVersion: state.activatePromptVersion,
  resetPrompt: state.resetPrompt,
}));

import { POST as activateBatchRoute } from "@/app/api/admin/batches/[batchId]/activate/route";
import { POST as deactivateRoute } from "@/app/api/admin/batches/deactivate/route";
import { POST as draftRoute } from "@/app/api/admin/prompts/drafts/route";
import { POST as resetRoute } from "@/app/api/admin/prompts/reset/route";
import { POST as activatePromptRoute } from "@/app/api/admin/prompts/versions/[versionId]/activate/route";
import { REQUIRED_POLICY_PHRASES } from "@/server/promptPolicy";
import { silenceServerErrorLogs } from "@/testing/silenceServerErrorLogs";

function post(path: string, token: string | null, body: unknown, site = "same-origin"): Request {
  const headers = new Headers({ "content-type": "application/json", "sec-fetch-site": site });
  if (token) headers.set("cookie", `donworry_session=${token}`);
  return new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const batchCtx = (batchId: string) => ({ params: Promise.resolve({ batchId }) });
const versionCtx = (versionId: string) => ({ params: Promise.resolve({ versionId }) });

// 일부러 5xx 를 내는 경우가 있어 서버 오류 기록 줄(JSON)만 테스트 출력에서 뺀다.
silenceServerErrorLogs();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_DATA_MODE", "real");
  vi.stubEnv("OPS_DATABASE_URL", "postgresql://wg_ops:pw@127.0.0.1:5432/wg");
  state.usersByToken.clear();
  state.usersByToken.set("user-token", { user_id: "u1", email: "u@example.com", display_name: "사용자", role: "user" });
  state.usersByToken.set("inspector-token", { user_id: "u3", email: "i@example.com", display_name: "감독관", role: "inspector" });
  state.usersByToken.set("admin-token", { user_id: "u2", email: "a@example.com", display_name: "관리자", role: "admin" });
});

afterEach(() => vi.unstubAllEnvs());

describe("운영 콘솔 변경 API 권한", () => {
  it.each([
    ["비로그인", null],
    ["일반 사용자", "user-token"],
    ["근로감독관", "inspector-token"],
  ])("%s 요청은 403이고 DB를 부르지 않는다", async (_label, token) => {
    const responses = await Promise.all([
      activateBatchRoute(post("/api/admin/batches/6/activate", token, { reason: "시연용 고정" }), batchCtx("6")),
      deactivateRoute(post("/api/admin/batches/deactivate", token, { reason: "고정 해제" })),
      activatePromptRoute(post("/api/admin/prompts/versions/3/activate", token, { reason: "적용" }), versionCtx("3")),
      resetRoute(post("/api/admin/prompts/reset", token, { name: "chat/system", reason: "복귀" })),
      draftRoute(post("/api/admin/prompts/drafts", token, { name: "rewrite/system", body: "초안", reason: "수정" })),
    ]);
    for (const response of responses) expect(response.status).toBe(403);
    expect(state.activateBatch).not.toHaveBeenCalled();
    expect(state.deactivateBatches).not.toHaveBeenCalled();
    expect(state.activatePromptVersion).not.toHaveBeenCalled();
    expect(state.resetPrompt).not.toHaveBeenCalled();
    expect(state.savePromptDraft).not.toHaveBeenCalled();
  });

  it("다른 사이트에서 온 요청은 admin 세션이어도 막는다", async () => {
    const response = await activateBatchRoute(
      post("/api/admin/batches/6/activate", "admin-token", { reason: "시연용 고정" }, "cross-site"),
      batchCtx("6"),
    );
    expect(response.status).toBe(403);
    expect(state.activateBatch).not.toHaveBeenCalled();
  });

  it("Mock 인증에서는 admin 이어도 변경을 거부한다", async () => {
    vi.stubEnv("AUTH_DATA_MODE", "mock");
    const response = await activateBatchRoute(post("/api/admin/batches/6/activate", "admin-token", { reason: "시연용 고정" }), batchCtx("6"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "OPS_NOT_AVAILABLE_IN_MOCK" } });
  });

  it("운영 DB 연결이 없으면 503 이다", async () => {
    vi.stubEnv("OPS_DATABASE_URL", "");
    const response = await deactivateRoute(post("/api/admin/batches/deactivate", "admin-token", { reason: "고정 해제" }));
    expect(response.status).toBe(503);
  });

  it("사유가 없으면 400 이다", async () => {
    const response = await activateBatchRoute(post("/api/admin/batches/6/activate", "admin-token", { reason: " " }), batchCtx("6"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REASON" } });
  });

  it("배치 번호가 숫자가 아니면 400 이다", async () => {
    const response = await activateBatchRoute(post("/api/admin/batches/x/activate", "admin-token", { reason: "시연용 고정" }), batchCtx("6;drop"));
    expect(response.status).toBe(400);
  });

  it("admin 이 사유를 적으면 세션 사용자 id 로 고정한다", async () => {
    const response = await activateBatchRoute(post("/api/admin/batches/6/activate", "admin-token", { reason: " 시연용 고정 " }), batchCtx("6"));
    expect(response.status).toBe(200);
    expect(state.activateBatch).toHaveBeenCalledWith(6, "u2", "시연용 고정");
  });
});

describe("프롬프트 초안 저장", () => {
  it("알 수 없는 이름은 거부한다", async () => {
    const response = await draftRoute(post("/api/admin/prompts/drafts", "admin-token", { name: "../etc/passwd", body: "x", reason: "수정" }));
    expect(response.status).toBe(400);
    expect(state.savePromptDraft).not.toHaveBeenCalled();
  });

  it("정책 문장이 빠진 본문도 저장은 하되 검증 실패로 기록한다", async () => {
    const response = await draftRoute(post("/api/admin/prompts/drafts", "admin-token", { name: "rewrite/system", body: "짧은 지침", reason: "시험 저장" }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.validation.ok).toBe(false);
    expect(body.validation.missing_phrases.length).toBeGreaterThan(0);
    const [, , validation] = state.savePromptDraft.mock.calls[0] as unknown as [string, string, { ok: boolean }];
    expect(validation.ok).toBe(false);
  });

  it("정책 문장을 모두 담은 본문은 검증을 통과한다", async () => {
    const text = REQUIRED_POLICY_PHRASES["rewrite/system"].join("\n");
    const response = await draftRoute(post("/api/admin/prompts/drafts", "admin-token", { name: "rewrite/system", body: text, reason: "문구 다듬기" }));
    expect(response.status).toBe(201);
    expect((await response.json()).validation.ok).toBe(true);
  });
});
