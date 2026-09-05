import { NextRequest, NextResponse } from "next/server";

import {
  getDemoAuthConfiguration,
  isValidBasicAuthorization,
} from "@/server/demoBasicAuth";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

const PUBLIC_HEALTH_PATHS = new Set([
  "/api/health/live",
  "/api/health/ready",
]);

export function proxy(request: NextRequest) {
  if (PUBLIC_HEALTH_PATHS.has(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const configuration = getDemoAuthConfiguration();

  if (configuration.status === "disabled") {
    return NextResponse.next();
  }

  if (configuration.status === "invalid") {
    return NextResponse.json(
      { message: "시연 서버 인증 환경변수 설정을 확인해 주세요." },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  if (
    isValidBasicAuthorization(
      request.headers.get("authorization"),
      configuration.username,
      configuration.password,
    )
  ) {
    return NextResponse.next();
  }

  return new NextResponse("돈워리 팀 시연 페이지입니다. 전달받은 계정으로 로그인해 주세요.", {
    status: 401,
    headers: {
      ...NO_STORE_HEADERS,
      "WWW-Authenticate": 'Basic realm="Donworry team demo", charset="UTF-8"',
    },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
