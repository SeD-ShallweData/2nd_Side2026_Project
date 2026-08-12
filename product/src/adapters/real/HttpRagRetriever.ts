import type { RagDocument, RagRetrievalResult, RagRetriever } from "@/domain/rag";

interface UpstreamItem {
  content?: unknown;
  citation?: unknown;
  distance?: unknown;
  source?: {
    name?: unknown;
    organization?: unknown;
    document_id?: unknown;
    url?: unknown;
  };
}

interface UpstreamResponse {
  status?: unknown;
  query?: unknown;
  retrieval_query?: unknown;
  reason?: unknown;
  topic?: unknown;
  threshold?: unknown;
  top1_distance?: unknown;
  items?: unknown;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseDocument(value: unknown): RagDocument | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as UpstreamItem;
  const content = optionalString(item.content);
  const citation = optionalString(item.citation);
  const name = optionalString(item.source?.name) ?? citation;
  if (!content || !citation || !name) return null;
  return {
    content: content.slice(0, 4_000),
    citation,
    distance: typeof item.distance === "number" && Number.isFinite(item.distance) ? item.distance : null,
    source: {
      name,
      citation,
      organization: optionalString(item.source?.organization),
      document_id: optionalString(item.source?.document_id),
      url: optionalString(item.source?.url),
    },
  };
}

export class HttpRagRetriever implements RagRetriever {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 20_000,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async retrieve(query: string, limit = 5): Promise<RagRetrievalResult> {
    try {
      const response = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}/api/retrieve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(this.timeoutMs),
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`RAG HTTP ${response.status}`);
      const payload = (await response.json()) as UpstreamResponse;
      const documents = Array.isArray(payload.items)
        ? payload.items.map(parseDocument).filter((item): item is RagDocument => item !== null)
        : [];
      return {
        query: optionalString(payload.query) ?? query,
        retrieval_query: optionalString(payload.retrieval_query),
        status: payload.status === "matched" && documents.length > 0 ? "matched" : "no_match",
        reason: optionalString(payload.reason) ?? null,
        topic: optionalString(payload.topic) ?? null,
        threshold: typeof payload.threshold === "number" ? payload.threshold : null,
        top1_distance:
          typeof payload.top1_distance === "number" && Number.isFinite(payload.top1_distance)
            ? payload.top1_distance
            : null,
        documents,
      };
    } catch {
      return {
        query,
        status: "unavailable",
        reason: "service_unavailable",
        topic: null,
        threshold: null,
        top1_distance: null,
        documents: [],
      };
    }
  }
}
