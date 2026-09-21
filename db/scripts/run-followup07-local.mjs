/** Reuses only the named follow-up 06 synthetic PG16. No migration/reset/production target. */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { parse } from 'dotenv';
import { POSTCONDITIONS_SQL } from './check-migration-drift.mjs';
import { analyzeMigrationState } from './migration-drift-core.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const product = resolve(root, 'product');
const runtime = resolve(product, '.runtime/followup07');
const container = 'mw-followup06-1789983829982-e8d9a9';
const database = 'mw_followup06';
const owner = 'mw_followup06_owner';
const base = 'http://127.0.0.1:3116';
const env = { ...process.env };
const apps = new Set();
const calls = [];
let app;
let proxy;
let started = false;
let phase = 'identity';
let metricPath;
const output = (value) => console.log(`FOLLOWUP07 ${JSON.stringify(value)}`);
function docker(args, input) {
  return execFileSync('docker', args, { env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}
function psql(input) {
  return docker(['exec', '-i', '-e', 'MW_AUTH_PASSWORD', '-e', 'MW_CONVERSATION_PASSWORD', container,
    'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', owner, '-d', database], input).trim();
}
function child(args, childEnv = env) {
  const process = spawn(globalThis.process.execPath, args, { cwd: product, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  apps.add(process); process.stderr.resume();
  return process;
}
async function run(args, childEnv = env) {
  const task = child(args, childEnv); let stdout = '';
  task.stdout.on('data', chunk => { stdout += chunk; });
  const code = await new Promise((done, reject) => { task.once('close', done); task.once('error', reject); });
  apps.delete(task);
  // CLI results are only summaries; credentials are never passed as argv or recorded.
  output({ command: args[0], exit: code, summary: stdout.trim() });
  return code;
}
async function stop(task) {
  if (!task || task.exitCode !== null) return;
  const closed = new Promise(done => task.once('close', done));
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(task.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else task.kill('SIGTERM');
  await closed; apps.delete(task);
}
async function startApp() {
  app = child(['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3116']);
  app.stdout.resume();
  for (let n = 0; n < 120; n++) {
    if (app.exitCode !== null) throw new Error('APP_EXIT');
    try { if ((await fetch(base + '/api/health/live', { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error('APP_TIMEOUT');
}
try {
  assert.equal(process.versions.node.split('.')[0], '22');
  const identity = JSON.parse(docker(['inspect', container]))[0];
  assert.equal(identity.Config.Labels['moneyworry.acceptance'], 'followup06');
  assert.equal(identity.Config.Image, 'postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685');
  assert.deepEqual(identity.HostConfig.PortBindings['5432/tcp'], [{ HostIp: '127.0.0.1', HostPort: '55436' }]);
  assert(identity.Mounts.some(m => m.Name === container + '-data' && m.Destination === '/var/lib/postgresql/data'));
  assert.equal(identity.State.Running, false, 'Expected retained stopped acceptance DB');
  docker(['start', container]); started = true;
  for (let n = 0; n < 40; n++) {
    try { docker(['exec', container, 'pg_isready', '-U', owner, '-d', database]); break; }
    catch { await new Promise(done => setTimeout(done, 500)); }
  }
  const dbIdentity = JSON.parse(psql("SELECT json_build_object('database',current_database(),'role',current_user,'version',current_setting('server_version_num')::int)"));
  assert.equal(dbIdentity.database, database); assert.equal(dbIdentity.role, owner);
  assert(dbIdentity.version >= 160000 && dbIdentity.version < 170000);
  const postconditions = JSON.parse(psql(POSTCONDITIONS_SQL));
  const journal = JSON.parse(readFileSync(resolve(root, 'db/migrations/meta/_journal.json'), 'utf8'));
  const localMigrations = journal.entries.map(e => ({ ...e, hash: createHash('sha256').update(readFileSync(resolve(root, `db/migrations/${e.tag}.sql`))).digest('hex') }));
  const ledgerRows = JSON.parse(psql('SELECT json_agg(t) FROM (SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at) t'));
  const drift = analyzeMigrationState({ localMigrations, ledgerExists: true, ledgerRows, postconditions });
  assert.equal(drift.blocked, false);
  output({ container, ...dbIdentity, drift: drift.status, ledger: ledgerRows.length });
  // Mock public-company DTOs still need matching FK identities in the real conversation DB.
  psql("INSERT INTO firms(firm_id,name,biz_no) VALUES ('COMPANY_DEMO_008','한빛테크','followup07-synthetic-A'),('UNKNOWN_SAFETY_001','푸른건설','followup07-synthetic-B') ON CONFLICT (firm_id) DO NOTHING");
  phase = 'test-roles';
  // New local test roles leave the existing wg_auth/wg_conversation credentials untouched.
  const suffix = randomBytes(4).toString('hex');
  metricPath = resolve(runtime, `provider-metrics-${suffix}.json`);
  for (const kind of ['auth', 'conversation']) {
    const role = `wg_${kind}_f07_${suffix}`;
    const key = `MW_${kind.toUpperCase()}_PASSWORD`;
    env[key] = randomBytes(24).toString('hex');
    const script = readFileSync(resolve(root, `db/scripts/create-${kind}-role.sh`), 'utf8');
    const block = script.match(/<<'SQL'\r?\n([\s\S]*?)\r?\nSQL/)[1];
    psql(`\\set ${kind}_user ${role}\n\\set db_name ${database}\n${block}\n`);
    env[`${kind.toUpperCase()}_DATABASE_URL`] = `postgresql://${role}:${env[key]}@127.0.0.1:55436/${database}`;
  }
  mkdirSync(runtime, { recursive: true });
  for (const name of ['stop', 'evaluate', 'continuity', 'restart', 'worker', 'metrics']) {
    assert(!existsSync(resolve(runtime, name)), 'Remove only a reviewed stale control marker before restarting');
  }
  Object.assign(env, { NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', APP_DATA_MODE: 'mock', COMPANY_DATA_MODE: 'mock',
    AUTH_DATA_MODE: 'real', CONVERSATION_DATA_MODE: 'real', FAVORITE_DATA_MODE: 'mock', COMMUNITY_DATA_MODE: 'mock',
    CONTRACT_DATA_MODE: 'mock', WORKSITE_TIP_DATA_MODE: 'mock', DB_SSL: 'false', DATABASE_URL: '',
    DATABASE_ENV_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null', RAG_API_URL: 'http://127.0.0.1:5051',
    CHAT_EXECUTION_MODE: 'dual_api', SKT_API_KEY: '', SKT_API_URL: 'http://127.0.0.1:1/no-provider', OPENAI_API_KEY: '' });
  // Transparent local measurement of Upstage calls. No request body/key/prompt is logged.
  proxy = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const began = Date.now();
    try {
      const upstream = await fetch('https://api.upstage.ai/v1/chat/completions', { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: req.headers.authorization ?? '' }, body: Buffer.concat(chunks), signal: AbortSignal.timeout(90000) });
      const raw = await upstream.text(); let usage = null;
      try { usage = JSON.parse(raw).usage ?? null; } catch {}
      calls.push({ duration_ms: Date.now() - began, status: upstream.status, usage });
      res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(raw);
    } catch { calls.push({ duration_ms: Date.now() - began, status: 'network_error', usage: null }); res.writeHead(502); res.end('{"error":{"code":"LOCAL_UPSTREAM_FAILURE"}}'); }
  });
  await new Promise((done, reject) => { proxy.once('error', reject); proxy.listen(5053, '127.0.0.1', done); });
  env.UPSTAGE_API_URL = 'http://127.0.0.1:5053';
  // Only the already configured provider secret is used; Next loads .env.local itself.
  const configured = existsSync(resolve(product, '.env.local')) ? parse(readFileSync(resolve(product, '.env.local'))) : {};
  if (configured.SHARED_API_KEY_FILE) env.SHARED_API_KEY_FILE = configured.SHARED_API_KEY_FILE;
  phase = 'rag';
  env.RAG_INTERNAL_TOKEN = randomBytes(24).toString('hex');
  const ragRoot = resolve(product, 'integrations/rag-api');
  const ragEnv = { ...env, HF_HOME: resolve(ragRoot, '.cache/huggingface'), HF_HUB_CACHE: resolve(ragRoot, '.cache/huggingface/hub'),
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', RAG_MODEL_LOCAL_ONLY: '1', RAG_REQUIRE_ASSET_SEAL: '1',
    RAG_ASSET_MANIFEST: resolve(ragRoot, 'config/rag_assets.v1.json'), RAG_DB_PATH: resolve(runtime, 'chroma-live'),
    RAG_MODEL_REVISION: '5617a9f61b028005a4858fdac845db406aefb181', RAG_EXPECTED_DOCUMENT_COUNT: '583',
    RAG_EXPECTED_EMBEDDING_DIMENSION: '1024', RAG_COLLECTION: 'labor_law', RAG_DISTANCE_THRESHOLD: '0.42',
    RAG_STRONG_MATCH_DISTANCE: '0.30', TOKENIZERS_PARALLELISM: 'false' };
  const rag = spawn(resolve(ragRoot, '.venv/Scripts/python.exe'), ['app.py'], { cwd: ragRoot, env: ragEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  apps.add(rag); rag.stdout.resume();
  let ragError = '';
  rag.stderr.on('data', chunk => { ragError = (ragError + String(chunk)).slice(-6000); });
  let ragReady = false;
  for (let n = 0; n < 120; n++) {
    if (rag.exitCode !== null) {
      // Python diagnostics contain no input/credentials; emit only known operational categories.
      output({ rag_exit: rag.exitCode, error_categories: ['PermissionError', 'ModuleNotFoundError', 'AssetContractError', 'RetrievalUnavailable', 'Address already in use', 'OSError', 'ValueError'].filter(kind => ragError.includes(kind)) });
      throw new Error('RAG_EXIT');
    }
    try { if ((await fetch('http://127.0.0.1:5051/api/health', { headers: { authorization: `Bearer ${env.RAG_INTERNAL_TOKEN}` }, signal: AbortSignal.timeout(1000) })).ok) { ragReady = true; break; } } catch {}
    await new Promise(done => setTimeout(done, 500));
  }
  assert(ragReady, 'RAG_NOT_READY');
  phase = 'app'; await startApp();
  output({ ready: true, base, control_directory: '.runtime/followup07', provider_metrics: 'counts-latency-usage-only' });
  while (!existsSync(resolve(runtime, 'stop'))) {
    for (const action of ['evaluate', 'continuity', 'restart', 'worker', 'metrics']) {
      const marker = resolve(runtime, action); if (!existsSync(marker)) continue;
      const selection = readFileSync(marker, 'utf8').trim();
      unlinkSync(marker); phase = action; const before = calls.length;
      if (action === 'evaluate') await run(['--experimental-strip-types', 'scripts/run-answer-quality-eval.ts', '--base-url', base, '--runs', '1', '--output', `.runtime/followup07/anonymous-${Date.now()}.jsonl`, ...(selection.startsWith('AQ') ? ['--cases', selection] : [])]);
      if (action === 'continuity') {
        const email = `followup07-${randomBytes(8).toString('hex')}@example.invalid`;
        const password = randomBytes(12).toString('hex');
        const signup = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ email, password, name: '후속7 합성 평가' }) });
        assert.equal(signup.status, 201);
        await run(['--experimental-strip-types', 'scripts/run-conversation-continuity-eval.ts', '--base-url', base, '--output', `.runtime/followup07/continuity-${Date.now()}.jsonl`], { ...env, ANSWER_EVAL_EMAIL: email, ANSWER_EVAL_PASSWORD: password, ANSWER_EVAL_ISOLATED_PG16: '1' });
      }
      if (action === 'restart') { await stop(app); await startApp(); output({ app_restart: 'ready' }); }
      if (action === 'worker') { await run(['scripts/build-conversation-worker.mjs']); await run(['.runtime/conversation-worker.mjs']); }
      writeFileSync(metricPath, JSON.stringify(calls, null, 2));
      output({ action, provider_calls: calls.length - before, total_provider_calls: calls.length });
    }
    await new Promise(done => setTimeout(done, 500));
  }
  unlinkSync(resolve(runtime, 'stop'));
} catch (error) {
  output({ phase, status: 'FAIL', code: typeof error.code === 'string' ? error.code : 'CHECK_FAILED' });
  process.exitCode = 1;
} finally {
  if (metricPath && existsSync(runtime)) writeFileSync(metricPath, JSON.stringify(calls, null, 2));
  for (const task of apps) await stop(task);
  proxy?.closeAllConnections(); proxy?.close();
  if (started) { docker(['stop', container]); output({ stopped: container, data_retained: true }); }
}
