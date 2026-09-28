/** Local synthetic generation diagnostics. Never loads a DB or an app env file. */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

assert.equal(process.versions.node.split('.')[0], '22', 'NODE22_REQUIRED');
const mode = process.argv[2] ?? 'preflight';
assert(['preflight', 'before', 'after', 'focused'].includes(mode));
const product = process.cwd();
assert(JSON.parse(readFileSync('package.json')).name === 'donworry-integrated-prototype');
assert(readFileSync('.gitignore', 'utf8').split(/\r?\n/).includes('.runtime/'));
const base = resolve('.runtime/personal04');
mkdirSync(base, { recursive: true });
const runtime = resolve(base, `${Date.now()}-${mode}`);
mkdirSync(runtime);
const digest = value => createHash('sha256').update(value).digest('hex');
const hashes = {};
for (const folder of ['src', 'prompts', '../db/migrations']) {
  const visit = dir => { for (const item of readdirSync(dir, { withFileTypes: true })) {
    const file = resolve(dir, item.name);
    if (item.isDirectory()) visit(file);
    else if (item.isFile()) hashes[relative(product, file).replaceAll('\\', '/')] = digest(readFileSync(file));
  } };
  visit(resolve(folder));
}
writeFileSync(resolve(runtime, 'source.json'), JSON.stringify(hashes, null, 2));
const priorCalls = readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).reduce((sum, e) => {
  const count = file => { try { return readFileSync(resolve(base, e.name, file), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  return sum + Math.max(count('attempts.jsonl'), count('calls.jsonl'));
}, 0);
const baselinePath = ['after', 'focused'].includes(mode) ? resolve(process.argv[3] ?? '') : null;
if (baselinePath) {
  const within = relative(base, baselinePath);
  assert(within && !within.startsWith('..') && !within.includes(':'), 'BASELINE_MUST_BE_LOCAL_RUNTIME');
  assert.equal(JSON.parse(readFileSync(resolve(baselinePath, 'summary.json'))).rows, mode === 'after' ? 18 : 10, 'BASELINE_INCOMPLETE');
}
const manifest = { mode, node: process.version, next: JSON.parse(readFileSync('node_modules/next/package.json')).version,
  started_at: new Date().toISOString(), source_digest: digest(JSON.stringify(hashes)), prior_calls: priorCalls,
  cumulative_cap: 48, remaining_cap: 48 - priorCalls, data: 'synthetic; Mock storage/service; no DB/HTTP/browser',
  provider: 'Upstage solar-pro3 only', retry: 0, runtime: relative(product, runtime), baseline: baselinePath ? relative(product, baselinePath) : null,
  tools: Object.fromEntries(['run-personal04.mjs', 'personal04-eval.ts'].map(file => [file, digest(readFileSync(resolve('scripts', file)))])) };
writeFileSync(resolve(runtime, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest));
if (mode !== 'preflight') {
  const plannedUpperBound = mode === 'before' ? 26 : mode === 'after' ? 18 : 7;
  assert(plannedUpperBound <= 48 - priorCalls, 'INSUFFICIENT_REMAINING_SESSION_CAP');
  assert(process.env.UPSTAGE_API_KEY, 'UPSTAGE_KEY_MISSING');
  const outfile = resolve(runtime, 'worker.mjs');
  await build({ entryPoints: ['scripts/personal04-eval.ts'], outfile, platform: 'node', target: 'node22', format: 'esm', bundle: true, packages: 'external',
    plugins: [{ name: 'local-server', setup(b) {
      b.onResolve({ filter: /^server-only$/ }, () => ({ path: 'server-only', namespace: 'local' }));
      b.onLoad({ filter: /.*/, namespace: 'local' }, () => ({ contents: '', loader: 'js' }));
    } }] });
  // Allowlist the child env: no inherited DB, other provider, proxy or app credentials.
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { UPSTAGE_API_KEY: process.env.UPSTAGE_API_KEY, APP_DATA_MODE: 'mock', AUTH_DATA_MODE: 'mock',
    CONVERSATION_DATA_MODE: 'mock', COMPANY_DATA_MODE: 'mock', MOCK_DELAY_MS: '0', SHARED_API_KEY_FILE: '', RAG_API_URL: '',
    MW04_RUNTIME: runtime, MW04_MODE: mode, MW04_CAP: String(48 - priorCalls), MW04_BASELINE: baselinePath ?? '' });
  const child = spawn(process.execPath, [outfile], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout);
  // Worker errors are sanitized; never echo SDK/connection error objects.
  child.stderr.resume();
  const code = await new Promise(done => child.once('exit', done));
  assert.equal(code, 0, 'EVAL_FAILED_SEE_RUNTIME');
}
