import { redactErrorText } from "@/utils/redactErrorText";

export interface ErrorDetail {
  field?: string;
  reason: string;
}

export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/*
 * 발생한 자리에서 이미 원인을 서버 로그에 남긴 오류라는 표시.
 *
 * postgres.ts 는 읽기 실패를 relation·pg_code 와 함께 남긴 뒤 ServiceError 로 바꿔 던진다.
 * 여기서 한 번 더 남기면 DB 장애 하나가 journald 에 두 줄씩 쌓여 속도 제한(30초당 500줄)을
 * 더 빨리 채운다. 그래서 표시가 붙은 오류는 errorPayload 가 다시 남기지 않는다.
 * 모듈이 번들마다 따로 로드돼도 같은 키가 되도록 Symbol.for 를 쓴다.
 */
const LOGGED_AT_SOURCE = Symbol.for("donworry.error.loggedAtSource");

export function markErrorLogged<T>(error: T): T {
  if (error && typeof error === "object") {
    try {
      Object.defineProperty(error, LOGGED_AT_SOURCE, { value: true, enumerable: false });
    } catch {
      // 얼린 객체라 표시를 못 붙이면 한 줄 더 남을 뿐이다.
    }
  }
  return error;
}

function isErrorLoggedAtSource(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (error as Record<symbol, unknown>)[LOGGED_AT_SOURCE] === true,
  );
}

/*
 * 5xx 기록의 속도 상한. 장애가 나면 요청마다 같은 오류가 나므로, 1분에 30줄까지만 남기고
 * 나머지는 개수만 센다. 다음 창이 열릴 때 몇 줄을 건너뛰었는지 한 줄로 알린다.
 * 평소에는 5xx 가 거의 없어 이 상한에 닿지 않는다.
 */
const API_ERROR_LOG_WINDOW_MS = 60_000;
const API_ERROR_LOG_LIMIT_PER_WINDOW = 30;

const apiErrorLogWindow = { startedAt: 0, logged: 0, suppressed: 0 };

function takeApiErrorLogSlot(now: number): boolean {
  if (now - apiErrorLogWindow.startedAt >= API_ERROR_LOG_WINDOW_MS) {
    if (apiErrorLogWindow.suppressed > 0) {
      console.error(JSON.stringify({
        event: "api_error_log_suppressed",
        suppressed: apiErrorLogWindow.suppressed,
        window_ms: API_ERROR_LOG_WINDOW_MS,
      }));
    }
    apiErrorLogWindow.startedAt = now;
    apiErrorLogWindow.logged = 0;
    apiErrorLogWindow.suppressed = 0;
  }
  if (apiErrorLogWindow.logged >= API_ERROR_LOG_LIMIT_PER_WINDOW) {
    apiErrorLogWindow.suppressed += 1;
    return false;
  }
  apiErrorLogWindow.logged += 1;
  return true;
}

/* 테스트마다 속도 상한 창을 비운다. */
export function resetApiErrorLogForTests(): void {
  apiErrorLogWindow.startedAt = 0;
  apiErrorLogWindow.logged = 0;
  apiErrorLogWindow.suppressed = 0;
}

/*
 * 5xx 응답을 만들 때 서버 로그에 한 줄을 남긴다. 사용자가 알려 준 request_id 로 원인을
 * 찾을 수 있게 하려는 것이다. 응답 본문에는 여전히 고정 문구만 나간다.
 *
 * pg 오류의 detail·hint 는 남기지 않는다. 사용자 이메일 같은 값이 섞여 온다.
 * SQLSTATE(pg_code)와 정리한 message 만 남긴다.
 */
function logServerError(error: unknown, requestId: string, status: number, code: string): void {
  if (isErrorLoggedAtSource(error)) return;
  if (!takeApiErrorLogSlot(Date.now())) return;

  const candidate = error as { name?: unknown; message?: unknown; code?: unknown } | null;
  const isObject = candidate !== null && typeof candidate === "object";
  const errorName = isObject && typeof candidate.name === "string" && candidate.name
    ? candidate.name
    : typeof error;
  const rawMessage = isObject
    ? (typeof candidate.message === "string" ? candidate.message : "")
    : String(error);
  const pgCode = isObject && typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)
    ? candidate.code
    : null;

  console.error(JSON.stringify({
    event: "api_error",
    request_id: requestId,
    status,
    code,
    error_name: errorName,
    pg_code: pgCode,
    message: redactErrorText(rawMessage),
  }));
}

export interface ErrorPayload {
  body: {
    error: {
      code: string;
      message: string;
      details?: ErrorDetail[];
      retryable: boolean;
      request_id: string;
    };
  };
  status: number;
}

function buildErrorPayload(error: unknown, requestId: string): ErrorPayload {
  if (error instanceof ServiceError) {
    return {
      body: {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          retryable: error.retryable,
          request_id: requestId,
        },
      },
      status: error.status,
    };
  }

  return {
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "요청을 처리하는 중 오류가 발생했습니다.",
        retryable: true,
        request_id: requestId,
      },
    },
    status: 500,
  };
}

export function errorPayload(error: unknown): ErrorPayload {
  const requestId = `req_${crypto.randomUUID()}`;
  const payload = buildErrorPayload(error, requestId);
  if (payload.status >= 500) {
    try {
      logServerError(error, requestId, payload.status, payload.body.error.code);
    } catch {
      // 기록에 실패해도 오류 응답은 그대로 나가야 한다.
    }
  }
  return payload;
}
