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

/** 화면에 보여 줄 오류 상세. 재시도까지 남은 초(retry_after_seconds)는 안내 문장에 이미 있어 뺀다. */
export function displayableErrorDetails(details: ErrorDetail[] | undefined): ErrorDetail[] | undefined {
  const visible = details?.filter((detail) => detail.field !== "retry_after_seconds");
  return visible?.length ? visible : undefined;
}

/**
 * 한도 초과(429) 오류가 details.retry_after_seconds 로 알려 준 재시도 초를 Retry-After 헤더로 옮긴다.
 * 해당 값이 없는 오류에는 빈 객체를 돌려주므로 응답 헤더에 그대로 펼쳐 넣으면 된다.
 */
export function retryAfterHeaders(error: unknown): Record<string, string> {
  if (!(error instanceof ServiceError) || error.status !== 429) return {};
  const seconds = error.details?.find((detail) => detail.field === "retry_after_seconds")?.reason;
  return seconds && /^[1-9]\d{0,9}$/.test(seconds) ? { "Retry-After": seconds } : {};
}

export function errorPayload(error: unknown): {
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
} {
  const requestId = `req_${crypto.randomUUID()}`;
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
