import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseChatHttpRequest } from "@/server/chatHttpRequest";

describe("chat HTTP 입력 계약", () => {
  it("기존 application/json 요청은 그대로 보존한다", async () => {
    const body = { message: "임금 질문", chat_mode: "wage", recent_messages: [] };
    const parsed = await parseChatHttpRequest(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

    expect(parsed).toEqual({ body });
  });

  it("multipart 파일은 모델 JSON이 아니라 request-scoped tool context로 분리한다", async () => {
    const form = new FormData();
    const file = new File(["%PDF synthetic"], "contract.pdf", {
      type: "application/pdf",
    });
    form.append("file", file);
    form.append("message", " 이 계약서를 검토해 주세요. ");
    form.append(
      "recent_messages",
      JSON.stringify([{ role: "assistant", content: "이전 답변" }]),
    );

    const parsed = await parseChatHttpRequest(
      new Request("http://localhost/api/chat", { method: "POST", body: form }),
    );

    expect(parsed.body).toEqual({
      message: "이 계약서를 검토해 주세요.",
      conversation_id: undefined,
      company_id: undefined,
      chat_mode: "contract",
      recent_messages: [{ role: "assistant", content: "이전 답변" }],
    });
    expect(parsed.toolContext?.contractRequest).toMatchObject({
      file,
      file_metadata: {
        file_name: "contract.pdf",
        content_type: "application/pdf",
        size_bytes: file.size,
      },
    });
    expect(JSON.stringify(parsed.body)).not.toContain("%PDF");
  });

  it("파일 없는 multipart, 잘못된 MIME, 깨진 recent_messages를 거부한다", async () => {
    const empty = new FormData();
    await expect(
      parseChatHttpRequest(
        new Request("http://localhost/api/chat", { method: "POST", body: empty }),
      ),
    ).rejects.toMatchObject({ code: "CONTRACT_FILE_REQUIRED" });

    const wrongType = new FormData();
    wrongType.append("file", new File(["text"], "contract.txt", { type: "text/plain" }));
    await expect(
      parseChatHttpRequest(
        new Request("http://localhost/api/chat", { method: "POST", body: wrongType }),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });

    const malformed = new FormData();
    malformed.append(
      "file",
      new File(["%PDF"], "contract.pdf", { type: "application/pdf" }),
    );
    malformed.append("recent_messages", "[");
    await expect(
      parseChatHttpRequest(
        new Request("http://localhost/api/chat", { method: "POST", body: malformed }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("지원하지 않는 Content-Type을 415 오류로 거부한다", async () => {
    await expect(
      parseChatHttpRequest(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "hello",
        }),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE", status: 415 });
  });
});
