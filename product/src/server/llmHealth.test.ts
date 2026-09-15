import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { LlmProviderConfig } from "@/server/llmConfig";
import {
  probeChatLlmStatuses,
  probeDualLlmStatus,
} from "@/server/llmHealth";

const CONFIGS: LlmProviderConfig[] = [
  { id: "upstage", label: "Upstage", apiKey: "up-key", apiUrl: "https://up.test/chat", model: "solar" },
  { id: "skt", label: "SKT", apiKey: "skt-key", apiUrl: "https://skt.test/chat", model: "ax" },
];

describe("dual LLM health probe", () => {
  it("키가 하나라도 없으면 실제 호출 없이 unavailable이다", async () => {
    const fakeFetch = vi.fn() as unknown as typeof fetch;
    expect(await probeDualLlmStatus([{ ...CONFIGS[0], apiKey: undefined }, CONFIGS[1]], fakeFetch)).toBe("unavailable");
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("만료·차단처럼 공급자가 오류를 반환하면 ready로 표시하지 않는다", async () => {
    const fakeFetch = (async (input: RequestInfo | URL) => new Response(
      String(input).includes("up.test") ? "unauthorized" : JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
      {
        status: String(input).includes("up.test") ? 401 : 200,
        headers: { "Content-Type": "application/json" },
      },
    )) as typeof fetch;
    expect(await probeDualLlmStatus(CONFIGS, fakeFetch)).toBe("configured_unreachable");
  });

  it("두 공급자의 실제 응답 형식까지 확인돼야 ready이다", async () => {
    const fakeFetch = (async () => new Response(
      JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
    expect(await probeDualLlmStatus(CONFIGS, fakeFetch)).toBe("ready");
  });

  it("기본 Upstage와 두 모델 비교 상태를 한 번의 공급자 점검으로 구분한다", async () => {
    const fakeFetch = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;

    const statuses = await probeChatLlmStatuses(
      [CONFIGS[0], { ...CONFIGS[1], apiKey: undefined }],
      fakeFetch,
    );

    expect(statuses).toEqual({
      primary: "ready",
      comparison: "unavailable",
    });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(fakeFetch).toHaveBeenCalledWith(
      "https://up.test/chat",
      expect.any(Object),
    );
  });
});
