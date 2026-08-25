import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ database: true }));

vi.mock("server-only", () => ({}));
vi.mock("@/server/postgres", () => ({
  isDatabaseReady: async () => state.database,
}));

import { GET, resetReadinessCacheForTests } from "@/app/api/health/ready/route";

const readyRagHealth = {
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

const readyContractHealth = {
  asset_integrity: true,
  asset_contract: "donworry.contract.assets.v1",
  asset_manifest_sha256: "1df5825a76b24c961f8a8f49f72c07d0e1f70a06c6f3e0912c265f91e7af4a1a",
  asset_files_verified: 26,
  asset_persona_count: 4,
  asset_system_blocks: 7,
  asset_few_shot_examples: 9,
  asset_knowledge_files: 13,
  contract: { enabled: true },
  providers: { upstage: { key: true } },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  state.database = true;
  resetReadinessCacheForTests();
});

describe("GET /api/health/ready", () => {
  it("DB·RAG·계약 서비스가 준비된 경우에만 200을 반환한다", async () => {
    vi.stubEnv("RAG_API_URL", "http://rag.internal");
    vi.stubEnv("RAG_INTERNAL_TOKEN", "rag-ready-token");
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "http://contract.internal");
    vi.stubEnv("CONTRACT_INTERNAL_TOKEN", "contract-ready-token");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const payload = url.startsWith("http://rag.internal")
        ? readyRagHealth
        : readyContractHealth;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal(
      "fetch",
      fetchMock,
    );

    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ready" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://rag.internal/api/health",
      expect.objectContaining({
        headers: { Authorization: "Bearer rag-ready-token" },
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://contract.internal/api/health",
      expect.objectContaining({
        headers: { Authorization: "Bearer contract-ready-token" },
      }),
    );
  });

  it("하나라도 준비되지 않으면 503을 반환하고 외부 LLM은 호출하지 않는다", async () => {
    state.database = false;
    vi.stubEnv("RAG_API_URL", "");
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      status: "not_ready",
      checks: { database: false, rag: false, contract_analysis: false },
    });
  });

  it("10초 cache와 in-flight 병합으로 공개 probe fan-out을 제한한다", async () => {
    vi.stubEnv("RAG_API_URL", "http://rag.internal");
    vi.stubEnv("RAG_INTERNAL_TOKEN", "rag-cache-token");
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "http://contract.internal");
    vi.stubEnv("CONTRACT_INTERNAL_TOKEN", "contract-cache-token");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const isRag = String(input).startsWith("http://rag.internal");
      return new Response(JSON.stringify(isRag
        ? readyRagHealth
        : readyContractHealth), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const responses = await Promise.all([GET(), GET(), GET()]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("legacy loaded 응답이나 583이 아닌 컬렉션을 ready로 인정하지 않는다", async () => {
    vi.stubEnv("RAG_API_URL", "http://rag.internal");
    vi.stubEnv("RAG_INTERNAL_TOKEN", "rag-drift-token");
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "http://contract.internal");
    vi.stubEnv("CONTRACT_INTERNAL_TOKEN", "contract-drift-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const isRag = String(input).startsWith("http://rag.internal");
        return new Response(JSON.stringify(isRag
          ? { ...readyRagHealth, document_count: 582 }
          : readyContractHealth), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "not_ready",
      checks: { rag: false },
    });
  });

  it("계약 자산 manifest drift를 ready로 인정하지 않는다", async () => {
    vi.stubEnv("RAG_API_URL", "http://rag.internal");
    vi.stubEnv("RAG_INTERNAL_TOKEN", "rag-manifest-token");
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "http://contract.internal");
    vi.stubEnv("CONTRACT_INTERNAL_TOKEN", "contract-manifest-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const isRag = String(input).startsWith("http://rag.internal");
        return new Response(JSON.stringify(isRag
          ? readyRagHealth
          : { ...readyContractHealth, asset_manifest_sha256: "0".repeat(64) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      checks: { contract_analysis: false },
    });
  });

  it("내부 token이 없으면 health fetch 없이 not_ready가 된다", async () => {
    vi.stubEnv("RAG_API_URL", "http://rag.internal");
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "http://contract.internal");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      checks: { rag: false, contract_analysis: false },
    });
  });
});
