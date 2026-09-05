import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET } from "@/app/api/health/live/route";

describe("GET /api/health/live", () => {
  it("외부 서비스 호출 없이 프로세스 생존 상태만 반환한다", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      api_contract: "donworry.health.v1",
      status: "live",
    });
  });
});
