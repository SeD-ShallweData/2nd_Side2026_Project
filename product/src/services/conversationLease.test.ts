import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { MockConversationRepository } from "@/adapters/mock/MockConversationRepository";

const repository = new MockConversationRepository();
afterEach(() => { repository.resetForTests(); vi.useRealTimers(); });

async function thread() {
  return (await repository.claimRequest({ owner_user_id: "owner", request_id: "lease_regression_request", company_id: null, user_message: "합성 질문" })).conversation_id;
}
describe("summary lease fencing", () => {
  it("keeps a heartbeat-renewed job, reclaims only expired leases, and fences the old writer", async () => {
    vi.useFakeTimers();
    const id = await thread(); const first = (await repository.claimSummary(id, 10))!;
    expect(first).toBeTruthy(); expect(await repository.claimSummary(id, 10)).toBeNull();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(await repository.renewSummary(id, first)).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await repository.claimSummary(id, 10)).toBeNull();
    await vi.advanceTimersByTimeAsync(91_000);
    const second = (await repository.claimSummary(id, 10))!; expect(second).not.toBe(first);
    expect(await repository.renewSummary(id, first)).toBe(false);
    await repository.failSummary(id, 10, "STALE", first);
    const summary = (await repository.findSummary(id))!.summary;
    expect((await repository.findSummary(id))!.status).toBe("pending");
    expect(await repository.completeSummary({ conversation_id: id, through_sequence: 10, summary, summary_version: "old", lease_token: first })).toBe(false);
    expect(await repository.completeSummary({ conversation_id: id, through_sequence: 10, summary, summary_version: "new", lease_token: second })).toBe(true);
    expect(await repository.claimSummary(id, 10)).toBeNull();
    expect((await repository.findSummary(id))!.summary_version).toBe("new");
  });
  it("never revives a deleted or expired conversation", async () => {
    vi.useFakeTimers();
    const id = await thread(); const token = (await repository.claimSummary(id, 10))!;
    await repository.deleteConversation(id, "owner");
    expect(await repository.renewSummary(id, token)).toBe(false);
    expect(await repository.claimSummary(id, 10)).toBeNull();
    const next = await thread();
    await vi.advanceTimersByTimeAsync(30 * 86400000 + 1);
    expect(await repository.claimSummary(next, 10)).toBeNull();
    await expect(repository.claimRequest({ owner_user_id: "owner", request_id: "lease_regression_request", company_id: null, user_message: "합성 질문" })).rejects.toThrow();
  });
});
