import type {
  CommunityModerationReportDto,
  CommunityModerationReportListResponse,
  CommunityReportStatus,
  ReviewCommunityReportRequest,
} from "@/app/api/community/communityApiContract";
import type { ErrorDetail } from "@/utils/errors";

const MODERATION_REPORTS_PATH = "/api/community/moderation/reports";
const UNEXPECTED_ERROR_CODE = "UNEXPECTED_ERROR_RESPONSE";
const INVALID_RESPONSE_BODY_CODE = "INVALID_RESPONSE_BODY";
const DEFAULT_ERROR_MESSAGE = "요청을 처리하지 못했습니다.";

export class ModerationApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly requestId: string | null,
    public readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = "ModerationApiError";
  }
}

export interface ModerationRequestOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface ListModerationReportsParams {
  status?: CommunityReportStatus | null;
  page?: number;
  limit?: number;
}

function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readErrorDetails(value: unknown): ErrorDetail[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const details = value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .filter((entry) => typeof entry.reason === "string")
    .map((entry) => ({
      field: typeof entry.field === "string" ? entry.field : undefined,
      reason: entry.reason as string,
    }));
  return details.length > 0 ? details : undefined;
}

function toModerationApiError(status: number, rawBody: string): ModerationApiError {
  const envelope = asRecord(asRecord(parseJson(rawBody))?.error);
  const code = typeof envelope?.code === "string" && envelope.code ? envelope.code : UNEXPECTED_ERROR_CODE;
  const message =
    typeof envelope?.message === "string" && envelope.message ? envelope.message : DEFAULT_ERROR_MESSAGE;
  // 봉투가 없거나 깨진 응답에서는 5xx만 재시도 가능한 것으로 본다.
  const retryable = typeof envelope?.retryable === "boolean" ? envelope.retryable : status >= 500;
  const requestId = typeof envelope?.request_id === "string" ? envelope.request_id : null;
  return new ModerationApiError(status, code, message, retryable, requestId, readErrorDetails(envelope?.details));
}

async function requestModerationApi<T>(
  path: string,
  init: RequestInit,
  options: ModerationRequestOptions,
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // 세션은 같은 origin의 HttpOnly 쿠키가 담당한다. 토큰을 읽거나 저장하지 않는다.
  const response = await fetchImpl(path, { ...init, signal: options.signal });
  const rawBody = await response.text();
  if (!response.ok) throw toModerationApiError(response.status, rawBody);

  const parsed = parseJson(rawBody);
  if (parsed === undefined) {
    throw new ModerationApiError(
      response.status,
      INVALID_RESPONSE_BODY_CODE,
      "서버 응답을 해석하지 못했습니다.",
      true,
      null,
    );
  }
  return parsed as T;
}

function buildListQuery(params: ListModerationReportsParams): string {
  const searchParams = new URLSearchParams();
  if (params.status) searchParams.set("status", params.status);
  if (params.page !== undefined) searchParams.set("page", String(params.page));
  if (params.limit !== undefined) searchParams.set("limit", String(params.limit));
  const serialized = searchParams.toString();
  return serialized ? `?${serialized}` : "";
}

export async function listModerationReports(
  params: ListModerationReportsParams = {},
  options: ModerationRequestOptions = {},
): Promise<CommunityModerationReportListResponse> {
  return requestModerationApi<CommunityModerationReportListResponse>(
    `${MODERATION_REPORTS_PATH}${buildListQuery(params)}`,
    { method: "GET" },
    options,
  );
}

export async function reviewModerationReport(
  reportId: string,
  input: ReviewCommunityReportRequest,
  options: ModerationRequestOptions = {},
): Promise<CommunityModerationReportDto> {
  return requestModerationApi<CommunityModerationReportDto>(
    `${MODERATION_REPORTS_PATH}/${encodeURIComponent(reportId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    options,
  );
}
