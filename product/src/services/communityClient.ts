import type {
  CommunityCategory,
  CommunityPostDto,
  CommunityPostListResponse,
  CommunityReportReceiptDto,
  CreateCommunityPostRequest,
  CreateCommunityReportRequest,
} from "@/app/api/community/communityApiContract";
import type { ErrorDetail } from "@/utils/errors";

const COMMUNITY_POSTS_PATH = "/api/community/posts";
const UNEXPECTED_ERROR_CODE = "UNEXPECTED_ERROR_RESPONSE";
const INVALID_RESPONSE_BODY_CODE = "INVALID_RESPONSE_BODY";
const DEFAULT_ERROR_MESSAGE = "요청을 처리하지 못했습니다.";

export class CommunityApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly requestId: string | null,
    public readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = "CommunityApiError";
  }
}

export interface CommunityRequestOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface ListCommunityPostsParams {
  q?: string;
  category?: CommunityCategory | null;
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

function toCommunityApiError(status: number, rawBody: string): CommunityApiError {
  const envelope = asRecord(asRecord(parseJson(rawBody))?.error);
  const code = typeof envelope?.code === "string" && envelope.code ? envelope.code : UNEXPECTED_ERROR_CODE;
  const message =
    typeof envelope?.message === "string" && envelope.message ? envelope.message : DEFAULT_ERROR_MESSAGE;
  // 봉투가 없거나 깨진 응답에서는 5xx만 재시도 가능한 것으로 본다.
  const retryable = typeof envelope?.retryable === "boolean" ? envelope.retryable : status >= 500;
  const requestId = typeof envelope?.request_id === "string" ? envelope.request_id : null;
  return new CommunityApiError(status, code, message, retryable, requestId, readErrorDetails(envelope?.details));
}

async function requestCommunityApi<T>(
  path: string,
  init: RequestInit,
  options: CommunityRequestOptions,
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // 세션은 같은 origin의 HttpOnly 쿠키가 담당한다. 토큰을 읽거나 저장하지 않는다.
  const response = await fetchImpl(path, { ...init, signal: options.signal });
  const rawBody = await response.text();
  if (!response.ok) throw toCommunityApiError(response.status, rawBody);

  const parsed = parseJson(rawBody);
  if (parsed === undefined) {
    throw new CommunityApiError(
      response.status,
      INVALID_RESPONSE_BODY_CODE,
      "서버 응답을 해석하지 못했습니다.",
      true,
      null,
    );
  }
  return parsed as T;
}

function jsonMutation(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function buildListQuery(params: ListCommunityPostsParams): string {
  const searchParams = new URLSearchParams();
  const query = params.q?.trim();
  if (query) searchParams.set("q", query);
  if (params.category) searchParams.set("category", params.category);
  if (params.page !== undefined) searchParams.set("page", String(params.page));
  if (params.limit !== undefined) searchParams.set("limit", String(params.limit));
  const serialized = searchParams.toString();
  return serialized ? `?${serialized}` : "";
}

function toCreatePostBody(input: CreateCommunityPostRequest): CreateCommunityPostRequest {
  const body: CreateCommunityPostRequest = {
    category: input.category,
    title: input.title,
    body: input.body,
  };
  if (input.company_id !== undefined) body.company_id = input.company_id;
  if (input.anonymous !== undefined) body.anonymous = input.anonymous;
  return body;
}

function toCreateReportBody(input: CreateCommunityReportRequest): CreateCommunityReportRequest {
  const body: CreateCommunityReportRequest = { reason: input.reason };
  if (input.detail !== undefined) body.detail = input.detail;
  return body;
}

export async function listCommunityPosts(
  params: ListCommunityPostsParams = {},
  options: CommunityRequestOptions = {},
): Promise<CommunityPostListResponse> {
  return requestCommunityApi<CommunityPostListResponse>(
    `${COMMUNITY_POSTS_PATH}${buildListQuery(params)}`,
    { method: "GET" },
    options,
  );
}

export async function getCommunityPost(
  postId: string,
  options: CommunityRequestOptions = {},
): Promise<CommunityPostDto> {
  return requestCommunityApi<CommunityPostDto>(
    `${COMMUNITY_POSTS_PATH}/${encodeURIComponent(postId)}`,
    { method: "GET" },
    options,
  );
}

export async function createCommunityPost(
  input: CreateCommunityPostRequest,
  options: CommunityRequestOptions = {},
): Promise<CommunityPostDto> {
  return requestCommunityApi<CommunityPostDto>(
    COMMUNITY_POSTS_PATH,
    jsonMutation(toCreatePostBody(input)),
    options,
  );
}

export async function reportCommunityPost(
  postId: string,
  input: CreateCommunityReportRequest,
  options: CommunityRequestOptions = {},
): Promise<CommunityReportReceiptDto> {
  return requestCommunityApi<CommunityReportReceiptDto>(
    `${COMMUNITY_POSTS_PATH}/${encodeURIComponent(postId)}/reports`,
    jsonMutation(toCreateReportBody(input)),
    options,
  );
}
