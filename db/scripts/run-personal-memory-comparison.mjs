/** New loopback PG16 only. Secrets are memory/env-only; never accepts an existing DB URL. */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { parse } from 'dotenv';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { analyzeMigrationState } from './migration-drift-core.mjs';
import { POSTCONDITIONS_SQL } from './check-migration-drift.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const product = resolve(root, 'product');
const requireProduct = createRequire(resolve(product, 'package.json'));
const { build } = requireProduct('esbuild');
const hash = value => createHash('sha256').update(value).digest('hex');
const option = name => process.argv[process.argv.indexOf(name) + 1];
const bundle = process.argv.includes('--bundle') ? option('--bundle') : 'all';
const serve = process.argv.includes('--serve');
if (serve) assert(bundle === 'offline' && !process.argv.includes('--resume-from'), 'SERVE_REQUIRES_OFFLINE_FRESH_DB');
const cumulativeCap = process.argv.includes('--max-calls') ? Number(option('--max-calls')) : 90;
assert(Number.isInteger(cumulativeCap) && cumulativeCap >= 1 && cumulativeCap <= 90, 'INVALID_CALL_CAP');
const diagnosticIds = process.argv.includes('--diagnostic-ids') ? option('--diagnostic-ids').split(',') : ['AQ12', 'AQ21', 'AQ32'];
assert(diagnosticIds.length >= 1 && diagnosticIds.every(id => ['AQ12', 'AQ21', 'AQ32'].includes(id)), 'INVALID_DIAGNOSTIC_IDS');
const resume = process.argv.includes('--resume-from') ? resolve(root, option('--resume-from')) : null;
let priorCalls = 0;
let priorManifest;
if (resume) {
  const within = relative(resolve(product, '.runtime/personal02'), resume);
  assert(within && !within.startsWith('..') && !within.includes(':'));
  priorManifest = JSON.parse(readFileSync(resolve(resume, 'manifest.json')));
  // This runner merges one original fixed run only. Reject a chain rather than
  // silently forgetting its earlier valid rows or cumulative paid calls.
  assert(!priorManifest.resumed_from, 'CHAINED_RESUME_NOT_SUPPORTED');
  priorCalls = readFileSync(resolve(resume, 'provider-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length;
  assert(priorCalls < cumulativeCap);
}
assert(['all', 'fixed', 'continuous', 'diagnostic', 'offline'].includes(bundle));
assert.equal(process.versions.node.split('.')[0], '22', 'NODE22_REQUIRED');
const suffix = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const name = `${serve ? 'mw-personal03' : 'mw-personal02'}-${suffix}`;
const taskLabel = serve ? 'personal03' : 'personal02';
const runtime = resolve(product, serve ? '.runtime/personal03' : '.runtime/personal02', suffix);
// Ensure synthetic outputs cannot accidentally enter Git before any are written.
assert(execFileSync('git', ['check-ignore', 'product/.runtime/personal02/probe.json'], { cwd: root, encoding: 'utf8' }).trim());
mkdirSync(runtime, { recursive: true });
const save = (file, data) => writeFileSync(resolve(runtime, file), JSON.stringify(data, null, 2));
const log = data => console.log(`MEMORY_EVAL ${JSON.stringify(data)}`);
const tokenizer = resolve(product, 'integrations/rag-api/.cache/huggingface/hub/models--BAAI--bge-m3/snapshots/5617a9f61b028005a4858fdac845db406aefb181/tokenizer.json');
const tokenHash = hash(readFileSync(tokenizer));
const asset = JSON.parse(readFileSync(resolve(product, 'integrations/rag-api/config/rag_assets.v1.json')));
assert.equal(tokenHash, asset.model.files.find(file => file.path === 'tokenizer.json').sha256);
const lock = JSON.parse(readFileSync(resolve(product, 'package-lock.json')));
const next = requireProduct('next/package.json').version;
assert.equal(next, lock.packages['node_modules/next'].version, 'NEXT_INSTALL_DRIFT');
function sourceHashes() {
  const records = {};
  for (const folder of ['product/src', 'product/prompts', 'db/migrations']) {
    function visit(directory) {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const file = resolve(directory, item.name);
        if (item.isDirectory()) visit(file);
        else if (item.isFile()) records[relative(root, file).replaceAll('\\', '/')] = hash(readFileSync(file));
      }
    }
    visit(resolve(root, folder));
  }
  return records;
}
const before = sourceHashes(); save('source-before.json', before);
const configured = existsSync(resolve(product, '.env.local')) ? parse(readFileSync(resolve(product, '.env.local'))) : {};
let shared = {};
try { if (configured.SHARED_API_KEY_FILE) shared = parse(readFileSync(configured.SHARED_API_KEY_FILE)); } catch { /* presence only */ }
const key = process.env.UPSTAGE_API_KEY || configured.UPSTAGE_API_KEY || configured.Upstage_API_KEY || shared.UPSTAGE_API_KEY || shared.Upstage_API_KEY;
const manifest = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  node: process.version, next, lock_sha256: hash(readFileSync(resolve(product, 'package-lock.json'))),
  tokenizer: 'BGE-M3 local evaluation tokens; not Solar billing tokens', tokenizer_sha256: tokenHash,
  memory_budget: 4096, full_prompt_budget: 12288, bundle, serve, diagnostic_ids: diagnosticIds, key_present: Boolean(key),
  provider_call_cap: cumulativeCap - priorCalls, prior_provider_calls: priorCalls, cumulative_call_cap: cumulativeCap,
  resumed_from: resume ? relative(root, resume) : null, estimate: 'fixed36 + continuous36 + diagnostic6-9; skip valid fixed rows on resume',
  source_digest: hash(JSON.stringify(before)), started_at: new Date().toISOString(), runtime: relative(root, runtime),
  tools: Object.fromEntries(['product/scripts/memory-comparison-core.ts', 'product/scripts/memory-comparison-fixtures.ts',
    'product/scripts/run-memory-comparison.ts', 'product/scripts/memory-eval-token-counter.py', 'db/scripts/run-personal-memory-comparison.mjs']
    .map(file => [file, hash(readFileSync(resolve(root, file)))])) };
