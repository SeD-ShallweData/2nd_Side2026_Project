import "server-only";

import { NextResponse } from "next/server";

import { errorPayload, retryAfterHeaders, ServiceError } from "@/utils/errors";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
const MAX_JSON_BODY_BYTES = 64 * 1024;

/*
 * 긴 글을 싣는 JSON 요청의 본문 상한. 상담(/api/chat), 감독관 점검 보조(/api/inspector/chat),
 * 계약서 테스트 텍스트(/api/contracts/review)가 쓴다.
 *
 * 상담 화면은 최근 답변 전문을 최대 8개(점검 보조는 6개) 싣고, 서버는 파싱한 뒤에야 한 개당
 * 2,000자로 자른다. 계약서 텍스트는 20,000자까지 받는다. 한글은 UTF-8 로 한 글자가 3바이트라
 * 기본 상한(64KB)을 넘을 수 있다. 실제 요청(수백 KB 이하)보다 넉넉하게 잡되 한도는 둔다.
 */
export const LARGE_JSON_BODY_MAX_BYTES = 1024 * 1024;

export function noStoreJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

/* 한도 초과(429)는 남은 시간을 Retry-After 헤더로도 알려 준다. */
export function noStoreError(error: unknown): NextResponse {
  const payload = errorPayload(error);
  return NextResponse.json(payload.body, {
    status: payload.status,
    headers: { ...NO_STORE_HEADERS, ...retryAfterHeaders(error) },
  });
}

export function assertSameOriginRequest(request: Request): void {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    throw new ServiceError("CROSS_SITE_REQUEST_REJECTED", "허용되지 않은 출처의 요청입니다.", 403, false);
  }

  /*
   * Sec-Fetch-Site 가 왔으면 그것으로 판정을 끝낸다.
   *
   * 이 헤더는 forbidden header name 이라 페이지 스크립트가 덮어쓸 수 없고, 브라우저가
   * 직접 붙인다. 공격자 페이지에서 보낸 요청은 반드시 cross-site 가 되므로 CSRF 방어로
   * 충분하다. 헤더를 위조할 수 있는 것은 브라우저가 아닌 클라이언트인데, 그건 피해자의
   * 자격증명을 태우지 못해 CSRF 가 아니다.
   *
   * 아래 Origin 비교를 앞세우면 리버스 프록시 뒤에서 성립하지 않는다. Next 는 Host 헤더를
   * 무시하고 자기 바인딩 주소로 request.url 을 만들기 때문이다. 시연 서버에서 실측한 값은
   * 이렇다 (2026-09-15).
   *
   *   브라우저 Origin      https://moneyworry-demo.<테일넷>.ts.net
   *   new URL(request.url) http://localhost:3111
   *
   * 둘이 절대 같아질 수 없어 로그인·회원가입·커뮤니티 글쓰기·현장 제보가 전부 403 이었다.
   */
  if (fetchSite) return;

  const origin = request.headers.get("origin");
  if (!origin) return;

  /*
   * Sec-Fetch-Site 를 보내지 않는 클라이언트만 여기까지 온다. 프록시가 알려준 외부 주소를
   * 먼저 보고, 없으면 종전대로 request.url 로 비교한다.
   */
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (forwardedProto && forwardedHost && origin === `${forwardedProto}://${forwardedHost}`) {
    return;
  }

  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(request.url).origin;
  } catch {
    throw new ServiceError("CROSS_SITE_REQUEST_REJECTED", "요청 출처를 확인할 수 없습니다.", 403, false);
  }
  if (origin !== expectedOrigin) {
    throw new ServiceError("CROSS_SITE_REQUEST_REJECTED", "허용되지 않은 출처의 요청입니다.", 403, false);
  }
}

export async function readJsonBody(request: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US");
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new ServiceError(
      "UNSUPPORTED_MEDIA_TYPE",
      "application/json 형식의 요청만 지원합니다.",
      415,
      false,
    );
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ServiceError("REQUEST_BODY_TOO_LARGE", "요청 본문이 너무 큽니다.", 413, false);
  }

  try {
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new ServiceError("REQUEST_BODY_TOO_LARGE", "요청 본문이 너무 큽니다.", 413, false);
        }
        chunks.push(value);
      }
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(
      "INVALID_JSON",
      "요청 본문이 올바른 JSON 형식이 아닙니다.",
      400,
      false,
    );
  }
}
