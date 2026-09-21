import { beforeEach, describe, expect, it, vi } from "vitest";
const fakes = vi.hoisted(() => ({ repository: { source: "database", assertAvailable: vi.fn(), deleteExpiredConversations: vi.fn(),
  findSummaryWork: vi.fn(), findConversation: vi.fn(), findSummary: vi.fn() }, summarize: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/services/userDataProviders", () => ({ getConversationRepository: () => fakes.repository }));
vi.mock("@/services/conversationSummaryService", () => ({ maybeUpdateConversationSummary: fakes.summarize }));
import { runConversationMaintenance } from "@/services/conversationMaintenanceService";
beforeEach(() => {
  vi.resetAllMocks(); fakes.repository.source = "database";
  fakes.repository.deleteExpiredConversations.mockResolvedValue(2);
  fakes.repository.findSummaryWork.mockResolvedValue(["one"]);
  fakes.repository.findConversation.mockResolvedValue({});
  fakes.repository.findSummary.mockResolvedValue({ status: "pending" });
});
describe("bounded conversation maintenance", () => {
  it("rejects mock execution instead of reporting false success", async () => {
    fakes.repository.source = "mock";
    await expect(runConversationMaintenance()).rejects.toThrow("REQUIRES_REAL_DATABASE");
    expect(fakes.repository.deleteExpiredConversations).not.toHaveBeenCalled();
  });
  it("reports only bounded counts and version, not private IDs/content", async () => {
    fakes.summarize.mockResolvedValue(true);
    expect(await runConversationMaintenance()).toEqual({ version: "conversation-maintenance-v1", deleted: 2, candidates: 1, summarized: 1, failed: 0 });
    expect(fakes.repository.findSummaryWork).toHaveBeenCalledWith(25);
  });
  it("counts stored build failures even when summary service returns false", async () => {
    fakes.summarize.mockResolvedValue(false); fakes.repository.findSummary.mockResolvedValue({ status: "failed" });
    expect((await runConversationMaintenance()).failed).toBe(1);
  });
  it("does not treat a concurrent lease winner or deleted thread as failure", async () => {
    fakes.summarize.mockResolvedValue(false);
    expect((await runConversationMaintenance()).failed).toBe(0);
    fakes.repository.findConversation.mockResolvedValue(null); fakes.repository.findSummary.mockResolvedValue(null);
    expect((await runConversationMaintenance()).failed).toBe(0);
  });
});
