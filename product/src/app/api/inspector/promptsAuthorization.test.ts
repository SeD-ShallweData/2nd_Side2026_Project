import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  usersByToken: new Map<string, { user_id: string; email: string; display_name: string; role: "user" | "admin" | "inspector" }>(),
  getOptionalSessionUser: vi.fn(async (token: string | null) => (
    token ? authState.usersByToken.get(token) ?? null : null
  )),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/services/authService", () => ({
  getOptionalSessionUser: authState.getOptionalSessionUser,
}));
vi.mock("@/server/promptLoader", () => ({
  REQUIRED_PROMPTS: ["chat/system", "inspector/system", "rewrite/system"] as const,
  loadPrompt: (name: string) => `# ${name}\n지침 본문`,
}));

import { GET as getPrompts } from "@/app/api/inspector/prompts/route";

function request(token: string | null): Request {
  const headers = new Headers();
  if (token) headers.set("cookie", `donworry_session=${token}`);
  return new Request("http://localhost/api/inspector/prompts", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.usersByToken.clear();
  authState.usersByToken.set("user-token", {
    user_id: "1", email: "user@example.com", display_name: "일반 사용자", role: "user",
  });
  authState.usersByToken.set("inspector-token", {
    user_id: "3", email: "inspector@example.com", display_name: "근로감독관", role: "inspector",
  });
  authState.usersByToken.set("admin-token", {
    user_id: "2", email: "admin@example.com", display_name: "관리자", role: "admin",
  });
});

describe("GET /api/inspector/prompts", () => {
  it.each([
    ["비로그인", null],
    ["일반 사용자", "user-token"],
    ["근로감독관", "inspector-token"],
  ])("%s 요청을 403으로 막는다", async (_label, token) => {
    // 프롬프트는 답변의 태도와 금지 표현을 정한다. 플랫폼 운영에 속한다.
    const response = await getPrompts(request(token));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("운영 관리자에게 현재 적용 중인 프롬프트를 돌려준다", async () => {
    const response = await getPrompts(request("admin-token"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(3);
    expect(body.items.map((item: { name: string }) => item.name)).toEqual([
      "chat/system", "inspector/system", "rewrite/system",
    ]);
  });

  it("아직 쓰기를 열지 않았음을 응답에 밝힌다", async () => {
    // 자산 무결성 해시 때문에 파일 수정 경로는 닫혀 있다(#81).
    const body = await (await getPrompts(request("admin-token"))).json();

    expect(body.editable).toBe(false);
  });
});
