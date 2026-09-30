import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * 쓰기 경로 한도 누락 검사.
 *
 * src/app/api 아래 route.ts 의 쓰기 핸들러(POST·PUT·PATCH·DELETE)는 다음 셋 가운데 하나여야 한다.
 *   1. 운영 관리자·근로감독관 전용 — 핸들러가 아래 PRIVILEGED_GUARDS 를 부른다.
 *   2. 호출 한도를 건다 — 핸들러가 아래 LIMITERS 를 부른다.
 *   3. 아래 ALLOWLIST 에 사유와 함께 올라 있다.
 * 한도 없이 새 쓰기 경로를 추가하면 이 테스트가 실패한다. 한도를 붙이거나, 붙이지 않는 이유를
 * ALLOWLIST 에 적는다. 이유가 사라진 항목(한도가 생겼거나 경로가 없어진 경우)도 실패로 알린다.
 */

const API_ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.dirname(API_ROOT);
const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

const PRIVILEGED_GUARDS = [
  "requireOpsMutation(",
  "requireOperatorRequest(",
  "requireInspectorRequest(",
  "requireWorksiteTipReviewerRequest(",
];

const LIMITERS = ["assertAccountRateLimit(", "assertPublicRateLimit(", "assertSignupAllowed("];

const ALLOWLIST: Record<string, string> = {
  "POST /api/auth/login":
    "같은 이메일 5회 실패 시 15분 잠금(loginAttemptTracker)과 비밀번호 해시 동시 실행 상한(passwordHash)이 authService.loginUser 안에 있다.",
  "POST /api/auth/logout": "자기 세션만 끊는다. 새로 쌓이는 데이터가 없다.",
  "DELETE /api/auth/account": "본인 계정을 확인 문구와 함께 한 번 지우면 끝난다.",
  "POST /api/chat/feedback":
    "운영에서는 저장이 꺼져 있다(SAVE_COMPARISON_FEEDBACK, comparisonFeedbackStore). 저장을 켜기 전에 한도를 붙인다.",
  "PATCH /api/community/posts/[postId]": "본인 글만 고친다. 글 수는 늘지 않고, 글 총량은 작성 한도가 묶는다.",
  "DELETE /api/community/posts/[postId]": "본인 글을 삭제 상태로 바꿀 뿐이다.",
  "PATCH /api/community/moderation/reports/[reportId]":
    "운영 관리자 전용이다(communityService.reviewCommunityReport 의 requireUserRole admin). 검토 기록이 DB 에 남는다.",
  "POST /api/conversations": "항상 405 로 끝난다. 대화방은 상담 답변을 저장할 때만 생긴다.",
  "PATCH /api/conversations/[conversationId]": "본인 대화방의 제목·사업장만 바꾼다. 행이 늘지 않는다.",
  "DELETE /api/conversations/[conversationId]": "본인 대화방만 지운다.",
  "PUT /api/users/me/favorites/[companyId]":
    "본인 즐겨찾기다. 같은 사업장은 한 번만 저장되고(ON CONFLICT DO NOTHING) 실제 있는 사업장만 받는다.",
  "DELETE /api/users/me/favorites/[companyId]": "본인 즐겨찾기를 지울 뿐이다.",
};

interface MutatingHandler {
  id: string;
  source: string;
}

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(fullPath);
    return entry.name === "route.ts" ? [fullPath] : [];
  });
}

function routePath(file: string): string {
  return `/${path.relative(APP_ROOT, path.dirname(file)).split(path.sep).join("/")}`;
}

/* 핸들러 본문은 선언부터 다음 핸들러 선언 앞까지로 본다. */
function mutatingHandlers(): MutatingHandler[] {
  return routeFiles(API_ROOT).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    const declarations = [...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)\s*\(/g)];
    return declarations.flatMap((declaration, index) => {
      const method = declaration[1];
      if (!(MUTATING_METHODS as readonly string[]).includes(method)) return [];
      const end = declarations[index + 1]?.index ?? source.length;
      return [{ id: `${method} ${routePath(file)}`, source: source.slice(declaration.index, end) }];
    });
  });
}

function callsAny(source: string, calls: readonly string[]): boolean {
  return calls.some((call) => source.includes(call));
}

describe("쓰기 API 한도 누락 검사", () => {
  const handlers = mutatingHandlers();

  it("검사할 쓰기 핸들러를 찾는다", () => {
    // 경로 계산이 틀어져 아무것도 찾지 못한 채 통과하는 일을 막는다.
    expect(handlers.length).toBeGreaterThanOrEqual(25);
    expect(handlers.map((handler) => handler.id)).toEqual(expect.arrayContaining([
      "POST /api/chat",
      "POST /api/auth/signup",
      "POST /api/community/posts/[postId]/reports",
      "POST /api/admin/prompts/drafts",
    ]));
  });

  it("쓰기 핸들러는 export async function 으로만 선언한다", () => {
    const unsupported = routeFiles(API_ROOT).filter((file) => {
      const source = readFileSync(file, "utf8");
      return /export\s+(?:const|let|var)\s+(?:POST|PUT|PATCH|DELETE)\b/.test(source)
        || /export\s*\{[^}]*\b(?:POST|PUT|PATCH|DELETE)\b[^}]*\}/.test(source);
    });
    // 다른 형식은 이 검사가 본문을 찾지 못한다. 함수 선언으로 바꾼다.
    expect(unsupported.map(routePath)).toEqual([]);
  });

  it("모든 쓰기 핸들러는 관리자·감독관 전용이거나, 한도를 걸거나, 허용 목록에 사유가 있다", () => {
    const uncovered = handlers
      .filter((handler) => !callsAny(handler.source, PRIVILEGED_GUARDS))
      .filter((handler) => !callsAny(handler.source, LIMITERS))
      .filter((handler) => !(handler.id in ALLOWLIST))
      .map((handler) => handler.id);

    expect(uncovered).toEqual([]);
  });

  it("허용 목록에는 지금도 한도 없이 남아 있는 핸들러만 사유와 함께 둔다", () => {
    const unguarded = new Set(handlers
      .filter((handler) => !callsAny(handler.source, PRIVILEGED_GUARDS) && !callsAny(handler.source, LIMITERS))
      .map((handler) => handler.id));
    const stale = Object.keys(ALLOWLIST).filter((id) => !unguarded.has(id));

    expect(stale).toEqual([]);
    for (const reason of Object.values(ALLOWLIST)) expect(reason.trim().length).toBeGreaterThan(10);
  });

  it("로그인 사용자 쓰기와 AI 호출에는 계정 한도가 걸려 있다", () => {
    const accountLimited = handlers
      .filter((handler) => handler.source.includes("assertAccountRateLimit("))
      .map((handler) => handler.id)
      .sort();

    expect(accountLimited).toEqual([
      "POST /api/chat",
      "POST /api/community/posts",
      "POST /api/community/posts/[postId]/reports",
      "POST /api/contracts/review",
      "POST /api/conversations/import",
      "POST /api/worksite-tips",
    ]);
  });
});
