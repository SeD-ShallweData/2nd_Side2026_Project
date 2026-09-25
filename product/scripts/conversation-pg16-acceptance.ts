/** Opt-in real DB test, launched ONLY by db/scripts/run-conversation-pg16-acceptance.mjs. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { Pool } from "pg";
import { RealConversationRepository } from "../src/adapters/real/RealConversationRepository";
import { registerUser, loginUser, getSessionResponse } from "../src/services/authService";
import { getUserConversation, hydrateConversationRequest, completeClaimedConversationRequest,
  rememberGeneratedResponse, cachedGeneratedResponse } from "../src/services/conversationService";
import { maybeUpdateConversationSummary } from "../src/services/conversationSummaryService";
import { recallAnswer } from "../src/services/conversationRecallService";
import { closeWritePools } from "../src/server/postgresWrite";
import type { SessionUserDto } from "../src/app/api/auth/authApiContract";
import type { ChatComparisonResponse } from "../src/domain/chatComparison";
import type { CompleteConversationRequestInput } from "../src/domain/conversation";

if (process.env.MW_ACCEPTANCE_CREATED !== "followup06-new-pg16") throw new Error("ISOLATED_HARNESS_REQUIRED");
for (const key of ["MW_ACCEPTANCE_OWNER_URL", "AUTH_DATABASE_URL", "CONVERSATION_DATABASE_URL"]) {
  const target = new URL(process.env[key]!);
  assert(target.hostname === "127.0.0.1" && target.port === "55436" && target.pathname === "/mw_followup06", "WRONG_TARGET");
}
const owner = new Pool({ connectionString: process.env.MW_ACCEPTANCE_OWNER_URL, max: 2 });
const conversation = new Pool({ connectionString: process.env.CONVERSATION_DATABASE_URL, max: 2 });
const auth = new Pool({ connectionString: process.env.AUTH_DATABASE_URL, max: 1 });
const repository = new RealConversationRepository();
let passed = 0;
let phase = "identity";
let user: SessionUserDto;
let other: SessionUserDto;
let app: ReturnType<typeof spawn> | undefined;
const password = randomBytes(12).toString("hex");
const email = `acceptance-${randomUUID()}@example.invalid`;
async function check(name: string, fn: () => Promise<void>) {
  phase = name; await fn(); passed++; console.log(`ACCEPTANCE ${name}=PASS`);
}
function response(): ChatComparisonResponse {
  return {
    comparison_id: randomUUID(), conversation_id: "synthetic", execution_mode: "single_api",
    started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    fair_comparison: { concurrent: false, same_context: true, same_temperature: true, same_max_tokens: true, same_retrieval: true },
    results: [{ provider: "upstage", provider_label: "Synthetic DB fixture", model: "no-provider-call", status: "success",
      answer: "합성 저장 검증 답변", answer_type: "general_guidance", sources: [{ name: "합성 출처" }],
      suggested_actions: [], limitations: [], guardrail_status: "passed",
      metrics: { latency_ms: 0, time_to_first_token_ms: null, streaming: false, finish_reason: "stop", answer_chars: 12,
        usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_tokens: null, reasoning_tokens: null } },
      trace: { prompt_policy_version: "synthetic", query_transform: "none", context_mode: "general", company_context_attached: false,
        recent_message_count: 0, guardrail_action: "passed", guardrail_hits: [], upstream_request_id: null, rag_status: "unavailable",
        rag_reason: null, rag_topic: null, retrieved_document_count: 0 } }],
  };
}
async function claim(id?: string, requestId = randomUUID(), who = user) {
  const result = await repository.claimRequest({ owner_user_id: who.user_id, conversation_id: id, request_id: requestId, company_id: null, user_message: "합성 질문" });
  if (result.lease_token) requestLeases.set(`${who.user_id}:${requestId}`, result.lease_token);
  return result;
}
const requestLeases = new Map<string, string>();
function completed(id: string, key: string, text = "합성 질문", who = user): CompleteConversationRequestInput {
  return { owner_user_id: who.user_id, conversation_id: id, idempotency_key: key, company_id: null, user_message: text,
    assistant_message: "합성 저장 검증 답변", answer_type: "general_guidance", guardrail_status: "passed", sources: [{ name: "합성 출처" }],
    response: response(), lease_token: requestLeases.get(`${who.user_id}:${key}`)! };
}
async function thread(turns = 5, who = user) {
  let id: string | undefined;
  const statements = ["급여일은 매월 10일이고 이번 달 월급을 받지 못했다.", "회사는 문자로 다음 주에 지급하겠다고 했다.",
    "정정한다. 급여일은 10일이 아니라 15일이고 아직 미지급이다."];
  for (let i = 0; i < turns; i++) {
    const key = randomUUID(); const claimed = await claim(id, key, who); id = claimed.conversation_id;
    await repository.completeRequest(completed(id, key, statements[i] ?? "기록을 보관하고 있다.", who));
  }
  return id!;
}
async function worker() {
  const workerEnv = { ...process.env };
  delete workerEnv.MW_ACCEPTANCE_OWNER_URL; delete workerEnv.AUTH_DATABASE_URL;
  workerEnv.DATABASE_ENV_FILE = process.platform === "win32" ? "NUL" : "/dev/null";
  const child = spawn(process.execPath, [".runtime/conversation-worker.mjs"], { env: workerEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = ""; child.stdout!.on("data", (value) => { stdout += value; }); child.stderr!.resume();
  const code = await new Promise((done, reject) => { child.on("error", reject); child.on("close", done); });
  assert.equal(code, 0, "WORKER_EXIT");
  return JSON.parse(stdout.trim()) as { deleted: number; summarized: number; failed: number };
}
async function killedSummaryWorker(id: string) {
  const child = spawn(process.execPath, [".runtime/conversation-pg16-acceptance.mjs", "--hold-summary", id], {
    env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  child.stderr!.resume();
  try {
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => reject(new Error("CLAIM_CHILD_TIMEOUT")), 15000);
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("CLAIM_CHILD_EXIT")); });
      child.stdout!.on("data", (chunk) => { if (String(chunk).includes("SUMMARY_CLAIM_HELD")) { clearTimeout(timeout); done(); } });
    });
    await worker(); // A live lease must not be stolen by the maintenance process.
    assert.equal((await repository.findSummary(id))!.status, "pending");
  } finally {
    const stopped = new Promise((done) => child.once("close", done));
    child.kill("SIGKILL"); await stopped;
  }
}
async function noChildren(id: string, turnIds: string[]) {
  for (const table of ["conversation_threads", "conversation_turns", "conversation_company_events", "conversation_summaries", "conversation_requests"]) {
    const field = table === "conversation_threads" ? "id" : "conversation_id";
    assert.equal(Number((await owner.query(`SELECT count(*) FROM ${table} WHERE ${field}=$1`, [id])).rows[0].count), 0, table);
  }
  for (const table of ["conversation_messages", "conversation_sources"]) {
    assert.equal(Number((await owner.query(`SELECT count(*) FROM ${table} WHERE turn_id=ANY($1::uuid[])`, [turnIds])).rows[0].count), 0, table);
  }
}
async function stopApp() {
  if (!app || app.exitCode !== null || app.signalCode !== null || !app.pid) return;
  const owned = app;
  const stopped = new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => reject(new Error("APP_STOP_TIMEOUT")), 15000);
    owned.once("close", () => { clearTimeout(timeout); done(); });
  });
  if (process.platform === "win32") {
    // taskkill can report a child already gone even though the owned process exits.
    // The actual process close, not taskkill's aggregate exit code, is authoritative.
    const killer = spawn("taskkill", ["/PID", String(owned.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    await new Promise((done, reject) => { killer.once("close", done); killer.once("error", reject); });
  } else owned.kill("SIGTERM");
  await stopped; app = undefined;
}
const base = "http://127.0.0.1:3116";
async function startApp() {
  await new Promise<void>((done, reject) => { const probe = createServer(); probe.once("error", reject); probe.listen(3116, "127.0.0.1", () => probe.close(() => done())); });
  const appEnv = { ...process.env }; delete appEnv.MW_ACCEPTANCE_OWNER_URL;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3116"], {
    env: { ...appEnv, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", DATABASE_ENV_FILE: process.platform === "win32" ? "NUL" : "/dev/null",
      SHARED_API_KEY_FILE: process.platform === "win32" ? "NUL" : "/dev/null", UPSTAGE_API_KEY: "", Upstage_API_KEY: "", SKT_API_KEY: "", OPENAI_API_KEY: "",
      UPSTAGE_API_URL: "http://127.0.0.1:1/no-provider", SKT_API_URL: "http://127.0.0.1:1/no-provider", RAG_API_URL: "http://127.0.0.1:1/no-rag",
      CHAT_EXECUTION_MODE: "dual_api" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  app.stdout!.resume(); app.stderr!.resume();
  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null) throw new Error("APP_EXITED");
    try { if ((await fetch(`${base}/api/health/live`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error("APP_NOT_READY");
}
async function http(path: string, cookie = "", body?: object) {
  const res = await fetch(base + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  assert.equal(res.status, 200, `HTTP_STATUS_${path}`);
  return { data: await res.json(), cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
if (process.argv[2] === "--hold-summary") {
  assert(await repository.claimSummary(process.argv[3], 10));
  console.log("SUMMARY_CLAIM_HELD");
  setInterval(() => {}, 1000);
  await new Promise(() => {}); // The parent deliberately kills this owned synthetic worker.
}
try {
  await check("real-auth-and-least-privileges", async () => {
    const result = await registerUser({ email, password, name: "격리 합성 사용자" }); user = result.response.user;
    const next = await loginUser({ email, password });
    assert.equal((await getSessionResponse(result.session.token)).authenticated, false);
    assert.equal((await getSessionResponse(next.session.token)).authenticated, true);
    other = (await registerUser({ email: `other-${randomUUID()}@example.invalid`, password, name: "별도 합성 사용자" })).response.user;
    for (const table of ["users", "sessions", "firms", "scored_active", "user_favorite_firms"]) {
      await assert.rejects(conversation.query(`SELECT * FROM ${table} LIMIT 0`), { code: "42501" });
    }
    await assert.rejects(conversation.query("CREATE TABLE should_not_exist(id int)"), { code: "42501" });
    const privileges = (await conversation.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
    assert(Object.values(privileges).every((value) => value === false));
    await owner.query("INSERT INTO firms(firm_id,name,biz_no) VALUES ('acceptance-A','합성 A','synthetic-A'),('acceptance-B','합성 B','synthetic-B')");
    await auth.query("INSERT INTO user_favorite_firms(user_id,firm_id) VALUES($1,'acceptance-A')", [user.user_id]);
    assert.equal((await auth.query("SELECT * FROM user_favorite_firms")).rowCount, 1);
    await assert.rejects(auth.query("UPDATE user_favorite_firms SET created_at=now()"), { code: "42501" });
    await auth.query("DELETE FROM user_favorite_firms WHERE user_id=$1", [user.user_id]);
    await assert.rejects(auth.query("SELECT * FROM conversation_messages LIMIT 0"), { code: "42501" });
  });
  await check("concurrent-first-request-replay-owner-room-isolation", async () => {
    const key = randomUUID(); const claims = await Promise.all([claim(undefined, key), claim(undefined, key)]);
    assert.equal(claims[0].conversation_id, claims[1].conversation_id);
    assert.equal(claims.filter((value) => !value.reused).length, 1);
    const id = claims[0].conversation_id;
    const results = await Promise.all([repository.completeRequest(completed(id, key)), repository.completeRequest(completed(id, key))]);
    assert.equal(results.filter((value) => value.reused).length, 1);
    assert.equal((await repository.findConversation(id))!.turns.length, 1);
    assert.equal((await claim(undefined, key)).status, "completed");
    assert.deepEqual((await claim(undefined, key)).response, results[0].response);
    await assert.rejects(getUserConversation(id, other), { code: "CONVERSATION_NOT_FOUND" });
    await assert.rejects(claim(id, randomUUID(), other), { code: "CONVERSATION_NOT_FOUND" });
    const second = await thread(1);
    await assert.rejects(claim(second, key), { code: "CONVERSATION_NOT_FOUND" });
    assert.equal((await repository.listConversations(other.user_id, 50)).length, 0);
    const request = randomUUID(); await claim(second, request);
    await repository.failRequest(user.user_id, request, requestLeases.get(`${user.user_id}:${request}`)!, "failed", "SYNTHETIC_FAILURE");
    assert.equal((await claim(second, request)).status, "failed");
    await assert.rejects(repository.completeRequest(completed(second, request)), { code: "CONVERSATION_REQUEST_NOT_PENDING" });
  });
  await check("expired-request-lease-reclaim-and-stale-writer-fence", async () => {
    const key = randomUUID();
    const first = await claim(undefined, key);
    const staleToken = first.lease_token!;
    await owner.query(
      "UPDATE conversation_requests SET lease_expires_at = now() - interval '1 second' WHERE owner_user_id = $1::uuid AND request_id = $2",
      [user.user_id, key],
    );
    const reclaimed = await claim(first.conversation_id, key);
    assert.equal(reclaimed.reused, false);
    assert.notEqual(reclaimed.lease_token, staleToken);
    await assert.rejects(
      repository.completeRequest({ ...completed(first.conversation_id, key), lease_token: staleToken }),
      { code: "CONVERSATION_REQUEST_NOT_PENDING" },
    );
    await repository.completeRequest(completed(first.conversation_id, key));
  });
  await check("atomic-save-failure-and-cached-save-only-retry", async () => {
    const key = randomUUID(); const id = (await claim(undefined, key)).conversation_id;
    const request = { conversation_id: id, request_id: key, message: "합성 질문", chat_mode: "wage" as const, recent_messages: [],
      conversation_request_lease_token: requestLeases.get(`${user.user_id}:${key}`)! };
    const generated = response(); rememberGeneratedResponse(user, key, generated);
    await owner.query("REVOKE INSERT ON conversation_sources FROM wg_conversation");
    try { await assert.rejects(completeClaimedConversationRequest(request, generated, user)); }
    finally { await owner.query("GRANT INSERT ON conversation_sources TO wg_conversation"); }
    assert.equal((await repository.findConversation(id))!.turns.length, 0);
    assert.equal((await claim(id, key)).status, "pending");
    const cached = cachedGeneratedResponse(user, key); assert(cached);
    await completeClaimedConversationRequest(request, cached, user);
    assert.equal((await repository.findConversation(id))!.turns.length, 1);
    assert.equal(cachedGeneratedResponse(user, key), null);
  });
  await check("summary-lease-heartbeat-reclaim-and-stale-writer-fence", async () => {
    const id = await thread();
    const first = await repository.claimSummary(id, 10); assert(first);
    assert.equal(await repository.claimSummary(id, 10), null);
    assert.equal(await repository.renewSummary(id, first), true);
    await owner.query("UPDATE conversation_summaries SET lease_expires_at=now()-interval '1 second' WHERE conversation_id=$1", [id]);
    const second = await repository.claimSummary(id, 10); assert(second && first !== second);
    assert.equal(await repository.renewSummary(id, first), false);
    const summary = (await repository.findSummary(id))!.summary;
    assert.equal(await repository.completeSummary({ conversation_id: id, through_sequence: 10, summary, summary_version: "stale", lease_token: first }), false);
    await repository.failSummary(id, 10, "OLD_FAILURE", first);
    assert.equal((await repository.findSummary(id))!.status, "pending");
    await repository.failSummary(id, 10, "SYNTHETIC_RETRY", second);
    await owner.query("UPDATE conversation_summaries SET updated_at=now()-interval '2 minutes' WHERE conversation_id=$1", [id]);
    await worker();
    assert.equal((await repository.findSummary(id))!.status, "ready");
    const hydrated = await hydrateConversationRequest({ conversation_id: id, message: "정정한 급여일과 회사 지급 약속을 다시 말해 달라.", chat_mode: "wage", recent_messages: [] }, user);
    assert.match(recallAnswer(hydrated)!.answer, /15일.*다음 주/);
  });
  await check("worker-crash-legacy-pending-recovery-and-concurrent-restarts", async () => {
    const crashed = await thread(); await killedSummaryWorker(crashed);
    await owner.query("UPDATE conversation_summaries SET lease_expires_at=now()-interval '1 second' WHERE conversation_id=$1", [crashed]);
    const id = await thread(); const token = await repository.claimSummary(id, 10); assert(token);
    // Also cover a pre-0019 pending row, which has no token/expiry.
    await owner.query("UPDATE conversation_summaries SET lease_token=NULL,lease_expires_at=NULL,updated_at=now()-interval '3 minutes' WHERE conversation_id=$1", [id]);
    const results = await Promise.all([worker(), worker()]);
    assert.equal(results.reduce((sum, result) => sum + result.failed, 0), 0);
    const state = (await repository.findSummary(id))!;
    assert.equal(state.status, "ready"); assert.equal(state.summarized_through_sequence, 10);
    assert.equal((await repository.findSummary(crashed))!.status, "ready");
    const after = await worker(); assert.equal(after.summarized, 0);
    assert.equal((await repository.findSummary(id))!.retry_count, state.retry_count);
  });
  await check("delete-expiry-user-cascade-and-late-completion", async () => {
    for (const kind of ["delete", "expiry", "user-delete"] as const) {
      const actor = kind === "user-delete" ? other : user;
      const id = await thread(5, actor); const detail = (await repository.findConversation(id))!;
      const token = await repository.claimSummary(id, 10); assert(token);
      const pendingKey = randomUUID(); await claim(id, pendingKey, actor);
      await repository.updateConversation({ conversation_id: id, owner_user_id: actor.user_id, active_company_id: "acceptance-A" });
      if (kind === "delete") await repository.deleteConversation(id, actor.user_id);
      if (kind === "expiry") {
        await owner.query("UPDATE conversation_threads SET expires_at=now()-interval '1 second' WHERE id=$1", [id]);
        await assert.rejects(claim(id, pendingKey, actor), { code: "CONVERSATION_NOT_FOUND" });
        await assert.rejects(repository.completeRequest(completed(id, pendingKey, "합성", actor)), { code: "CONVERSATION_NOT_FOUND" });
        await Promise.all([worker(), worker()]);
      }
      if (kind === "user-delete") await auth.query("DELETE FROM users WHERE id=$1", [actor.user_id]);
      await noChildren(id, detail.turns.map((turn) => turn.turn_id));
      await assert.rejects(repository.completeRequest(completed(id, pendingKey, "합성", actor)), { code: "CONVERSATION_NOT_FOUND" });
      assert.equal(await repository.renewSummary(id, token), false);
      assert.equal(await repository.completeSummary({ conversation_id: id, through_sequence: 10, summary: {} as never, summary_version: "late", lease_token: token }), false);
      await noChildren(id, detail.turns.map((turn) => turn.turn_id));
    }
  });
  await check("real-10-20-boundaries-and-company-transitions", async () => {
    const id = await thread(4);
    for (let i = 4; i <= 10; i++) {
      const key = randomUUID(); await claim(id, key);
      await repository.completeRequest(completed(id, key));
      await maybeUpdateConversationSummary((await repository.findConversation(id))!);
      const hydrated = await hydrateConversationRequest({ conversation_id: id, message: "내가 말한 급여일과 회사 지급 약속을 다시 말해 달라.", chat_mode: "wage", recent_messages: [] }, user);
      assert.equal(hydrated.conversation_recall!.diagnostics.summarized_through_sequence, Math.floor((i + 1) / 5) * 10);
      assert.match(recallAnswer(hydrated)!.answer, /15일.*다음 주/);
    }
    for (const company of ["acceptance-A", "acceptance-B", null]) await repository.updateConversation({ conversation_id: id, owner_user_id: user.user_id, active_company_id: company });
    assert.equal((await repository.findConversation(id))!.active_company_id, null);
    assert((await repository.findConversation(id))!.turns.every((turn) => turn.company_id === null));
    assert.equal((await owner.query("SELECT * FROM conversation_company_events WHERE conversation_id=$1 AND event_kind='manual'", [id])).rowCount, 3);
  });
  await check("http-login-app-restart-restore-continue-summary", async () => {
    await startApp();
    let cookie = (await http("/api/auth/login", "", { email, password })).cookie; assert(cookie);
    const id = await thread(10); await worker();
    assert.equal((await http(`/api/conversations/${id}`, cookie)).data.turns.length, 10);
    assert((await http("/api/conversations", cookie)).data.items.some((item: { conversation_id: string }) => item.conversation_id === id));
    await stopApp(); await closeWritePools();
    await startApp();
    assert.equal((await http(`/api/conversations/${id}`, cookie)).data.turns.length, 10);
    assert((await http("/api/conversations", cookie)).data.items.some((item: { conversation_id: string }) => item.conversation_id === id));
    cookie = (await http("/api/auth/login", "", { email, password })).cookie;
    const key = randomUUID();
    const continued = (await http("/api/chat", cookie, { conversation_id: id, request_id: key, chat_mode: "wage", message: "정정한 급여일과 회사 지급 약속을 다시 말해 달라.", external_processing_consent: true })).data;
    assert.equal(continued.conversation_persistence, "saved"); assert.equal(continued.conversation_id, id);
    assert.match(continued.results[0].answer, /15일.*다음 주/);
    assert.equal(continued.results[0].trace.memory.summary_included, true);
    assert.equal(continued.results[0].trace.memory.summarized_through_sequence, 20);
    assert.equal((await http(`/api/conversations/${id}`, cookie)).data.turns.length, 11);
    const replay = (await http("/api/chat", cookie, { conversation_id: id, request_id: key, chat_mode: "wage", message: "정정한 급여일과 회사 지급 약속을 다시 말해 달라.", external_processing_consent: true })).data;
    assert.equal(replay.idempotent_replay, true);
    assert.equal((await http(`/api/conversations/${id}`, cookie)).data.turns.length, 11);
    // Real PG fault injection: a connection-class failure during save, after generation.
    // Only this newly created synthetic database receives the temporary trigger.
    await owner.query("CREATE FUNCTION acceptance_fail_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic connection failure' USING ERRCODE='08006'; END $$");
    await owner.query("CREATE TRIGGER acceptance_fail_save BEFORE INSERT ON conversation_messages FOR EACH ROW EXECUTE FUNCTION acceptance_fail_save()");
    const retryBody = { conversation_id: id, request_id: randomUUID(), chat_mode: "wage", message: "정정한 급여일과 회사 지급 약속을 다시 말해 달라.", external_processing_consent: true };
    let unsaved;
    try {
      unsaved = (await http("/api/chat", cookie, retryBody)).data;
      assert.equal(unsaved.conversation_persistence, "unavailable");
      assert.equal((await http(`/api/conversations/${id}`, cookie)).data.turns.length, 11);
    } finally {
      await owner.query("DROP TRIGGER acceptance_fail_save ON conversation_messages");
      await owner.query("DROP FUNCTION acceptance_fail_save()");
    }
    const savedRetry = (await http("/api/chat", cookie, retryBody)).data;
    assert.equal(savedRetry.conversation_persistence, "saved");
    assert.equal(savedRetry.comparison_id, unsaved.comparison_id);
    assert.equal((await http(`/api/conversations/${id}`, cookie)).data.turns.length, 12);
    await stopApp();
  });
  console.log(`ACCEPTANCE real_checks=${passed} provider_calls=0 browser=NOT_RUN`);
} catch (error) {
  console.log(`ACCEPTANCE ${JSON.stringify({ phase, status: "FAIL", code: (error as { code?: string }).code ?? "ASSERTION", check: error instanceof Error ? error.message.split("\n")[0].replace(/postgres\S+/g, "[redacted]") : "unknown" })}`);
  process.exitCode = 1;
} finally {
  await stopApp(); await closeWritePools(); await Promise.all([owner.end(), conversation.end(), auth.end()]);
}
