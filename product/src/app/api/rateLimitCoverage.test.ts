import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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
 *
 * 호출은 TypeScript 구문 트리에서 핸들러 본문의 실제 함수 호출로 찾는다. 주석
 * (// TODO assertAccountRateLimit(...))이나 문자열에 적힌 이름은 호출로 세지 않는다.
 */

const API_ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.dirname(API_ROOT);
const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

const PRIVILEGED_GUARDS = [
  "requireOpsMutation",
  "requireOperatorRequest",
  "requireInspectorRequest",
  "requireWorksiteTipReviewerRequest",
];

const LIMITERS = ["assertAccountRateLimit", "assertPublicRateLimit", "assertSignupAllowed"];

/*
 * 요청 본문을 읽는 호출. 한도는 이보다 먼저 걸어야 큰 본문(현장 제보 사진 최대 12MB, 계약서 파일)을
 * 읽거나 저장하기 전에 막는다. request.json 처럼 적은 것은 request 객체의 메서드 호출이다.
 */
const BODY_READS = [
  "readJsonBody",
  "parseRequest",
  "parseChatHttpRequest",
  "createWorksiteTip",
  "request.json",
  "request.formData",
  "request.text",
  "request.arrayBuffer",
];

/* 본문을 읽은 뒤에 한도를 확인하는 핸들러와 그 이유. */
const LIMIT_AFTER_BODY: Record<string, string> = {
  "POST /api/chat":
    "로그인 사용자는 같은 request_id 로 다시 보낸 요청을 세지 않으므로 본문의 request_id 가 필요하다. 익명 한도도 같은 자리에 있다. 앱 차원의 본문 크기 상한은 후속 작업이다.",
  "POST /api/auth/signup": "숨은 칸(허니팟) 값이 본문에 있다. readJsonBody 가 본문을 64KB 에서 자른다.",
};

const ALLOWLIST: Record<string, string> = {
  "POST /api/auth/login":
    "같은 이메일 5회 실패 시 15분 잠금(loginAttemptTracker)과 비밀번호 해시 동시 실행 상한(passwordHash)이 authService.loginUser 안에 있다.",
  "POST /api/auth/logout": "자기 세션만 끊는다. 새로 쌓이는 데이터가 없다.",
  "DELETE /api/auth/account": "본인 계정을 확인 문구와 함께 한 번 지우면 끝난다.",
  "POST /api/chat/feedback":
    "운영에서는 저장이 꺼져 있다(SAVE_COMPARISON_FEEDBACK, comparisonFeedbackStore). 저장을 켜기 전에 한도를 붙인다.",
  "PATCH /api/community/moderation/reports/[reportId]":
    "운영 관리자 전용이다(communityService.reviewCommunityReport 의 requireUserRole admin). 검토 기록이 DB 에 남는다.",
  "POST /api/conversations": "항상 405 로 끝난다. 대화방은 상담 답변을 저장할 때만 생긴다.",
  "PATCH /api/conversations/[conversationId]": "본인 대화방의 제목·사업장만 바꾼다. 행이 늘지 않는다.",
  "DELETE /api/conversations/[conversationId]": "본인 대화방만 지운다.",
  "DELETE /api/users/me/favorites/[companyId]": "본인 즐겨찾기를 지울 뿐이다.",
};

interface CallSite {
  /** 부른 함수 이름. request.formData() 처럼 객체의 메서드로 부르면 "request.formData" 다. */
  name: string;
  start: number;
  end: number;
}

interface MutatingHandler {
  id: string;
  calls: CallSite[];
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

function callName(callee: ts.Expression): string | null {
  if (ts.isIdentifier(callee)) return callee.text;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  return ts.isIdentifier(callee.expression) ? `${callee.expression.text}.${callee.name.text}` : callee.name.text;
}

/* 핸들러 본문 안의 모든 함수 호출. 콜백 안에서 부른 것도 포함한다. */
function callSites(body: ts.Node, sourceFile: ts.SourceFile): CallSite[] {
  const sites: CallSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      if (name) sites.push({ name, start: node.getStart(sourceFile), end: node.getEnd() });
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return sites;
}

function mutatingHandlers(): MutatingHandler[] {
  return routeFiles(API_ROOT).flatMap((file) => {
    const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return sourceFile.statements.flatMap((statement) => {
      if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) return [];
      if ((ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export) === 0) return [];
      const method = statement.name.text;
      if (!(MUTATING_METHODS as readonly string[]).includes(method)) return [];
      return [{ id: `${method} ${routePath(file)}`, calls: callSites(statement.body, sourceFile) }];
    });
  });
}

/* 이름 끝부분으로 맞춘다. 가져온 모듈 이름을 붙여 limits.assertAccountRateLimit() 로 불러도 찾는다. */
function callsTo(handler: MutatingHandler, names: readonly string[]): CallSite[] {
  return handler.calls.filter((call) => names.includes(call.name.split(".").at(-1) ?? call.name));
}

function callsAny(handler: MutatingHandler, names: readonly string[]): boolean {
  return callsTo(handler, names).length > 0;
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
      .filter((handler) => !callsAny(handler, PRIVILEGED_GUARDS))
      .filter((handler) => !callsAny(handler, LIMITERS))
      .filter((handler) => !(handler.id in ALLOWLIST))
      .map((handler) => handler.id);

    expect(uncovered).toEqual([]);
  });

  it("허용 목록에는 지금도 한도 없이 남아 있는 핸들러만 사유와 함께 둔다", () => {
    const unguarded = new Set(handlers
      .filter((handler) => !callsAny(handler, PRIVILEGED_GUARDS) && !callsAny(handler, LIMITERS))
      .map((handler) => handler.id));
    const stale = Object.keys(ALLOWLIST).filter((id) => !unguarded.has(id));

    expect(stale).toEqual([]);
    for (const reason of Object.values(ALLOWLIST)) expect(reason.trim().length).toBeGreaterThan(10);
  });

  it("로그인 사용자 쓰기와 AI 호출에는 계정 한도가 걸려 있다", () => {
    const accountLimited = handlers
      .filter((handler) => callsAny(handler, ["assertAccountRateLimit"]))
      .map((handler) => handler.id)
      .sort();

    expect(accountLimited).toEqual([
      "DELETE /api/community/posts/[postId]",
      "PATCH /api/community/posts/[postId]",
      "POST /api/chat",
      "POST /api/community/posts",
      "POST /api/community/posts/[postId]/reports",
      "POST /api/contracts/review",
      "POST /api/conversations/import",
      "POST /api/worksite-tips",
      "PUT /api/users/me/favorites/[companyId]",
    ]);
  });

  it("한도는 요청 본문을 읽기 전에 건다. 예외는 사유와 함께 둔다", () => {
    const limitedAfterBody = handlers.flatMap((handler) => {
      const limiterEnds = callsTo(handler, LIMITERS).map((call) => call.end);
      const bodyReadStarts = handler.calls.filter((call) => BODY_READS.includes(call.name)).map((call) => call.start);
      if (limiterEnds.length === 0 || bodyReadStarts.length === 0) return [];
      return Math.min(...limiterEnds) > Math.min(...bodyReadStarts) ? [handler.id] : [];
    }).sort();

    // 새로 본문 뒤에서 한도를 거는 핸들러가 생겨도, 예외가 더는 필요 없어져도 실패한다.
    expect(limitedAfterBody).toEqual(Object.keys(LIMIT_AFTER_BODY).sort());
    for (const reason of Object.values(LIMIT_AFTER_BODY)) expect(reason.trim().length).toBeGreaterThan(10);
  });
});
