import { NextResponse } from "next/server";
import type { ContractReviewRequest } from "@/domain/contract";
import { getOptionalSessionUser } from "@/services/authService";
import { reviewContract } from "@/services/contractService";
import { assertSameOriginRequest } from "@/server/auth/http";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";
import { assertAccountRateLimit } from "@/server/accountRateLimit";
import { assertPublicRateLimit } from "@/server/publicRateLimit";
import { errorPayload, retryAfterHeaders, ServiceError } from "@/utils/errors";

async function parseRequest(request: Request): Promise<ContractReviewRequest> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const fileValue = form.get("file");
    const text = form.get("text");
    const scenarioId = form.get("scenario_id");
    const file = fileValue instanceof File && fileValue.size > 0 ? fileValue : null;
    return {
      text: typeof text === "string" ? text : undefined,
      scenario_id: typeof scenarioId === "string" ? scenarioId : undefined,
      file_metadata: file
        ? {
            file_name: file.name,
            content_type: file.type,
            size_bytes: file.size,
          }
        : undefined,
      file: file ?? undefined,
    };
  }
  if (contentType.includes("application/json")) {
    return (await request.json()) as ContractReviewRequest;
  }
  throw new ServiceError(
    "UNSUPPORTED_MEDIA_TYPE",
    "multipart/form-data 또는 application/json 요청만 지원합니다.",
    415,
    false,
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    const user = await getOptionalSessionUser(getSessionTokenFromRequest(request));
    // 익명은 방문자·탭 단위, 로그인 사용자는 계정 단위로 센다. 모두 파일을 읽기 전에 확인한다.
    if (!user) await assertPublicRateLimit(request, "anonymous_contract_review");
    else assertAccountRateLimit("contract_review", user.user_id);
    const input = await parseRequest(request);
    input.signal = request.signal;
    return NextResponse.json(await reviewContract(input));
  } catch (error) {
    const payload = errorPayload(error);
    return NextResponse.json(payload.body, { status: payload.status, headers: retryAfterHeaders(error) });
  }
}
