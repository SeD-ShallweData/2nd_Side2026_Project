import { describe, expect, it } from "vitest";

import { isRagHealthReady } from "@/server/ragHealth";

const ready = {
  ok: true,
  ready: true,
  database_exists: true,
  loaded: true,
  asset_integrity: true,
  query_compatible: true,
  local_files_only: true,
  offline: true,
  collection: "labor_law",
  embedding_model: "BAAI/bge-m3",
  model_revision: "5617a9f61b028005a4858fdac845db406aefb181",
  document_count: 583,
  expected_document_count: 583,
  embedding_dimension: 1024,
  expected_embedding_dimension: 1024,
  threshold: 0.42,
  strong_match_threshold: 0.30,
  probe_document_id: "kis_a43",
  probe_distance: 0.000001,
  probe_max_distance: 0.0001,
  asset_manifest_sha256: "f67ceeb88695eb9f681839bee857ea00e6b8f59853981180a13df547323b30d0",
};

describe("RAG health readiness contract", () => {
  it("accepts only the pinned offline model and verified 583-document query probe", () => {
    expect(isRagHealthReady(ready)).toBe(true);
  });

  it.each([
    ["legacy loaded-only payload", { ok: true, database_exists: true, loaded: true }],
    ["wrong count", { ...ready, document_count: 582 }],
    ["wrong dimension", { ...ready, embedding_dimension: 768 }],
    ["unprobed collection", { ...ready, query_compatible: false }],
    ["wrong semantic document", { ...ready, probe_document_id: "kis_a44" }],
    ["semantic distance drift", { ...ready, probe_distance: 0.01 }],
    ["disabled no-match policy", { ...ready, threshold: 1_000_000 }],
    ["network-enabled model", { ...ready, local_files_only: false }],
    ["floating model revision", { ...ready, model_revision: "main" }],
    ["missing integrity digest", { ...ready, asset_manifest_sha256: null }],
  ])("rejects %s", (_label, payload) => {
    expect(isRagHealthReady(payload)).toBe(false);
  });
});
