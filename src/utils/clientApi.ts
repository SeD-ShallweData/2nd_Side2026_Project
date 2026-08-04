interface ApiErrorBody {
  error?: {
    message?: string;
  };
}

export async function readApiResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T | ApiErrorBody;
  if (!response.ok) {
    const message = "error" in (body as ApiErrorBody) ? (body as ApiErrorBody).error?.message : undefined;
    throw new Error(message || "요청을 처리하지 못했습니다.");
  }
  return body as T;
}
