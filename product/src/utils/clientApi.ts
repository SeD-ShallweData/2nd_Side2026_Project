/*
 * 화면이 같은 출처 API 응답을 읽는 공용 도우미.
 *
 * 본문을 먼저 글자로 받은 뒤 JSON 으로 풀어 본다. 공개 터널이 빈 본문의 502 를 돌려주거나
 * 앞단이 HTML 오류 페이지를 돌려주면 response.json() 이 "Unexpected end of JSON input" 같은
 * 브라우저 원문을 던지고, 그 문구가 화면에 그대로 떴다. 이제는 상태 코드에 맞는 한국어
 * 안내로 바꾼다. 서버가 오류 봉투({ error: { message } })를 보냈으면 그 문구를 그대로 쓴다.
 */

const DEFAULT_ERROR_MESSAGE = "요청을 처리하지 못했습니다.";
const RATE_LIMITED_MESSAGE = "요청이 많습니다. 잠시 후 다시 시도해 주세요.";
const UNAVAILABLE_MESSAGE = "서버가 잠시 응답하지 않습니다. 잠시 후 다시 시도해 주세요.";
const INVALID_RESPONSE_MESSAGE = "서버 응답을 해석하지 못했습니다.";

/** 화면은 지금처럼 message 만 쓰면 된다. 상태·코드·문의 번호는 필요한 곳에서 꺼내 쓴다. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly requestId: string | null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
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

/** 오류 봉투가 없을 때 상태 코드로 고르는 안내. */
export function fallbackErrorMessage(status: number): string {
  if (status === 429) return RATE_LIMITED_MESSAGE;
  if (status === 502 || status === 503 || status === 504) return UNAVAILABLE_MESSAGE;
  return DEFAULT_ERROR_MESSAGE;
}

export async function readApiResponse<T>(response: Response): Promise<T> {
  // 읽는 도중 요청이 취소되면(AbortError) 그대로 던진다. 화면이 취소를 오류로 보지 않게 한다.
  const rawBody = await response.text();
  const parsed = parseJson(rawBody);
  if (!response.ok) {
    const envelope = asRecord(asRecord(parsed)?.error);
    const message = typeof envelope?.message === "string" && envelope.message.trim()
      ? envelope.message
      : fallbackErrorMessage(response.status);
    throw new ApiRequestError(
      message,
      response.status,
      typeof envelope?.code === "string" ? envelope.code : null,
      typeof envelope?.request_id === "string" ? envelope.request_id : null,
    );
  }
  if (parsed === undefined) {
    throw new ApiRequestError(INVALID_RESPONSE_MESSAGE, response.status, "INVALID_RESPONSE_BODY", null);
  }
  return parsed as T;
}

/** 같은 출처 JSON POST. 운영 콘솔 변경 요청처럼 결과를 바로 읽어야 할 때 쓴다. */
export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return readApiResponse<T>(response);
}