save('manifest.json', manifest); log({ preflight: manifest });
if (priorManifest) {
  for (const field of ['head', 'node', 'next', 'lock_sha256', 'tokenizer_sha256', 'memory_budget', 'source_digest']) assert.equal(manifest[field], priorManifest[field], `RESUME_DRIFT_${field}`);
  for (const file of ['product/scripts/memory-comparison-core.ts', 'product/scripts/memory-comparison-fixtures.ts']) assert.equal(manifest.tools[file], priorManifest.tools[file], 'RESUME_FIXTURE_CHANGED');
}
if (!process.argv.includes('--live')) process.exit(0);
assert(key || bundle === 'offline', 'UPSTAGE_KEY_MISSING');

const database = 'mw_personal02';
const owner = 'mw_personal02_owner';
const port = 55442;
const image = 'postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685';
const password = randomBytes(24).toString('hex');
const authPassword = randomBytes(24).toString('hex');
const conversationPassword = randomBytes(24).toString('hex');
const env = { ...process.env, POSTGRES_PASSWORD: password, MW_AUTH_PASSWORD: authPassword, MW_CONVERSATION_PASSWORD: conversationPassword };
const docker = (args, input) => execFileSync('docker', args, { env, input, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000 });
const psql = input => docker(['exec', '-i', '-e', 'MW_AUTH_PASSWORD', '-e', 'MW_CONVERSATION_PASSWORD', name,
  'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', owner, '-d', database], input).trim();
