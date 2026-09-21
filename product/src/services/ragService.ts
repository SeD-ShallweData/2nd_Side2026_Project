import { HttpRagRetriever } from "@/adapters/real/HttpRagRetriever";
import type { RagRetrievalResult } from "@/domain/rag";
import { reviewedLaborRetrieval } from "@/services/reviewedLaborGuidance";

export async function retrieveLaborLawContext(
  query: string,
  signal?: AbortSignal,
): Promise<RagRetrievalResult> {
  // Scope, exceptions and procedure travel together; other topics keep vector retrieval.
  const reviewed = reviewedLaborRetrieval(query);
  if (reviewed) return reviewed;
  const baseUrl = process.env.RAG_API_URL?.trim();
  if (!baseUrl) return { query, status: "unavailable", threshold: null, documents: [] };
  const timeout = Number(process.env.RAG_TIMEOUT_MS ?? 20_000);
  return new HttpRagRetriever(
    baseUrl,
    process.env.RAG_INTERNAL_TOKEN?.trim() ?? "",
    Number.isFinite(timeout) ? timeout : 20_000,
  ).retrieve(query, 5, signal);
}
