/** Isolated synthetic Task 10 runner. Requires --live, a frozen candidate, and a frozen corpus. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const product = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(product, '..');
const db = resolve(root, 'db');
const ragRoot = resolve(product, 'integrations/rag-api');
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const live = process.argv.includes('--live');
const dialoguesOnly = process.argv.includes('--dialogues-only');
const freezePath = resolve(option('--freeze') ?? '.runtime/personal10/freeze.json');
const corpusPath = resolve(option('--corpus') ?? 'eval/personal10-holdout.v1.json');
const hash = value => createHash('sha256').update(value).digest('hex');
const frozen = JSON.parse(readFileSync(freezePath, 'utf8'));
const corpusText = readFileSync(corpusPath, 'utf8');
const corpus = JSON.parse(corpusText);
assert.equal(corpus.single_turns?.length, 24, 'EXPECTED_24_SINGLE_TURNS');
assert.equal(corpus.dialogues?.length, 2, 'EXPECTED_TWO_DIALOGUES');
for (const dialog of corpus.dialogues) assert(dialog.steps.length >= 20 && dialog.steps.length <= 30, 'EXPECTED_20_TO_30_TURNS');
const corpusHash = hash(corpusText);
const acceptancePath = resolve(product, 'eval/personal10-acceptance.v1.json');
const acceptanceHash = hash(readFileSync(acceptancePath));
function verifySource() {
  const raw = execFileSync(process.execPath, ['scripts/personal10-freeze.mjs', '--verify', freezePath],
    { cwd: product, encoding: 'utf8' });
  assert(JSON.parse(raw).verified, 'SOURCE_CHANGED');
}
verifySource();
const runtime = resolve(product, '.runtime/personal10', `${Date.now()}-${randomBytes(3).toString('hex')}`);
mkdirSync(runtime, { recursive: true });
const save = (name, value) => writeFileSync(resolve(runtime, name), JSON.stringify(value, null, 2) + '\n');
const append = (name, value) => appendFileSync(resolve(runtime, name), JSON.stringify(value) + '\n');
const manifest = { schema: 'personal10-run.v1', started_at: new Date().toISOString(),
  candidate_head: frozen.head, source_digest_sha256: frozen.source_digest_sha256,
  corpus_sha256: corpusHash, acceptance_sha256: acceptanceHash,
  node: process.version, platform: process.platform,
  next: JSON.parse(readFileSync(resolve(product, 'node_modules/next/package.json'))).version,
  provider: 'Upstage', model: 'solar-pro3', execution_mode: 'dual_api, compare=false',
  app_data_mode: 'mock except real auth and conversation',
  database: 'new tmpfs PostgreSQL 16, existing migrations only',
  company_data_mode: 'mock', rag_mode: 'sealed local BGE-M3/Chroma',
  feedback_storage: 'off', provider_call_cap: 200, provider_automatic_retry: 'measure actual attempts',
  corpus_path: relative(root, corpusPath).replaceAll('\\', '/'),
  freeze_path: relative(root, freezePath).replaceAll('\\', '/'),
  synthetic_only: true, runtime: relative(root, runtime).replaceAll('\\', '/') };
manifest.segment = dialoguesOnly ? 'dialogues_only_after_runner_restart_error' : 'full_suite';
save('manifest.json', manifest);
  console.log(JSON.stringify({ preflight: true, runtime: manifest.runtime, segment: manifest.segment, candidate_head: frozen.head,
  source_digest_sha256: frozen.source_digest_sha256, corpus_sha256: corpusHash,
  acceptance_sha256: acceptanceHash, expected_turns: (dialoguesOnly ? 0 : corpus.single_turns.length) + corpus.dialogues.reduce((n,d)=>n+d.steps.length,0) }));
if (!live) process.exit(0);

const host = '127.0.0.1', pgPort = 55448, appPort = 3129, ragPort = 5071, proxyPort = 5072;
const base = `http://${host}:${appPort}`;
const container = `mw-personal10-${Date.now()}-${randomBytes(3).toString('hex')}`;
const pgPassword = randomBytes(24).toString('hex');
const pgUrl = `postgres://postgres:${pgPassword}@${host}:${pgPort}/mw_personal10`;
const token = randomBytes(24).toString('hex');
const children = [];
let proxy, app, cookie = '', email = '', password = '', accountDeleted = false;
let activeCase = null, activeFault = null, stopped = null, upstreamFailures = 0;
const calls = [], rows = [], checkpoints = [];
const sleep = ms => new Promise(done => setTimeout(done, ms));
function cmd(executable, args, cwd, env = process.env) {
  return execFileSync(executable, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function packageScript(script, cwd, env) {
  const exe = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', `npm.cmd run ${script}`] : ['run', script];
  return cmd(exe, args, cwd, env);
}
function launch(executable, args, cwd, env) {
  const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.resume();
  child.stderr.on('data', chunk => {
    for (const code of ['PermissionError', 'ModuleNotFoundError', 'AssetContractError', 'EADDRINUSE', 'Error:']) {
      if (String(chunk).includes(code)) append('process-diagnostics.jsonl', { process: executable, code });
    }
  });
  return child;
}
async function freePort(port) {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, host, done); });
  await new Promise(done => server.close(done));
}
async function ready(url, child, headers = {}) {
  for (let i = 0; i < 180; i++) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error('LOCAL_PROCESS_EXIT');
    try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(1000) }); if (r.ok) return; } catch { /* readiness only */ }
    await sleep(500);
  }
  throw new Error('LOCAL_READINESS_TIMEOUT');
}
function envBase() {
  return { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    APP_DATA_MODE: 'mock', COMPANY_DATA_MODE: 'mock', AUTH_DATA_MODE: 'real', CONVERSATION_DATA_MODE: 'real',
    FAVORITE_DATA_MODE: 'mock', COMMUNITY_DATA_MODE: 'mock', CONTRACT_DATA_MODE: 'mock', WORKSITE_TIP_DATA_MODE: 'mock',
    DATABASE_URL: pgUrl, AUTH_DATABASE_URL: pgUrl, CONVERSATION_DATABASE_URL: pgUrl,
    DATABASE_ENV_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
    CHAT_EXECUTION_MODE: 'dual_api', SAVE_COMPARISON_FEEDBACK: 'false',
    UPSTAGE_API_URL: `http://${host}:${proxyPort}`, UPSTAGE_MODEL: 'solar-pro3',
    SKT_API_KEY: '', OPENAI_API_KEY: '', MOCK_DELAY_MS: '0', PROMPT_DIR: resolve(product, 'prompts'),
    RAG_API_URL: `http://${host}:${ragPort}`, RAG_INTERNAL_TOKEN: token };
}
async function startProxy() {
  proxy = createServer(async (req, res) => {
    const call = { number: calls.length + 1, case_id: activeCase, started_at: new Date().toISOString(),
      injected_fault: null, status: null, duration_ms: null, usage: null, model: null, finish_reason: null };
    calls.push(call);
    const begin = performance.now();
    try {
      if (stopped || calls.length > 200) { stopped ??= 'PROVIDER_CALL_CAP'; res.writeHead(503); res.end('{}'); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(payload.model, 'solar-pro3', 'MODEL_DRIFT');
      const phase = payload.max_tokens === 120 ? 'rewrite' : payload.max_tokens === 100 ? 'classification' : 'generation';
      Object.assign(call, { phase, prompt_sha256: hash(JSON.stringify(payload.messages)), payload });
      let status, body;
      if (activeFault && phase === 'generation') {
        call.injected_fault = activeFault;
        if (activeFault === 'upstream_503') { status = 503; body = { error: { message: 'synthetic unavailable' } }; }
        else if (activeFault === 'citation_only') { status = 200; body = { id: 'synthetic-personal10-fault', model: 'solar-pro3',
          choices: [{ index: 0, message: { role: 'assistant', content: '근로기준법 제43조.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }; }
        else throw new Error('UNSUPPORTED_FAULT');
        activeFault = null;
      } else {
        const upstream = await fetch('https://api.upstage.ai/v1/chat/completions', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: req.headers.authorization ?? '' },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(90000) });
        status = upstream.status;
        body = await upstream.json();
      }
      Object.assign(call, { status, usage: body.usage ?? null, model: body.model ?? null,
        finish_reason: body.choices?.[0]?.finish_reason ?? null, raw_answer: body.choices?.[0]?.message?.content ?? null });
      if ([401, 403, 429].includes(status)) stopped = `UPSTREAM_${status}`;
      upstreamFailures = status === 200 ? 0 : upstreamFailures + 1;
      if (upstreamFailures >= 2) stopped ??= 'TWO_UPSTREAM_FAILURES';
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
    } catch {
      Object.assign(call, { status: 'network_or_parse_error', usage: null });
      if (++upstreamFailures >= 2) stopped = 'TWO_UPSTREAM_FAILURES';
      res.writeHead(502, { 'content-type': 'application/json' }); res.end('{}');
    } finally {
      call.duration_ms = performance.now() - begin;
      append('provider-calls.jsonl', call);
    }
  });
  await new Promise((done, reject) => { proxy.once('error', reject); proxy.listen(proxyPort, host, done); });
}
function startApp() { app = launch(process.execPath,
  ['node_modules/next/dist/bin/next', 'start', '--hostname', host, '--port', String(appPort)], product, envBase()); }
async function restartApp() {
  app.kill();
  for (let i = 0; i < 60 && app.exitCode === null && app.signalCode === null; i++) await sleep(250);
  assert(app.exitCode !== null || app.signalCode !== null, 'APP_RESTART_STOP_TIMEOUT');
  startApp(); await ready(`${base}/api/health/live`, app);
  checkpoints.push({ type: 'app_restart', at: new Date().toISOString() });
}
async function api(path, method = 'GET', body, auth = cookie) {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json',
    'sec-fetch-site': 'same-origin', origin: base, ...(auth ? { cookie: auth } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180000) });
  let data; try { data = await response.json(); } catch { data = null; }
  return { status: response.status, data,
    cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
}
async function restore(conversationId, expectedTurns) {
  const detail = await api(`/api/conversations/${conversationId}`);
  const observed = { status: detail.status, source: detail.data?.source ?? null,
    turns: detail.data?.turns?.length ?? null, expected_turns: expectedTurns };
  assert.equal(observed.status, 200, 'RESTORE_HTTP_FAILED');
  assert.equal(observed.source, 'database', 'REAL_DB_NOT_USED');
  assert.equal(observed.turns, expectedTurns, 'RESTORED_TURN_COUNT_MISMATCH');
  return observed;
}
async function relogin(conversationId, expectedTurns) {
  await api('/api/auth/logout', 'POST', {});
  const login = await api('/api/auth/login', 'POST', { email, password }, '');
  assert.equal(login.status, 200, 'RELOGIN_FAILED'); cookie = login.cookie;
  const observed = await restore(conversationId, expectedTurns);
  checkpoints.push({ type: 'relogin_restore', conversation_id: conversationId, ...observed });
}
async function evaluateTurn(item, scope, conversationId, expectedTurns) {
  if (stopped) throw new Error(`UPSTREAM_STOP_${stopped}`);
  if (item.relogin_before && conversationId) await relogin(conversationId, expectedTurns);
  if (item.restart_before && conversationId) { await restartApp(); await restore(conversationId, expectedTurns); }
  if (Object.hasOwn(item, 'set_active_company') && conversationId) {
    const patch = await api(`/api/conversations/${conversationId}`, 'PATCH', { active_company_id: item.set_active_company });
    assert.equal(patch.status, 200, 'COMPANY_SELECTION_FAILED');
  }
  activeCase = item.id; activeFault = item.inject_fault ?? null;
  const request = { message: item.message, chat_mode: item.chat_mode ?? 'wage', recent_messages: item.fixed_history ?? [],
    request_id: randomUUID(), external_processing_consent: true,
    ...(item.company_id ? { company_id: item.company_id } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}) };
  const auth = scope === 'frozen_history' ? '' : cookie;
  const callStart = calls.length, begin = performance.now();
  const response = await api('/api/chat', 'POST', request, auth);
  const result = response.data?.results?.[0] ?? null;
  const row = { id: item.id, scope, request: { ...request, recent_messages: request.recent_messages },
    http_status: response.status, duration_ms: performance.now() - begin,
    result, conversation_id: response.data?.conversation_id ?? null,
    conversation_persistence: response.data?.conversation_persistence ?? null,
    provider_call_numbers: calls.slice(callStart).map(c => c.number),
    provider_phases: calls.slice(callStart).map(c => c.phase),
    planned_fault: item.inject_fault ?? null, storage: null, runner_valid: true };
  activeCase = null; activeFault = null;
  if (response.status === 200 && scope !== 'frozen_history') {
    assert.equal(row.conversation_persistence, 'saved', 'CONVERSATION_NOT_SAVED');
    assert(row.conversation_id, 'CONVERSATION_ID_MISSING');
    row.storage = await restore(row.conversation_id, expectedTurns + 1);
  }
  rows.push(row); append('rows.jsonl', row);
  console.log(JSON.stringify({ id: row.id, scope, http_status: row.http_status,
    guard: result?.trace?.guardrail_action ?? null, provider_calls: row.provider_call_numbers.length,
    storage: row.storage?.source ?? null }));
  return row;
}
try {
  for (const port of [pgPort, appPort, ragPort, proxyPort]) await freePort(port);
  const dockerEnv = { ...process.env, POSTGRES_PASSWORD: pgPassword };
  cmd('docker', ['run', '-d', '--rm', '--name', container, '--label', 'mw.task=personal10',
    '--tmpfs', '/var/lib/postgresql/data:rw,size=1g', '-p', `${host}:${pgPort}:5432`,
    '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=mw_personal10', 'postgres:16-bookworm'], root, dockerEnv);
  let dbReady = false;
  for (let i = 0; i < 120; i++) { try {
    cmd('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'mw_personal10'], root);
    dbReady = true; break;
  } catch { await sleep(500); } }
  assert(dbReady, 'POSTGRES_NOT_READY');
  packageScript('migrate', db, { ...process.env, DATABASE_URL: pgUrl });
  const ledger = cmd('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'mw_personal10', '-Atqc',
    'select count(*) from drizzle.__drizzle_migrations'], root).trim();
  assert.equal(Number(ledger), 21, 'MIGRATION_LEDGER_MISMATCH');
  manifest.postgres = cmd('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'mw_personal10', '-Atqc', 'show server_version'], root).trim();
  manifest.migration_ledger_count = Number(ledger);
  // Mock public company adapters still need FK targets in the isolated real
  // conversation database. These rows exist only in this new tmpfs instance.
  const fixtureSql = `INSERT INTO firms (firm_id,name,biz_no,sido,industry) VALUES
    ('COMPANY_DEMO_001','OO건설','SYNTHETIC-001','인천광역시','건설업'),
    ('COMPANY_DEMO_002','다온제조','SYNTHETIC-002','충청남도','제조업'),
    ('UNKNOWN_WAGE_001','새봄서비스','SYNTHETIC-003','세종특별자치시','사업지원 서비스업'),
    ('UNKNOWN_SAFETY_001','푸른건설','SYNTHETIC-004','경기도','건설업'),
    ('COMPANY_DEMO_006','OO건설','SYNTHETIC-006','경기도','전문직별 공사업'),
    ('EXPIRED_001','오래된물류','SYNTHETIC-007','부산광역시','운수 및 창고업'),
    ('ERROR_001','오류확인사업장','SYNTHETIC-009','대전광역시','사업지원 서비스업');`;
  cmd('docker', ['exec', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres',
    '-d', 'mw_personal10', '-c', fixtureSql], root);
  manifest.synthetic_firm_fk_rows = 7;
  save('manifest.json', manifest);
  await startProxy();
  const ragCopy = resolve(runtime, 'chroma');
  cpSync(resolve(ragRoot, 'data/labor_law_db'), ragCopy, { recursive: true, errorOnExist: true, force: false });
  const rag = launch(resolve(ragRoot, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'),
    ['app.py'], ragRoot, { ...envBase(), RAG_PORT: String(ragPort), RAG_HOST: host, RAG_DB_PATH: ragCopy,
      HF_HOME: resolve(ragRoot, '.cache/huggingface'), HF_HUB_CACHE: resolve(ragRoot, '.cache/huggingface/hub'),
      HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', RAG_MODEL_LOCAL_ONLY: '1', RAG_REQUIRE_ASSET_SEAL: '1',
      RAG_ASSET_MANIFEST: resolve(ragRoot, 'config/rag_assets.v1.json'),
      RAG_MODEL_REVISION: '5617a9f61b028005a4858fdac845db406aefb181',
      RAG_EXPECTED_DOCUMENT_COUNT: '806', RAG_EXPECTED_EMBEDDING_DIMENSION: '1024',
      RAG_COLLECTION: 'labor_law', RAG_DISTANCE_THRESHOLD: '0.42', RAG_STRONG_MATCH_DISTANCE: '0.30',
      TOKENIZERS_PARALLELISM: 'false' });
  await ready(`http://${host}:${ragPort}/api/health`, rag, { authorization: `Bearer ${token}` });
  packageScript('build', product, envBase());
  manifest.build_id = readFileSync(resolve(product, '.next/BUILD_ID'), 'utf8').trim();
  save('manifest.json', manifest);
  verifySource();
  startApp(); await ready(`${base}/api/health/live`, app);
  email = `personal10-${Date.now()}@example.invalid`; password = randomBytes(12).toString('hex');
  const signup = await api('/api/auth/signup', 'POST', { email, password, name: 'Personal10 synthetic' }, '');
  save('signup-check.json', { status: signup.status, error_code: signup.data?.error?.code ?? signup.data?.code ?? null });
  assert.equal(signup.status, 201, 'SYNTHETIC_SIGNUP_FAILED'); cookie = signup.cookie;
  for (const item of dialoguesOnly ? [] : corpus.single_turns) {
    await evaluateTurn(item, item.fixed_history ? 'frozen_history' : 'single_api', undefined, 0);
  }
  for (const dialog of corpus.dialogues) {
    let conversationId, completed = 0;
    for (const item of dialog.steps) {
      const row = await evaluateTurn(item, `live_accumulated:${dialog.id}`, conversationId, completed);
      if (row.http_status !== 200 || !row.storage) { checkpoints.push({ dialog: dialog.id, stopped_at: item.id, reason: 'REQUEST_OR_STORAGE_FAILURE' }); break; }
      conversationId = row.conversation_id; completed++;
      if (item.checkpoint) checkpoints.push({ dialog: dialog.id, at: item.id, ...row.storage,
        memory: row.result?.trace?.memory ?? null });
    }
    if (conversationId) await restore(conversationId, completed);
  }
  verifySource();
  manifest.finished_at = new Date().toISOString(); manifest.actual_provider_calls = calls.length;
  manifest.normal_rows = rows.filter(r => !r.planned_fault).length;
  manifest.planned_fault_rows = rows.filter(r => r.planned_fault).length;
  save('manifest.json', manifest);
  save('checkpoints.json', checkpoints);
  save('technical-summary.json', { rows: rows.length, provider_calls: calls.length,
    phases: Object.fromEntries([...new Set(calls.map(c=>c.phase))].map(p => [p, calls.filter(c=>c.phase===p).length])),
    http_failures: rows.filter(r=>r.http_status!==200).map(r=>r.id),
    provider_failures: calls.filter(c=>c.status!==200).map(c=>({ number:c.number, status:c.status, injected_fault:c.injected_fault })),
    total_returned_tokens: calls.filter(c=>c.usage?.total_tokens != null).reduce((n,c)=>n+c.usage.total_tokens,0),
    rows_with_usage: calls.filter(c=>c.usage?.total_tokens != null).length,
    stopped, checkpoints: checkpoints.length });
} catch (error) {
  save('runner-failure.json', { code: error?.code ?? 'RUNNER_ASSERTION', message: String(error?.message ?? error).split('\n')[0],
    rows_preserved: rows.length, provider_calls_preserved: calls.length, at: new Date().toISOString() });
  console.error(JSON.stringify({ run_failed: true, code: error?.code ?? 'RUNNER_ASSERTION',
    rows_preserved: rows.length, runtime: manifest.runtime }));
  process.exitCode = 2;
} finally {
  if (cookie && app?.exitCode === null) {
    try { const deletion = await api('/api/auth/account', 'DELETE', { confirmation: '계정 삭제' });
      accountDeleted = deletion.status === 200; } catch { /* tmpfs DB will be removed */ }
  }
  save('cleanup.json', { synthetic_account_delete_200: accountDeleted, tmpfs_container: container,
    user_data_retained_after_container_stop: false });
  for (const child of children.reverse()) if (child.exitCode === null) child.kill();
  if (proxy) { proxy.closeAllConnections(); await new Promise(done => proxy.close(done)); }
  try { const label = cmd('docker', ['inspect', '--format', '{{index .Config.Labels "mw.task"}}', container], root).trim();
    if (label === 'personal10') cmd('docker', ['stop', container], root);
    else process.exitCode = 2;
  } catch { /* container may already be gone */ }
  console.log(JSON.stringify({ runtime: manifest.runtime, rows: rows.length, calls: calls.length,
    synthetic_account_delete_200: accountDeleted, exit_code: process.exitCode ?? 0 }));
}
