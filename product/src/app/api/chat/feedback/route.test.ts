import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const save = vi.hoisted(() => vi.fn());
vi.mock("@/server/comparisonFeedbackStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/comparisonFeedbackStore")>();
  return { ...actual, saveComparisonFeedback: save };
});

import { POST } from "@/app/api/chat/feedback/route";

const BODY = {
  comparison_id: "cmp_00000000-0000-4000-8000-000000000001",
  selection: "tie",
  result_metrics: [],
};

function request(headers: Record<string, string>) {
  return new Request("http://localhost/api/chat/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(BODY),
  });
}

beforeEach(() => {
  save.mockReset();
  save.mockResolvedValue(undefined);
});

describe("chat feedback mutation boundary", () => {
  it("rejects a browser cross-site write at the route even if the broad proxy gate is disabled", async () => {
    const response = await POST(request({
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CROSS_SITE_REQUEST_REJECTED" },
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("accepts a same-origin feedback write and returns a no-store response", async () => {
    const response = await POST(request({ "sec-fetch-site": "same-origin" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(save).toHaveBeenCalledOnce();
  });
});
