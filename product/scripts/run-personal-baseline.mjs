/** Local synthetic baseline only. No database, Git, deployment, or account writes. */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvText } from '../src/server/envText.ts';
import { evaluateAnswerQualityCase } from '../src/services/answerQualityEvalRunner.ts';

const product = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(product, '..');
const ragRoot = resolve(product, 'integrations/rag-api');
const runtime = resolve(product, '.runtime/personal01', new Date().toISOString().replace(/[:.]/g, '-'));
const base = 'http://127.0.0.1:3123';
const children = [];
const calls = [];
const rows = [];
let proxy;
let activeCase = null;
let stopReason = null;
let networkFailures = 0;
const log = value => console.log(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const save = (name, data) => writeFileSync(resolve(runtime, name), JSON.stringify(data, null, 2));
function fingerprint() {
  const result = {};
  for (const folder of ['src', 'prompts', 'integrations/rag-api/knowledge', 'integrations/rag-api/config']) {
    function visit(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile()) result[relative(product, path).replaceAll('\\', '/')] = hash(readFileSync(path));
      }
    }
    visit(resolve(product, folder));
  }
  for (const name of ['app.py', 'retriever.py']) result[`integrations/rag-api/${name}`] = hash(readFileSync(resolve(ragRoot, name)));
  return result;
}
function start(executable, args, cwd, env) {
  const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.resume();
  // Never echo subprocess environment, prompts, or unsanitized diagnostics.
  child.stderr.on('data', chunk => {
    for (const category of ['PermissionError', 'ModuleNotFoundError', 'AssetContractError', 'EADDRINUSE']) {
      if (String(chunk).includes(category)) log({ diagnostic: category });
    }
  });
  return child;
}
async function ready(child, url, headers = {}) {
  for (let i = 0; i < 180; i++) {
    if (child.exitCode !== null) throw new Error('LOCAL_PROCESS_EXIT');
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* bounded readiness polling */ }
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error('LOCAL_READINESS_TIMEOUT');
}
async function assertPortFree(port) {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  await new Promise(done => server.close(done));
}

mkdirSync(runtime, { recursive: true });
const before = fingerprint();
save('source-before.json', before);
const configured = existsSync(resolve(product, '.env.local')) ? parseEnvText(readFileSync(resolve(product, '.env.local'), 'utf8')) : {};
let shared = {};
try { if (configured.SHARED_API_KEY_FILE) shared = parseEnvText(readFileSync(configured.SHARED_API_KEY_FILE, 'utf8')); } catch { /* presence only */ }
const key = process.env.UPSTAGE_API_KEY || configured.UPSTAGE_API_KEY || configured.Upstage_API_KEY || shared.UPSTAGE_API_KEY || shared.Upstage_API_KEY;
const selectedIds = ['AQ11', 'AQ12', 'AQ21', 'AQ23', 'AQ25', 'AQ30', 'AQ31', 'AQ32', 'AQ33'];
const selected = JSON.parse(readFileSync(resolve(product, 'eval/answer-contract-cases.json'), 'utf8'))
  .filter(item => item.split === 'development' && selectedIds.includes(item.id.split('-')[0]));
const continuity = JSON.parse(readFileSync(resolve(product, 'eval/conversation-continuity-cases.json'), 'utf8'))
  .find(item => item.id === 'AQ-CONT-01-corrected-payday-recall' && item.split === 'development');
const manifest = {
  product_head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  source_digest: hash(JSON.stringify(before)), evaluator_sha256: hash(readFileSync(fileURLToPath(import.meta.url))),
  node: process.version, platform: process.platform, next: JSON.parse(readFileSync(resolve(product, 'node_modules/next/package.json'))).version,
  scenarios: selected.map(item => item.id), continuity: 'six guest turns adapted from existing development case; no DB or relogin',
  estimated_provider_calls: 'fixed 0-27; guest 0-18; combined hard cap 40', maximum_provider_calls: 40,
  repetitions: 1, evaluator_retries: 0, key_present: Boolean(key),
  mode: 'local Mock company/auth/conversation, real sealed RAG, real Upstage only; feedback OFF',
  measured_at: new Date().toISOString(), runtime: relative(product, runtime),
};
save('manifest.json', manifest);
log({ preflight: manifest });
if (!process.argv.includes('--live')) process.exit(0);

