import { NextRequest, NextResponse } from "next/server";

import {
  getDemoAuthConfiguration,
  isValidBasicAuthorization,
} from "@/server/demoBasicAuth";
import { errorPayload, ServiceError } from "@/utils/errors";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

const PUBLIC_HEALTH_PATHS = new Set([
  "/api/health/live",
  "/api/health/ready",
]);

/*
 * 화면이 브라우저 문맥 없이 직접 여는 /api/ 경로.
 *
 * WorksiteTipPage.tsx:182 가 첨부 사진을 두 가지로 연다
 *   <img src={content_url}>                         — 서브리소스
 *   <a href={content_url} target="_blank" rel="noreferrer">  — 새 탭 이동
 *
 * rel="noreferrer" 라 Referer 보루가 듣지 않는다. 경로 모양은
 * worksiteTipService.ts:555 가 만든다:
 *   /api/worksite-tips/{tipId}/attachments/{attachmentId}
 *
 * 이 경로는 requireInspectorRequest 로 이미 인가 게이트 뒤에 있으므로
 * 아래 문맥 검사에서 빼도 노출이 늘지 않는다.
 */
const ATTACHMENT_PATH = /^\/api\/worksite-tips\/[^/]+\/attachments\/[^/]+$/;

/*
 * 킬스위치. 재빌드 없이 끌 수 있어야 한다는 수용 기준을 만족한다 —
 * 빌드는 /etc/moneyworry/web.env 를 읽지 않고(deploy-from-git.sh:517-518),
 * env 는 moneyworry-web.service.in:15 의 EnvironmentFile= 로 ExecStart 에만 붙는다.
 * 따라서 값을 바꾸고 systemctl restart 하면 약 15초에 반영된다.
 *
 * 기본값은 켜짐이다. 끄려면 DEMO_API_GUARD=off 를 넣는다.
 */
function isApiGuardEnabled(): boolean {
  return process.env.DEMO_API_GUARD !== "off";
}

/*
 * 브라우저가 우리 페이지에서 보낸 요청인지 본다.
 *
 * Sec-Fetch-Site 는 forbidden header name 이라 페이지 스크립트가 덮어쓸 수 없고
 * 브라우저가 직접 붙인다. 그래서 화면에서 온 fetch 는 항상 same-origin 이고,
 * 크롤러와 헤더를 붙이지 않은 스크립트는 이 헤더가 아예 없다.
 *
 * 이것은 인가가 아니라 마찰이다. curl 에 헤더를 붙이면 통과한다.
 * 값은 우발적 수집과 크롤러를 걸러내는 데 있다. 실제 노출을 줄이는 일은
 * 읽기 경로를 서버 렌더로 옮기는 후속 변경이 한다.
 */
function hasBrowserContext(request: NextRequest): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) {
    return fetchSite === "same-origin" || fetchSite === "same-site";
  }

  /*
   * Sec-Fetch-Site 를 보내지 않는 브라우저를 위한 보루.
   * Origin 비교는 쓸 수 없다 — Next 는 Host 를 무시하고 자기 바인딩 주소로
   * request.url 을 만들어서 프록시 뒤에서 절대 일치하지 않는다
   * (server/auth/http.ts:36-44 의 2026-09-15 실측 기록).
   */
  const referer = request.headers.get("referer");
  if (!referer) {
    return false;
  }
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) {
    return false;
  }
  try {
    return new URL(referer).host === host;
  } catch {
    return false;
  }
}

/*
 * 차단 응답. utils/errors.ts 의 봉투를 그대로 쓴다.
 *
 * clientApi.ts:7-13 이 응답 본문을 무조건 response.json() 으로 읽으므로,
 * 평문을 돌려주면 화면에 'Unexpected token …' 이 그대로 뜬다.
 */
function blockedResponse(): NextResponse {
  const payload = errorPayload(
    new ServiceError(
      "FORBIDDEN",
      "이 주소는 돈워리 화면 안에서만 사용할 수 있습니다.",
      403,
      false,
    ),
  );
  return NextResponse.json(payload.body, {
    status: payload.status,
    headers: NO_STORE_HEADERS,
  });
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  /*
   * 1) 헬스 면제 — 반드시 맨 앞이다.
   *    health-watch.sh 가 1분 주기로, deploy-from-git.sh:554,574 가 배포마다
   *    이 두 경로를 찌른다. 여기서 막히면 web 이 재시작되고 배포가 die 한다.
   */
  if (PUBLIC_HEALTH_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  /*
   * 2) Basic 게이트 — 기존 동작을 그대로 둔다.
   *
   *    바뀐 것은 disabled 일 때 여기서 return 하지 않는다는 점뿐이다.
   *    전에는 24행이 곧바로 next() 를 돌려줘서 아래에 무엇을 붙여도
   *    실행되지 않았다(현재 DEMO_BASIC_AUTH_* 2줄이 주석이라 항상 disabled).
   */
  const configuration = getDemoAuthConfiguration();

  if (configuration.status === "invalid") {
    return NextResponse.json(
      { message: "시연 서버 인증 환경변수 설정을 확인해 주세요." },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  if (configuration.status === "enabled") {
    if (
      !isValidBasicAuthorization(
        request.headers.get("authorization"),
        configuration.username,
        configuration.password,
      )
    ) {
      return new NextResponse("Co끼리 팀 시연 페이지입니다. 전달받은 계정으로 로그인해 주세요.", {
        status: 401,
        headers: {
          ...NO_STORE_HEADERS,
          "WWW-Authenticate": 'Basic realm="Donworry team demo", charset="UTF-8"',
        },
      });
    }
    /*
     * 자격증명을 통과한 요청은 아래 문맥 검사를 건너뛴다.
     * 팀이 curl -u 로 점검할 수 있는 통로를 남기기 위함이다
     * (scripts/openai-responses-live-smoke.mjs 가 그 방식으로 동작한다).
     */
    return NextResponse.next();
  }

  /*
   * 3) API 게이트 — 외부에서 /api/* 를 직접 호출하는 것을 막는다.
   *    화면 경로에는 걸지 않는다. 일반인 열람은 그대로 열려 있어야 한다.
   */
  if (
    isApiGuardEnabled() &&
    pathname.startsWith("/api/") &&
    !ATTACHMENT_PATH.test(pathname) &&
    !hasBrowserContext(request)
  ) {
    return blockedResponse();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
