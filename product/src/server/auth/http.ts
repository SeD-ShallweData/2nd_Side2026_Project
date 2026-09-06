import "server-only";

import { NextResponse } from "next/server";

import { errorPayload, ServiceError } from "@/utils/errors";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
const MAX_JSON_BODY_BYTES = 64 * 1024;

export function noStoreJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

export function noStoreError(error: unknown): NextResponse {
  const payload = errorPayload(error);
  return NextResponse.json(payload.body, {
    status: payload.status,
    headers: NO_STORE_HEADERS,
  });
}

export function assertSameOriginRequest(request: Request): void {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    throw new ServiceError("CROSS_SITE_REQUEST_REJECTED", "허용되지 않은 출처의 요청입니다.", 403, false);
  }

  const origin = request.headers.get("origin");
  if (!origin) return;
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

export async function readJsonBody(request: Request): Promise<unknown> {
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
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
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
        if (totalBytes > MAX_JSON_BODY_BYTES) {
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