const url = (role, secret) => `postgresql://${role}:${secret}@127.0.0.1:${port}/${database}`;
let created = false;
let sql;
let child;
let phase = 'port-preflight';
try {
  await new Promise((done, reject) => { const probe = createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(done)); });
  docker(['info', '--format', '{{.ServerVersion}}']);
  assert.equal(docker(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}']).trim(), '');
  phase = 'fresh-container';
  docker(['run', '-d', '--name', name, '--label', `moneyworry.acceptance=${taskLabel}`, '-p', `127.0.0.1:${port}:5432`,
    '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_PASSWORD', '-e', `POSTGRES_USER=${owner}`, '-e', `POSTGRES_DB=${database}`, image]);
  created = true;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', owner, '-d', database]); break; }
    catch { if (attempt === 59) throw new Error('DB_NOT_READY'); await new Promise(done => setTimeout(done, 500)); }
  }
  sql = postgres(url(owner, password), { max: 1, onnotice: () => {} });
  const [target] = await sql`SELECT current_database() AS db, current_user AS role, current_setting('server_version_num')::int AS version`;
  assert(target.db === database && target.role === owner && target.version >= 160000 && target.version < 170000);
  assert.equal(Number((await sql`SELECT count(*) FROM information_schema.tables WHERE table_schema='public'`)[0].count), 0);
  phase = 'existing-migrations-and-roles';
  await migrate(drizzle(sql), { migrationsFolder: resolve(root, 'db/migrations') });
  for (const role of ['auth', 'conversation']) {
    const script = readFileSync(resolve(root, `db/scripts/create-${role}-role.sh`), 'utf8');
    const block = script.match(/<<'SQL'\r?\n([\s\S]*?)\r?\nSQL/)?.[1]; assert(block);
    psql(`\\set ${role}_user wg_${role}\n\\set db_name ${database}\n${block}\n`);
  }
  const journal = JSON.parse(readFileSync(resolve(root, 'db/migrations/meta/_journal.json')));
  const localMigrations = journal.entries.map(entry => ({ ...entry, hash: hash(readFileSync(resolve(root, `db/migrations/${entry.tag}.sql`))) }));
  const ledgerRows = await sql`SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`;
  const drift = analyzeMigrationState({ localMigrations, ledgerExists: true, ledgerRows, postconditions: JSON.parse(psql(POSTCONDITIONS_SQL)) });
  assert.equal(drift.blocked, false);
  await sql`INSERT INTO firms(firm_id,name,biz_no) VALUES ('COMPANY_DEMO_008','한빛테크','personal02-synthetic-A'),('COMPANY_DEMO_002','다온제조','personal03-synthetic-B'),('UNKNOWN_SAFETY_001','푸른건설','personal02-synthetic-C')`;
  save('database.json', { container: name, label: `moneyworry.acceptance=${taskLabel}`, tmpfs: true, ...target, ledger: ledgerRows.length, drift: drift.status, image });
  log({ phase, ledger: ledgerRows.length, drift: drift.status, pg: target.version });
  const childEnv = { ...process.env, APP_DATA_MODE: 'mock', COMPANY_DATA_MODE: 'mock', AUTH_DATA_MODE: 'real', CONVERSATION_DATA_MODE: 'real',
    DATABASE_URL: '', DATABASE_ENV_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null', DB_SSL: 'false',
    AUTH_DATABASE_URL: url('wg_auth', authPassword), CONVERSATION_DATABASE_URL: url('wg_conversation', conversationPassword),
    UPSTAGE_API_KEY: key, UPSTAGE_API_URL: 'https://api.upstage.ai/v1/chat/completions', UPSTAGE_MODEL: 'solar-pro3',
    SHARED_API_KEY_FILE: '', SKT_API_KEY: '', OPENAI_API_KEY: '', RAG_API_URL: '', MOCK_DELAY_MS: '0',
    PROMPT_DIR: resolve(product, 'prompts'), CHAT_EXECUTION_MODE: 'dual_api', SAVE_COMPARISON_FEEDBACK: 'false',
    MW_MEMORY_EVAL_CREATED: 'personal02-new-pg16', MW_MEMORY_EVAL_RUNTIME: runtime, MW_MEMORY_EVAL_BUNDLE: bundle, MW_MEMORY_EVAL_TOKENIZER: tokenizer,
    MW_MEMORY_EVAL_RESUME: resume ?? '', MW_MEMORY_EVAL_CALL_CAP: String(cumulativeCap - priorCalls),
    MW_MEMORY_EVAL_DIAGNOSTIC_IDS: diagnosticIds.join(',') };
  if (serve) {
    phase = 'local-browser-app';
    const webPort = 3127;
    await new Promise((done, reject) => { const probe = createServer(); probe.once('error', reject); probe.listen(webPort, '127.0.0.1', () => probe.close(done)); });
    child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(webPort)],
      { cwd: product, env: { ...childEnv, CONTRACT_DATA_MODE: 'mock', COMMUNITY_DATA_MODE: 'mock', WORKSITE_TIP_DATA_MODE: 'mock' },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error('LOCAL_APP_EXITED');
      try { const response = await fetch(`http://127.0.0.1:${webPort}/api/health/live`); if (response.ok) { ready = true; break; } } catch { /* startup */ }
      await new Promise(done => setTimeout(done, 500));
    }
    assert(ready, 'LOCAL_APP_NOT_READY');
    const shutdownFile = resolve(runtime, 'shutdown.flag');
    save('server.json', { url: `http://127.0.0.1:${webPort}`, shutdown_file: relative(root, shutdownFile), synthetic_only: true,
      auth_mode: 'real', conversation_mode: 'real', company_mode: 'mock', feedback_save: false });
    log({ local_browser_app_ready: `http://127.0.0.1:${webPort}`, runtime: relative(root, runtime) });
    while (!existsSync(shutdownFile) && child.exitCode === null) await new Promise(done => setTimeout(done, 500));
    assert(existsSync(shutdownFile), 'LOCAL_APP_EXITED_BEFORE_SHUTDOWN');
    child.kill();
    await new Promise(done => child.once('close', done));
  } else {
    phase = 'bundle-evaluation-worker';
    const entry = resolve(product, 'scripts/run-memory-comparison.ts');
    const outfile = resolve(runtime, 'memory-worker.mjs');
    await build({ entryPoints: [entry], outfile, absWorkingDir: product, platform: 'node', target: 'node22', format: 'esm', bundle: true, packages: 'external',
      plugins: [{ name: 'standalone-server', setup(builder) {
        builder.onResolve({ filter: /^server-only$/ }, () => ({ path: 'server-only', namespace: 'standalone' }));
        builder.onLoad({ filter: /.*/, namespace: 'standalone' }, () => ({ contents: '', loader: 'js' }));
      } }] });
    phase = 'memory-comparison';
    child = spawn(process.execPath, [outfile], { cwd: product, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { for (const line of String(chunk).split(/\r?\n/)) if (line.startsWith('MEMORY_EVAL ')) console.log(line); });
    child.stderr.resume();
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    assert.equal(code, 0, 'WORKER_FAILED');
  }
  phase = 'migration-replay';
  await migrate(drizzle(sql), { migrationsFolder: resolve(root, 'db/migrations') });
  assert.equal(Number((await sql`SELECT count(*) FROM drizzle.__drizzle_migrations`)[0].count), journal.entries.length);
  save('migration-replay.json', { unchanged: true, ledger: journal.entries.length });
} catch (error) {
  log({ phase, status: 'BLOCKED', code: typeof error?.code === 'string' ? error.code : 'CHECK_FAILED' }); process.exitCode = 2;
} finally {
  if (child && child.exitCode === null) child.kill();
  await sql?.end();
  if (created) {
    const identity = JSON.parse(docker(['inspect', name]))[0];
    assert.equal(identity.Name, `/${name}`); assert.equal(identity.Config.Labels['moneyworry.acceptance'], taskLabel);
    docker(['rm', '-f', name]); log({ removed_own_container: name });
  }
  const after = sourceHashes(); save('source-after.json', after);
  save('cleanup.json', { source_unchanged: JSON.stringify(before) === JSON.stringify(after), own_container_removed: created, phase });
  log({ finished: relative(root, runtime), source_unchanged: JSON.stringify(before) === JSON.stringify(after) });
}
