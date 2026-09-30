import { describe, expect, it } from "vitest";

import { ApiRequestError, fallbackErrorMessage, readApiResponse } from "@/utils/clientApi";

async function readFailure(response: Response): Promise<ApiRequestError> {
  try {
    await readApiResponse(response);
  } catch (error) {
    if (error instanceof ApiRequestError) return error;
    throw error;
  }
  throw new Error("응답 읽기가 실패해야 합니다.");
}

describe("화면 응답 도우미", () => {
  it("터널이 빈 본문으로 502 를 돌려주면 JSON 해석 오류 대신 한국어 안내를 보인다", async () => {
    const error = await readFailure(new Response("", { status: 502 }));

    expect(error.message).toBe("서버가 잠시 응답하지 않습니다. 잠시 후 다시 시도해 주세요.");
    expect(error.message).not.toMatch(/JSON|Unexpected/);
    expect(error).toMatchObject({ status: 502, code: null, requestId: null });
  });

  it("HTML 오류 페이지를 받아도 일반 안내를 보인다", async () => {
    const error = await readFailure(new Response("<html><body>Internal Server Error</body></html>", {
      status: 500,
      headers: { "content-type": "text/html" },
    }));

    expect(error.message).toBe("요청을 처리하지 못했습니다.");
    expect(error.message).not.toContain("<html>");
  });

  it("봉투 없는 429 는 요청이 많다고 안내한다", async () => {
    const error = await readFailure(new Response("Too Many Requests", { status: 429 }));

    expect(error.message).toBe("요청이 많습니다. 잠시 후 다시 시도해 주세요.");
  });

  it("서버 오류 봉투가 있으면 그 문구와 코드·문의 번호를 그대로 쓴다", async () => {
    const error = await readFailure(Response.json({
      error: { code: "PUBLIC_RATE_LIMITED", message: "잠시 후 다시 이용해 주세요.", retryable: true, request_id: "req_abc" },
    }, { status: 429 }));

    expect(error.message).toBe("잠시 후 다시 이용해 주세요.");
    expect(error).toMatchObject({ status: 429, code: "PUBLIC_RATE_LIMITED", requestId: "req_abc" });
  });

  it("JSON 이지만 봉투가 아닌 오류(null, 배열)도 상태별 안내로 바꾼다", async () => {
    expect((await readFailure(new Response("null", { status: 503 }))).message)
      .toBe("서버가 잠시 응답하지 않습니다. 잠시 후 다시 시도해 주세요.");
    expect((await readFailure(new Response("[]", { status: 400 }))).message).toBe("요청을 처리하지 못했습니다.");
  });

  it("성공 응답은 JSON 본문을 그대로 돌려준다", async () => {
    await expect(readApiResponse(Response.json({ items: [1, 2] }))).resolves.toEqual({ items: [1, 2] });
  });

  it("성공 응답인데 본문을 해석할 수 없으면 해석 실패 안내를 보인다", async () => {
    const error = await readFailure(new Response("", { status: 200 }));

    expect(error.message).toBe("서버 응답을 해석하지 못했습니다.");
    expect(error.code).toBe("INVALID_RESPONSE_BODY");
  });

  it("상태별 대체 문구", () => {
    expect(fallbackErrorMessage(504)).toBe("서버가 잠시 응답하지 않습니다. 잠시 후 다시 시도해 주세요.");
    expect(fallbackErrorMessage(404)).toBe("요청을 처리하지 못했습니다.");
  });
});
