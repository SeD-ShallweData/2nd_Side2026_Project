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