try {
  if (!key) throw new Error('UPSTAGE_KEY_MISSING');
  if (selected.length !== 9 || !continuity) throw new Error('DEVELOPMENT_CASE_SELECTION_FAILED');
  for (const port of [3123, 5063, 5064]) await assertPortFree(port);
  const env = { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
    APP_DATA_MODE: 'mock', COMPANY_DATA_MODE: 'mock', AUTH_DATA_MODE: 'mock', CONVERSATION_DATA_MODE: 'mock',
    FAVORITE_DATA_MODE: 'mock', COMMUNITY_DATA_MODE: 'mock', CONTRACT_DATA_MODE: 'mock', WORKSITE_TIP_DATA_MODE: 'mock',
    DATABASE_URL: '', AUTH_DATABASE_URL: '', CONVERSATION_DATABASE_URL: '', DATABASE_ENV_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
    SHARED_API_KEY_FILE: '', UPSTAGE_API_KEY: key, SKT_API_KEY: '', OPENAI_API_KEY: '', SAVE_COMPARISON_FEEDBACK: 'false',
    UPSTAGE_API_URL: 'http://127.0.0.1:5064', UPSTAGE_MODEL: configured.UPSTAGE_MODEL || 'solar-pro3',
    CHAT_EXECUTION_MODE: 'dual_api', PROMPT_DIR: resolve(product, 'prompts'),
    RAG_API_URL: 'http://127.0.0.1:5063', RAG_INTERNAL_TOKEN: randomBytes(24).toString('hex'),
  };
  proxy = createServer(async (req, res) => {
    if (stopReason || calls.length >= 40) {
      stopReason ??= 'CALL_CAP'; res.writeHead(503); res.end('{}'); return;
    }
    const entry = { case_id: activeCase, call: calls.length + 1, started_at: new Date().toISOString() };
    calls.push(entry);
    const began = Date.now();
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const upstream = await fetch('https://api.upstage.ai/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: req.headers.authorization ?? '' },
        body: Buffer.concat(chunks), signal: AbortSignal.timeout(90000),
      });
      const raw = await upstream.text();
      Object.assign(entry, { status: upstream.status, duration_ms: Date.now() - began });
      try {
        const value = JSON.parse(raw);
        entry.usage = value.usage ?? null;
        entry.model = value.model ?? null;
        // Synthetic model outputs only. No request prompts, credentials or headers.
        save(`raw-${entry.call}.json`, { case_id: activeCase, choices: value.choices ?? [], model: value.model ?? null });
      } catch { entry.usage = null; }
      if ([401, 403, 429].includes(upstream.status)) stopReason = `UPSTREAM_${upstream.status}`;
      networkFailures = upstream.ok ? 0 : networkFailures + 1;
      if (networkFailures >= 2) stopReason ??= 'TWO_UPSTREAM_FAILURES';
      res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(raw);
    } catch {
      Object.assign(entry, { status: 'network_error', duration_ms: Date.now() - began, usage: null });
      if (++networkFailures >= 2) stopReason = 'TWO_NETWORK_FAILURES';
      res.writeHead(502); res.end('{}');
    } finally { save('provider-metrics.json', calls); }
  });
  await new Promise((done, reject) => { proxy.once('error', reject); proxy.listen(5064, '127.0.0.1', done); });
  const ragCopy = resolve(runtime, 'chroma');
  cpSync(resolve(ragRoot, 'data/labor_law_db'), ragCopy, { recursive: true, errorOnExist: true, force: false });
  const rag = start(resolve(ragRoot, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'), ['app.py'], ragRoot, {
    ...env, RAG_PORT: '5063', RAG_HOST: '127.0.0.1', RAG_DB_PATH: ragCopy,
    HF_HOME: resolve(ragRoot, '.cache/huggingface'), HF_HUB_CACHE: resolve(ragRoot, '.cache/huggingface/hub'),
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', RAG_MODEL_LOCAL_ONLY: '1', RAG_REQUIRE_ASSET_SEAL: '1',
    RAG_ASSET_MANIFEST: resolve(ragRoot, 'config/rag_assets.v1.json'), RAG_MODEL_REVISION: '5617a9f61b028005a4858fdac845db406aefb181',
    RAG_EXPECTED_DOCUMENT_COUNT: '583', RAG_EXPECTED_EMBEDDING_DIMENSION: '1024', RAG_COLLECTION: 'labor_law',
    RAG_DISTANCE_THRESHOLD: '0.42', RAG_STRONG_MATCH_DISTANCE: '0.30', TOKENIZERS_PARALLELISM: 'false',
  });
  await ready(rag, 'http://127.0.0.1:5063/api/health', { authorization: `Bearer ${env.RAG_INTERNAL_TOKEN}` });
  log({ rag: 'ready' });
  const app = start(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3123'], product, env);
  await ready(app, base + '/api/health/live');
  log({ app: 'ready' });
  async function evaluate(item, bundle) {
    if (stopReason) throw new Error(stopReason);
    activeCase = item.id;
    const startCall = calls.length;
    let responseDetails = {};
    const row = await evaluateAnswerQualityCase({ baseUrl: base, item, attempt: 1,
      fetchImpl: async (url, init) => {
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(180000), headers: {
          ...init.headers, 'x-moneyworry-client-id': `personal01_${bundle}_synthetic`,
        } });
        try {
          const body = await response.clone().json();
          const result = body.results?.[0];
          responseDetails = { conversation_persistence: body.conversation_persistence ?? null,
            execution_mode: body.execution_mode ?? null, provider: result?.provider ?? null,
            provider_status: result?.status ?? null, metrics: result?.metrics ?? null };
        } catch { /* evaluator records parse error */ }
        return response;
      },
    });
    const measured = { ...row, ...responseDetails, provider_call_numbers: calls.slice(startCall).map(call => call.call),
      raw_generation_review: 'PENDING', usefulness_source_review: 'PENDING', evaluator_retries: 0, storage_source: 'guest_client_history' };
    rows.push(measured);
    appendFileSync(resolve(runtime, 'answers.jsonl'), JSON.stringify(measured) + '\n');
    log({ case_id: item.id, request: row.request_status, contract: row.contract_status,
      guardrail: row.trace?.guardrail_action, calls: calls.length - startCall, ms: row.duration_ms });
    if (row.request_status !== 'ok') throw new Error('REQUEST_FAILED');
    return row;
  }
  for (const item of selected) await evaluate(item, 'fixed');
  const history = [];
  for (const [index, step] of continuity.steps.slice(0, 6).entries()) {
    const row = await evaluate({ id: `GUEST-CONT-${index + 1}`, split: 'development',
      request: { message: step.message, chat_mode: step.chat_mode, compare: false, recent_messages: history.slice(-10) },
      contract: step.contract, human_review: step.human_review }, 'guest');
    history.push({ role: 'user', content: step.message }, { role: 'assistant', content: row.answer });
  }
  if (rows.some(row => row.contract_status === 'FAIL')) process.exitCode = 1;
} catch (error) {
  stopReason ??= error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'LOCAL_BASELINE_BLOCKED';
  log({ blocked: stopReason }); process.exitCode = 2;
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.pid) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else child.kill('SIGTERM');
      } catch { log({ cleanup: 'PROCESS_STOP_FAILED' }); }
    }
  }
  if (proxy) { proxy.closeAllConnections(); await new Promise(done => proxy.close(done)); }
  const after = fingerprint(); save('source-after.json', after);
  save('summary.json', { stop_reason: stopReason, requests: rows.length, provider_calls: calls.length,
    source_unchanged: JSON.stringify(before) === JSON.stringify(after),
    known_returned_tokens: calls.reduce((sum, call) => sum + (call.usage?.total_tokens ?? 0), 0),
    missing_usage_calls: calls.filter(call => call.usage?.total_tokens == null).length,
    database: 'NOT_RUN_GUEST_ONLY', browser: 'NOT_RUN', retries: 'evaluator=0; inspect all provider call records',
  });
  log({ finished: relative(product, runtime), requests: rows.length, provider_calls: calls.length, stop_reason: stopReason });
}
