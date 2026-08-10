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
