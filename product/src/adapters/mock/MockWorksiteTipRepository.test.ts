import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MockWorksiteTipRepository } from "@/adapters/mock/MockWorksiteTipRepository";
import type { NewWorksiteTip } from "@/domain/worksiteTip";

function tip(
  tipId: string,
  status: NewWorksiteTip["status"],
  submittedAt: string,
): NewWorksiteTip {
  return {
    tip_id: tipId,
    reporter_id: "10000000-0000-4000-8000-000000000001",
    category: "safety",
    status,
    title: tipId,
    body: "정렬 검증용 현장 제보입니다.",
    company_context: null,
    submitted_at: submittedAt,
    attachments: [],
  };
}

describe("현장 제보 Mock 목록 정렬", () => {
  const repository = new MockWorksiteTipRepository();

  beforeEach(() => repository.resetForTests());

  it("미처리 상태를 우선하고 동일 상태에서는 최신 제보를 먼저 반환한다", async () => {
    await repository.insertTip(tip("received-old", "received", "2026-09-13T01:00:00.000Z"));
    await repository.insertTip(tip("completed-new", "completed", "2026-09-14T04:00:00.000Z"));
    await repository.insertTip(tip("in-progress-new", "in_progress", "2026-09-14T03:00:00.000Z"));
    await repository.insertTip(tip("received-new", "received", "2026-09-14T02:00:00.000Z"));

    const result = await repository.listTips(10, 1);

    expect(result.items.map((item) => item.tip_id)).toEqual([
      "received-new",
      "received-old",
      "in-progress-new",
      "completed-new",
    ]);
  });
});
