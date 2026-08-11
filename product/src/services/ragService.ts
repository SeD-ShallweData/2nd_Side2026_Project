import { HttpRagRetriever } from "@/adapters/real/HttpRagRetriever";
import type { RagRetrievalResult } from "@/domain/rag";

export async function retrieveLaborLawContext(query: string): Promise<RagRetrievalResult> {
  const baseUrl = process.env.RAG_API_URL?.trim();
  if (!baseUrl) return { query, status: "unavailable", threshold: null, documents: [] };
  const timeout = Number(process.env.RAG_TIMEOUT_MS ?? 20_000);
  return new HttpRagRetriever(baseUrl, Number.isFinite(timeout) ? timeout : 20_000).retrieve(query, 5);
}
