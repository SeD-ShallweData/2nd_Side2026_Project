import type {
  FavoriteDeleteResponse,
  FavoriteListResponse,
  FavoriteUpsertResponse,
} from "@/app/api/users/me/favorites/favoriteApiContract";
import type { ErrorDetail } from "@/utils/errors";

const FAVORITES_PATH = "/api/users/me/favorites";
const UNEXPECTED_ERROR_CODE = "UNEXPECTED_ERROR_RESPONSE";
const INVALID_RESPONSE_BODY_CODE = "INVALID_RESPONSE_BODY";
const DEFAULT_ERROR_MESSAGE = "요청을 처리하지 못했습니다.";

export class FavoriteApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly requestId: string | null,
    public readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = "FavoriteApiError";
  }
}

export interface FavoriteRequestOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
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

function toFavoriteApiError(status: number, rawBody: string): FavoriteApiError {
  const envelope = asRecord(asRecord(parseJson(rawBody))?.error);
  const code = typeof envelope?.code === "string" && envelope.code ? envelope.code : UNEXPECTED_ERROR_CODE;
  const message =
    typeof envelope?.message === "string" && envelope.message ? envelope.message : DEFAULT_ERROR_MESSAGE;
  // 봉투가 없거나 깨진 응답에서는 5xx만 재시도 가능한 것으로 본다.
  const retryable = typeof envelope?.retryable === "boolean" ? envelope.retryable : status >= 500;
  const requestId = typeof envelope?.request_id === "string" ? envelope.request_id : null;
  return new FavoriteApiError(status, code, message, retryable, requestId, readErrorDetails(envelope?.details));
}

async function requestFavoriteApi<T>(
  path: string,
  init: RequestInit,
  options: FavoriteRequestOptions,
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // 세션은 같은 origin의 HttpOnly 쿠키가 담당한다. 사용자 식별값을 요청에 싣지 않는다.
  const response = await fetchImpl(path, { ...init, signal: options.signal });
  const rawBody = await response.text();
  if (!response.ok) throw toFavoriteApiError(response.status, rawBody);

  const parsed = parseJson(rawBody);
  if (parsed === undefined) {
    throw new FavoriteApiError(
      response.status,
      INVALID_RESPONSE_BODY_CODE,
      "서버 응답을 해석하지 못했습니다.",
      true,
      null,
    );
  }
  return parsed as T;
}

export async function getFavorites(
  options: FavoriteRequestOptions = {},
): Promise<FavoriteListResponse> {
  return requestFavoriteApi<FavoriteListResponse>(FAVORITES_PATH, { method: "GET" }, options);
}

export async function addFavorite(
  companyId: string,
  options: FavoriteRequestOptions = {},
): Promise<FavoriteUpsertResponse> {
  // 계약상 요청 본문이 없으므로 Content-Type도 보내지 않는다.
  return requestFavoriteApi<FavoriteUpsertResponse>(
    `${FAVORITES_PATH}/${encodeURIComponent(companyId)}`,
    { method: "PUT" },
    options,
  );
}

export async function removeFavorite(
  companyId: string,
  options: FavoriteRequestOptions = {},
): Promise<FavoriteDeleteResponse> {
  return requestFavoriteApi<FavoriteDeleteResponse>(
    `${FAVORITES_PATH}/${encodeURIComponent(companyId)}`,
    { method: "DELETE" },
    options,
  );
}
