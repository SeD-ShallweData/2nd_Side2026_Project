export const RAG_MODEL_ID = "BAAI/bge-m3";
export const RAG_MODEL_REVISION = "5617a9f61b028005a4858fdac845db406aefb181";
export const RAG_DOCUMENT_COUNT = 583;
export const RAG_EMBEDDING_DIMENSION = 1024;
export const RAG_PROBE_DOCUMENT_ID = "kis_a43";
export const RAG_PROBE_MAX_DISTANCE = 0.0001;
export const RAG_DISTANCE_THRESHOLD = 0.42;
export const RAG_STRONG_MATCH_DISTANCE = 0.30;
export const RAG_ASSET_MANIFEST_SHA256 = "f67ceeb88695eb9f681839bee857ea00e6b8f59853981180a13df547323b30d0";

export function isRagHealthReady(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const health = payload as Record<string, unknown>;
  return health.ok === true
    && health.ready === true
    && health.database_exists === true
    && health.loaded === true
    && health.asset_integrity === true
    && health.query_compatible === true
    && health.local_files_only === true
    && health.offline === true
    && health.collection === "labor_law"
    && health.embedding_model === RAG_MODEL_ID
    && health.model_revision === RAG_MODEL_REVISION
    && health.document_count === RAG_DOCUMENT_COUNT
    && health.expected_document_count === RAG_DOCUMENT_COUNT
    && health.embedding_dimension === RAG_EMBEDDING_DIMENSION
    && health.expected_embedding_dimension === RAG_EMBEDDING_DIMENSION
    && health.threshold === RAG_DISTANCE_THRESHOLD
    && health.strong_match_threshold === RAG_STRONG_MATCH_DISTANCE
    && health.probe_document_id === RAG_PROBE_DOCUMENT_ID
    && health.probe_max_distance === RAG_PROBE_MAX_DISTANCE
    && typeof health.probe_distance === "number"
    && Number.isFinite(health.probe_distance)
    && health.probe_distance <= RAG_PROBE_MAX_DISTANCE
    && health.asset_manifest_sha256 === RAG_ASSET_MANIFEST_SHA256;
}
