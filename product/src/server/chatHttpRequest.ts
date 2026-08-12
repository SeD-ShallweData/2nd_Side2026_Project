import type { ToolExecutionContext } from "@/server/responses/toolContracts";
import { validateContractRequest } from "@/services/contractService";
import { ServiceError } from "@/utils/errors";

export interface ParsedChatHttpRequest {
  body: unknown;
  toolContext?: ToolExecutionContext;
}

function validationError(field: string, reason: string): ServiceError {
  return new ServiceError(
    "VALIDATION_ERROR",
    "상담 요청 형식을 확인해 주세요.",
    400,
    false,
    [{ field, reason }],
  );
}

function optionalString(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recentMessages(value: FormDataEntryValue | null): unknown {
  if (value === null || value === "") return [];
  if (typeof value !== "string") {
    throw validationError("recent_messages", "JSON 배열 문자열이어야 합니다.");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw validationError("recent_messages", "유효한 JSON 배열 문자열이어야 합니다.");
  }
}

async function parseMultipart(request: Request): Promise<ParsedChatHttpRequest> {
  const form = await request.formData();
  const fileValue = form.get("file");
  const file = fileValue instanceof File && fileValue.size > 0 ? fileValue : undefined;
  if (!file) {
    throw new ServiceError(
      "CONTRACT_FILE_REQUIRED",
      "multipart 상담에는 검토할 계약서 파일이 필요합니다.",
      400,
      false,
    );
  }

  const contractRequest = {
    file,
    file_metadata: {
      file_name: file.name,
      content_type: file.type,
      size_bytes: file.size,
    },
  };
  validateContractRequest(contractRequest);

  return {
    body: {
      message:
        optionalString(form.get("message")) ??
        "현재 업로드한 근로계약서를 검토하고 확인할 항목을 알려주세요.",
      conversation_id: optionalString(form.get("conversation_id")),
      company_id: optionalString(form.get("company_id")),
      chat_mode: optionalString(form.get("chat_mode")) ?? "contract",
      recent_messages: recentMessages(form.get("recent_messages")),
    },
    toolContext: { contractRequest },
  };
}

export async function parseChatHttpRequest(
  request: Request,
): Promise<ParsedChatHttpRequest> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("multipart/form-data")) return parseMultipart(request);
  if (contentType.includes("application/json")) {
    return { body: (await request.json()) as unknown };
  }
  throw new ServiceError(
    "UNSUPPORTED_MEDIA_TYPE",
    "application/json 또는 multipart/form-data 요청만 지원합니다.",
    415,
    false,
  );
}
