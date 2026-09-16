import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { assertSameOriginRequest } from "@/server/auth/http";

/*
 * 시연 서버는 Tailscale Funnel(HTTPS) 뒤에서 평문 HTTP 로 돈다. Next 는 Host 헤더를
 * 무시하고 자기 바인딩 주소로 request.url 을 만들기 때문에, Origin 문자열 비교만으로는
 * 브라우저 요청이 절대 통과하지 못한다. 2026-09-15 실측값을 그대로 회귀로 고정한다.
 */
const INTERNAL_URL = "http://localhost:3111/api/auth/login";
const BROWSER_ORIGIN = "https://moneyworry-demo.tail87a779.ts.net";

function post(headers: Record<string, string>): Request {
  return new Request(INTERNAL_URL, { method: "POST", headers });
}

describe("assertSameOriginRequest", () => {
  it("cross-site 는 거부한다", () => {
    expect(() => assertSameOriginRequest(post({
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    }))).toThrow();
  });

  it("프록시 뒤에서 Origin 이 달라도 same-origin 이면 통과한다", () => {
    // ← 이번 버그. 고치기 전에는 403 이었다.
    expect(() => assertSameOriginRequest(post({
      origin: BROWSER_ORIGIN,
      "sec-fetch-site": "same-origin",
    }))).not.toThrow();
  });

  it("같은 사이트(서브도메인)도 통과한다", () => {
    expect(() => assertSameOriginRequest(post({
      origin: BROWSER_ORIGIN,
      "sec-fetch-site": "same-site",
    }))).not.toThrow();
  });

  it("Origin 이 없으면 통과한다", () => {
    expect(() => assertSameOriginRequest(post({}))).not.toThrow();
  });

  it("Sec-Fetch-Site 없이 Origin 만 어긋나면 거부한다", () => {
    expect(() => assertSameOriginRequest(post({
      origin: "https://attacker.example",
    }))).toThrow();
  });

  it("Sec-Fetch-Site 없이 프록시 헤더가 일치하면 통과한다", () => {
    expect(() => assertSameOriginRequest(post({
      origin: BROWSER_ORIGIN,
      "x-forwarded-proto": "https",
      "x-forwarded-host": "moneyworry-demo.tail87a779.ts.net",
    }))).not.toThrow();
  });

  it("Sec-Fetch-Site 없이 request.url 과 같은 Origin 이면 통과한다", () => {
    expect(() => assertSameOriginRequest(post({
      origin: "http://localhost:3111",
    }))).not.toThrow();
  });
});
