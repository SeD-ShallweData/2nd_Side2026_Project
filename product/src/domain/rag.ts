import type { SourceReference } from "@/domain/risk";

export type RagRetrievalStatus = "matched" | "no_match" | "unavailable";

export interface RagDocument {
  content: string;
  citation: string;
  distance: number | null;
  source: SourceReference;
}

export interface RagRetrievalResult {
  query: string;
  retrieval_query?: string;
  status: RagRetrievalStatus;
  reason?: string | null;
  topic?: string | null;
  threshold: number | null;
  top1_distance?: number | null;
  documents: RagDocument[];
}

export interface RagRetriever {
  retrieve(query: string, limit?: number): Promise<RagRetrievalResult>;
}
