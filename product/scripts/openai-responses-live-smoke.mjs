const LIVE_FLAG = "RUN_OPENAI_LIVE_E2E";

if (process.env[LIVE_FLAG] !== "1") {
  process.stdout.write(
    `[SKIP] 실제 OpenAI Responses E2E는 비활성화되어 있습니다. ${LIVE_FLAG}=1을 명시할 때만 실행합니다.\n`,
  );
  process.exit(0);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return 300_000;
  return Math.min(Math.max(parsed, 15_000), 600_000);
}

function requiredBaseUrl() {
  const raw = process.env.E2E_BASE_URL?.trim();
  assert(raw, "E2E_BASE_URL을 실행 중인 product 서버 주소로 설정해 주세요.");

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("E2E_BASE_URL은 유효한 절대 URL이어야 합니다.");
  }
  assert(
    url.protocol === "http:" || url.protocol === "https:",
    "E2E_BASE_URL은 http 또는 https URL이어야 합니다.",
  );
  assert(
    !url.username && !url.password,
    "인증정보를 E2E_BASE_URL에 포함하지 말고 E2E_BASIC_AUTH_*를 사용해 주세요.",
  );
  assert(!url.search && !url.hash, "E2E_BASE_URL에는 query 또는 fragment를 넣지 마세요.");
  return url.toString().replace(/\/$/, "");
}

function basicAuthorization() {
  const username = process.env.E2E_BASIC_AUTH_USER;
  const password = process.env.E2E_BASIC_AUTH_PASSWORD;
  assert(
    Boolean(username) === Boolean(password),
    "Basic 인증을 사용하려면 E2E_BASIC_AUTH_USER와 E2E_BASIC_AUTH_PASSWORD를 함께 설정해 주세요.",
  );
  return username && password
    ? `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`
    : null;
}

let baseUrl = "";
let timeoutMs = 300_000;
let authorization = null;

function record(value, label) {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} 응답은 JSON 객체여야 합니다.`,
  );
  return value;
}

async function jsonRequest(path, init = {}) {
  const headers = new Headers(init.headers);
  if (authorization) headers.set("authorization", authorization);

  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError"
      ? "요청 시간이 초과됐습니다."
      : "서버에 연결하지 못했습니다.";
    throw new Error(`${path}: ${reason}`);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status}`);
  }
  return record(payload, path);
}

async function run() {
  baseUrl = requiredBaseUrl();
  timeoutMs = boundedTimeout(process.env.E2E_LIVE_TIMEOUT_MS);
  authorization = basicAuthorization();

  const status = await jsonRequest("/api/system/status");
  const integrations = record(status.integrations, "system status integrations");
  assert(
    status.chat_execution_mode === "openai_responses",
    "서버의 chat_execution_mode가 openai_responses가 아닙니다.",
  );
  assert(
    integrations.openai_responses === "ready",
    "OpenAI Responses 구성이 ready가 아닙니다.",
  );
  assert(
    integrations.active_chat_llm === "ready",
    "현재 선택된 상담 LLM이 ready가 아닙니다.",
  );

  const overview = await jsonRequest("/api/inspector/overview?limit=1");
  assert(
    Array.isArray(overview.top_queue) && overview.top_queue.length > 0,
    "감독관 overview에서 smoke test용 사업장을 선택하지 못했습니다.",
  );
  const company = record(overview.top_queue[0], "overview top_queue item");
  const companyId = typeof company.company_id === "string"
    ? company.company_id.trim()
    : "";
  assert(companyId, "overview 사업장에 company_id가 없습니다.");

  const chat = await jsonRequest("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message:
        "선택한 사업장의 최신 공개 위험 정보를 확인해 주세요. 반드시 get_company_risk 도구를 호출하고 그 실행 결과만 근거로 간단히 설명해 주세요.",
      company_id: companyId,
      chat_mode: "safety",
      recent_messages: [],
    }),
  });

  assert(chat.execution_mode === "openai_responses", "chat이 Responses mode로 실행되지 않았습니다.");
  assert(Array.isArray(chat.results) && chat.results.length === 1, "OpenAI 결과는 정확히 하나여야 합니다.");
  const result = record(chat.results[0], "chat result");
  const trace = record(result.trace, "chat result trace");
  assert(result.provider === "openai", "chat provider가 openai가 아닙니다.");
  assert(result.status === "success", `chat 결과가 success가 아닙니다: ${String(result.status)}`);
  assert(
    Array.isArray(trace.tool_names) && trace.tool_names.includes("get_company_risk"),
    "get_company_risk 도구 호출 trace가 없습니다.",
  );
  assert(
    Number.isInteger(trace.tool_call_count) && trace.tool_call_count >= 1,
    "도구 호출 횟수 trace가 올바르지 않습니다.",
  );
  assert(trace.company_context_attached === true, "사업장 도구 컨텍스트가 연결되지 않았습니다.");
  assert(Array.isArray(result.sources) && result.sources.length > 0, "사업장 위험 정보 출처가 없습니다.");
  assert(
    result.sources.every(
      (source) =>
        typeof source === "object" &&
        source !== null &&
        typeof source.name === "string" &&
        source.name.trim().length > 0,
    ),
    "출처 항목의 name 계약이 올바르지 않습니다.",
  );

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      company_id: companyId,
      execution_mode: chat.execution_mode,
      provider: result.provider,
      model: result.model,
      tool_names: trace.tool_names,
      tool_call_count: trace.tool_call_count,
      source_count: result.sources.length,
    }, null, 2)}\n`,
  );
}

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : "알 수 없는 smoke test 오류";
  process.stderr.write(`[FAIL] ${message}\n`);
  process.exitCode = 1;
}
