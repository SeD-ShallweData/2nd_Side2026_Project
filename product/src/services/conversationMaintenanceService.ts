import "server-only";
import { getConversationRepository } from "@/services/userDataProviders";
import { maybeUpdateConversationSummary } from "@/services/conversationSummaryService";

/** Bounded, restartable pass; leases fence summary writers and SKIP LOCKED fences purge batches. */
export async function runConversationMaintenance() {
  const repository = getConversationRepository();
  if (repository.source !== "database") throw new Error("CONVERSATION_WORKER_REQUIRES_REAL_DATABASE");
  repository.assertAvailable();
  const deleted = await repository.deleteExpiredConversations(new Date());
  const candidates = await repository.findSummaryWork(25);
  let summarized = 0;
  let failed = 0;
  for (const id of candidates) {
    try {
      const detail = await repository.findConversation(id);
      if (detail && await maybeUpdateConversationSummary(detail)) summarized += 1;
      else if ((await repository.findSummary(id))?.status === "failed") failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { version: "conversation-maintenance-v1", deleted, candidates: candidates.length, summarized, failed };
}
