import { NextResponse } from "next/server";
import type { ContractReviewRequest } from "@/domain/contract";
import { reviewContract } from "@/services/contractService";
import { errorPayload, ServiceError } from "@/utils/errors";

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
    const input = await parseRequest(request);
    input.signal = request.signal;
    return NextResponse.json(await reviewContract(input));
  } catch (error) {
    const payload = errorPayload(error);
    return NextResponse.json(payload.body, { status: payload.status });
  }
}
