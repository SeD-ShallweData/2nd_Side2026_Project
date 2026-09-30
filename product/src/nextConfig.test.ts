import { describe, expect, it } from "vitest";
// Next 가 dev·start 에서 headers() 규칙을 요청 경로에 대어 볼 때 쓰는 함수다(router-utils/filesystem).
// 규칙 모양만 보지 않고, 실제 경로에 어떤 헤더가 붙는지를 같은 판정으로 확인한다.
import { buildCustomRoute } from "next/dist/server/lib/router-utils/filesystem";

import nextConfig from "../next.config";

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

const FRAME_DENY = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
];

const FRAME_DENY_SOURCES = ["/admin/:path*", "/inspector/:path*", "/login", "/signup"];

async function headerRules(): Promise<HeaderRule[]> {
  return (await nextConfig.headers?.()) ?? [];
}

/* 경로 하나에 실제로 붙는 헤더. 같은 키가 겹치면 Next 처럼 뒤 규칙이 앞 규칙을 덮는다. */
async function effectiveHeaders(pathname: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const rule of await headerRules()) {
    if (buildCustomRoute("header", rule).match(pathname) === false) continue;
    for (const header of rule.headers) result.set(header.key.toLowerCase(), header.value);
  }
  return result;
}

describe("next.config 보안 설정", () => {
  it("x-powered-by 헤더를 끈다", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("nosniff·Referrer-Policy 는 모든 경로에, 프레임 차단은 관리자·감독·로그인·회원가입에만 붙인다", async () => {
    expect(await headerRules()).toEqual([
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      ...FRAME_DENY_SOURCES.map((source) => ({ source, headers: FRAME_DENY })),
    ]);
  });

  it("사이트 전체 규칙에는 프레임 차단 헤더가 없다", async () => {
    const siteWide = (await headerRules()).filter((rule) => rule.source === "/:path*");
    const keys = siteWide.flatMap((rule) => rule.headers.map((header) => header.key.toLowerCase()));

    expect(siteWide).toHaveLength(1);
    expect(keys).not.toContain("x-frame-options");
    expect(keys).not.toContain("content-security-policy");
  });

  it("프레임 차단 헤더는 정해 둔 경로 규칙에만 있다", async () => {
    const sourcesWithFrameDeny = (await headerRules())
      .filter((rule) => rule.headers.some((header) => ["x-frame-options", "content-security-policy"].includes(header.key.toLowerCase())))
      .map((rule) => rule.source);

    expect(sourcesWithFrameDeny).toEqual(FRAME_DENY_SOURCES);
  });

  it.each([
    "/admin",
    "/admin/",
    "/admin/batches",
    "/inspector",
    "/inspector/chat",
    "/inspector/batches",
    "/inspector/ml-dashboard",
    "/inspector/prompts",
    "/login",
    "/signup",
  ])("%s 는 다른 사이트의 iframe 에 넣을 수 없다", async (pathname) => {
    const headers = await effectiveHeaders(pathname);

    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  // 발표 슬라이드·Notion·심사 포털 미리보기에 넣어 보여 줄 수 있어야 하는 공개 화면들.
  it.each([
    "/",
    "/chat",
    "/companies",
    "/companies/COMPANY_DEMO_001",
    "/contracts",
    "/community",
    "/community/new",
    "/favorites",
    "/worksite-tips",
    "/administrator",
    "/inspectors",
    "/login-help",
  ])("공개 화면 %s 에는 프레임 차단 헤더를 붙이지 않는다", async (pathname) => {
    const headers = await effectiveHeaders(pathname);

    expect(headers.has("x-frame-options")).toBe(false);
    expect(headers.has("content-security-policy")).toBe(false);
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("전체 CSP 와 HSTS 는 넣지 않는다(프레임 차단만)", async () => {
    const headers = (await headerRules()).flatMap((rule) => rule.headers);
    const keys = headers.map((header) => header.key.toLowerCase());

    expect(keys).not.toContain("strict-transport-security");
    const cspValues = headers.filter((header) => header.key === "Content-Security-Policy").map((header) => header.value);
    expect(new Set(cspValues)).toEqual(new Set(["frame-ancestors 'none'"]));
  });

  it("브라우저용 소스맵을 켜지 않는다", () => {
    expect(nextConfig.productionBrowserSourceMaps).not.toBe(true);
  });
});
