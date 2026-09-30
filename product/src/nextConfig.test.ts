import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

describe("next.config 보안 설정", () => {
  it("x-powered-by 헤더를 끈다", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("모든 경로에 프레임 차단·nosniff·Referrer-Policy 를 붙인다", async () => {
    const rules = await nextConfig.headers?.();

    expect(rules).toEqual([
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ]);
  });

  it("전체 CSP 와 HSTS 는 넣지 않는다(프레임 차단만)", async () => {
    const headers = (await nextConfig.headers?.())?.flatMap((rule) => rule.headers) ?? [];
    const keys = headers.map((header) => header.key.toLowerCase());

    expect(keys).not.toContain("strict-transport-security");
    const csp = headers.find((header) => header.key === "Content-Security-Policy")?.value;
    expect(csp).toBe("frame-ancestors 'none'");
  });

  it("브라우저용 소스맵을 켜지 않는다", () => {
    expect(nextConfig.productionBrowserSourceMaps).not.toBe(true);
  });
});
