import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseChatRequest } from "@/services/chatService";

const BASE_REQUEST = {
  message: "연차는 어떻게 쓰나요?",
  chat_mode: "general",
  recent_messages: [],
};

describe("상담 비교 요청 검증", () => {
  it("compare를 생략하면 기본 단일 호출로 정규화한다", () => {
    expect(parseChatRequest(BASE_REQUEST).compare).toBe(false);
  });

  it("명시적인 compare=true만 비교 호출로 허용한다", () => {
    expect(parseChatRequest({ ...BASE_REQUEST, compare: true }).compare).toBe(true);
    expect(parseChatRequest({ ...BASE_REQUEST, compare: false }).compare).toBe(false);
  });

  it("문자열 true처럼 잘못된 값은 비용이 드는 비교 요청으로 해석하지 않는다", () => {
    expect(() => parseChatRequest({ ...BASE_REQUEST, compare: "true" })).toThrow(
      "비교 요청 형식을 확인해 주세요.",
    );
  });
});
