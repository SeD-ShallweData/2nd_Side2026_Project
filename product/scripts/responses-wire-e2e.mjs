import { readFile } from "node:fs/promises";

const baseUrl = (process.env.E2E_BASE_URL || "http://127.0.0.1:3101").replace(/\/$/, "");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function jsonRequest(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function chat(message, extra = {}) {
  return jsonRequest("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      chat_mode: "general",
      recent_messages: [],
      ...extra,
    }),
  });
}

function singleResult(payload, expectedTools, expectedStatus = "success") {
  assert(payload.execution_mode === "openai_responses", "Responses mode was not active");
  assert(Array.isArray(payload.results) && payload.results.length === 1, "expected one result");
  const result = payload.results[0];
  assert(result.provider === "openai", "unexpected provider");
  assert(result.status === expectedStatus, `unexpected result status: ${result.status}`);
  assert(
    JSON.stringify(result.trace.tool_names) === JSON.stringify(expectedTools),
    `unexpected tools: ${JSON.stringify(result.trace.tool_names)}`,
  );
  return result;
}

const overview = await jsonRequest("/api/inspector/overview?limit=1");
assert(overview.batch?.data_as_of?.startsWith("2026-06"), "latest DB batch is not 2026-06");
assert(Array.isArray(overview.top_queue) && overview.top_queue.length === 1, "empty queue");
const company = overview.top_queue[0];

const searchResponse = await jsonRequest(
  `/api/companies/search?q=${encodeURIComponent(company.company_name)}&limit=5`,
);
assert(Array.isArray(searchResponse.items) && searchResponse.items.length > 0, "known company search was empty");
const knownCandidate = searchResponse.items[0];
assert(typeof knownCandidate.company_id === "string", "known candidate id missing");
assert(typeof knownCandidate.company_name === "string", "known candidate name missing");

const directRisk = await jsonRequest(
  `/api/companies/${encodeURIComponent(company.company_id)}/risk`,
);
assert(directRisk.company_id === company.company_id, "direct risk identity mismatch");
assert(directRisk.data_as_of?.startsWith("2026-06"), "risk API selected a stale batch");

const riskChat = await chat(
  `E2E_TOOL=risk\nE2E_COMPANY_ID=${company.company_id}\n선택 사업장의 공개 위험 맥락을 확인해 주세요.`,
  { company_id: company.company_id },
);
const riskResult = singleResult(riskChat, ["get_company_risk"]);
assert(riskResult.sources.length > 0, "risk tool sources were not propagated");

const chainChat = await chat(
  `E2E_TOOL=search_chain\nE2E_QUERY=${company.company_name}\n사업장을 검색한 뒤 공개 위험 맥락을 확인해 주세요.`,
);
const chainResult = singleResult(chainChat, ["search_company"]);
assert(chainResult.answer.startsWith("SEARCH_RESULTS "), "search tool result content missing");
const searchSummary = JSON.parse(chainResult.answer.slice("SEARCH_RESULTS ".length));
assert(Array.isArray(searchSummary.candidates), "search candidates metadata missing");
assert(
  searchSummary.candidates.some(
    (candidate) =>
      candidate.company_id === knownCandidate.company_id &&
      candidate.company_name === knownCandidate.company_name,
  ),
  "known company was not included in the Responses search candidates",
);

const mismatchChat = await chat(
  "E2E_TOOL=risk\nE2E_COMPANY_ID=not-the-selected-company\n다른 사업장을 자동 조회하지 마세요.",
  { company_id: company.company_id },
);
const mismatchResult = singleResult(
  mismatchChat,
  ["get_company_risk"],
  "fallback",
);
assert(
  mismatchResult.error?.code === "COMPANY_CONTEXT_MISMATCH",
  "company selection mismatch was not blocked",
);

const ragChat = await chat(
  "E2E_TOOL=rag\nE2E_QUERY=임금 지급일과 체불 시 확인 절차\n공식 근거가 있으면 확인해 주세요.",
);
const ragResult = singleResult(ragChat, ["retrieve_labor_law"]);
assert(ragResult.trace.rag_status === "matched", "known RAG query did not match");
assert(ragResult.trace.retrieved_document_count > 0, "known RAG query returned no documents");
assert(Array.isArray(ragResult.sources) && ragResult.sources.length > 0, "RAG sources missing");
assert(
  ragResult.sources.some(
    (source) =>
      source.organization === "국가법령정보센터" &&
      typeof source.document_id === "string" &&
      /제\s*\d+조/.test(source.document_id),
  ),
  "RAG source citation metadata missing",
);
assert(/제\s*\d+조/.test(ragResult.answer), "RAG final answer did not preserve a citation");

const unknownChat = await chat(
  "E2E_TOOL=unknown\n허용되지 않은 도구 호출은 차단해 주세요.",
);
const unknownResult = singleResult(unknownChat, ["read_secret_file"], "fallback");
assert(unknownResult.trace.tool_call_count === 1, "unknown tool trace missing");
assert(unknownResult.error?.code === "UNSUPPORTED_TOOL", "unknown tool error missing");

const contractBytes = await readFile(
  new URL("../../prototypes/hb/dummy_contract.pdf", import.meta.url),
);
const contractForm = new FormData();
contractForm.append(
  "file",
  new Blob([contractBytes], { type: "application/pdf" }),
  "dummy_contract.pdf",
);
contractForm.append(
  "message",
  "E2E_TOOL=contract\n현재 업로드한 근로계약서를 검토해 주세요.",
);
const contractChat = await jsonRequest("/api/chat", {
  method: "POST",
  body: contractForm,
});
const contractResult = singleResult(contractChat, ["review_contract"]);
assert(contractResult.answer.startsWith("CONTRACT_RESULT "), "contract tool result content missing");
const contractSummary = JSON.parse(contractResult.answer.slice("CONTRACT_RESULT ".length));
assert(contractSummary.analysis_status === "completed", "contract analysis did not complete");
assert(contractSummary.file_name === "dummy_contract.pdf", "contract filename metadata mismatch");
assert(typeof contractSummary.review_id === "string" && contractSummary.review_id.length > 0, "contract review id missing");
assert(contractSummary.finding_count > 0, "contract findings were empty");
assert(typeof contractSummary.first_finding?.code === "string", "contract finding code missing");
assert(typeof contractSummary.first_finding?.label === "string", "contract finding label missing");
assert(
  ["detected", "missing", "review"].includes(contractSummary.first_finding?.status),
  "contract finding status missing",
);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    latest_batch: overview.batch.data_as_of,
    company_id: company.company_id,
    risk_data_as_of: directRisk.data_as_of,
    flows: {
      risk: riskResult.trace,
      search_chain: chainResult.trace,
      selection_mismatch: mismatchResult.trace,
      rag: ragResult.trace,
      unknown_tool: unknownResult.trace,
      contract: contractResult.trace,
    },
  }, null, 2)}\n`,
);
