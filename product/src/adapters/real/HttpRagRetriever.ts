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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      category: "labor_law",
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

  async retrieve(
    query: string,
    limit = 5,
    signal?: AbortSignal,
  ): Promise<RagRetrievalResult> {
    try {
      const response = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}/api/retrieve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
          : AbortSignal.timeout(this.timeoutMs),
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`RAG HTTP ${response.status}`);
      const rawPayload: unknown = await response.json();
      if (!isRecord(rawPayload)) throw new Error("RAG payload must be an object");
      const payload = rawPayload as UpstreamResponse;
      if (payload.status !== "matched" && payload.status !== "no_match") {
        throw new Error("RAG payload has an unsupported status");
      }
      if (!Array.isArray(payload.items)) throw new Error("RAG payload items must be an array");
      if (
        payload.threshold !== undefined &&
        payload.threshold !== null &&
        (typeof payload.threshold !== "number" || !Number.isFinite(payload.threshold))
      ) {
        throw new Error("RAG payload threshold must be a finite number or null");
      }

      const parsedDocuments = payload.items.map(parseDocument);
      if (parsedDocuments.some((item) => item === null)) {
        throw new Error("RAG payload contains an invalid document");
      }
      const documents = parsedDocuments as RagDocument[];
      if (
        (payload.status === "matched" && documents.length === 0) ||
        (payload.status === "no_match" && documents.length > 0)
      ) {
        throw new Error("RAG payload status and documents disagree");
      }

      return {
        query: optionalString(payload.query) ?? query,
        retrieval_query: optionalString(payload.retrieval_query),
        status: payload.status,
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
