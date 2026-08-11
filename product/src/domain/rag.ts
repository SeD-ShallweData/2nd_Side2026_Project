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
  status: RagRetrievalStatus;
  threshold: number | null;
  documents: RagDocument[];
}

export interface RagRetriever {
  retrieve(query: string, limit?: number): Promise<RagRetrievalResult>;
}
