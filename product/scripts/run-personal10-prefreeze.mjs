/** Bounded real Upstage calls for old development regressions before Task10 candidate freeze. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { parseEnvText } from '../src/server/envText.ts';

const base = resolve('.runtime/personal10/prefreeze');
mkdirSync(base, { recursive: true });
const runtime = resolve(base, `${Date.now()}`);
mkdirSync(runtime);
const previous = readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).reduce((n,e) => {
  try { return n + readFileSync(resolve(base,e.name,'attempts.jsonl'),'utf8').trim().split('\n').filter(Boolean).length; }
  catch { return n; }
}, 0);
// One final bounded full-flow confirmation after the bank-copy parsing correction.
// The prior three immutable runs used 72 calls; this permits at most 24 more.
const totalCap = 96, currentCap = Math.min(24, totalCap - previous);
const hash = value => createHash('sha256').update(value).digest('hex');
const configured = parseEnvText(readFileSync('.env.local', 'utf8'));
let shared = {};
try { if (configured.SHARED_API_KEY_FILE) shared = parseEnvText(readFileSync(configured.SHARED_API_KEY_FILE, 'utf8')); } catch { /* presence only */ }
const key = process.env.UPSTAGE_API_KEY || configured.UPSTAGE_API_KEY || configured.Upstage_API_KEY
  || shared.UPSTAGE_API_KEY || shared.Upstage_API_KEY;
const manifest = { scope: 'Personal05 existing development regression, not Task10 holdout',
  runtime, at: new Date().toISOString(), previous_calls: previous, total_cap: totalCap,
  run_cap: currentCap, key_present: Boolean(key), node: process.version,
  source_fingerprint: JSON.parse(await (await import('node:child_process')).execFileSync(process.execPath,
    ['scripts/personal10-freeze.mjs'], { cwd: process.cwd(), encoding: 'utf8' })).source_digest_sha256,
  runner_sha256: hash(readFileSync('scripts/personal10-prefreeze.ts')) };
writeFileSync(resolve(runtime,'manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({ preflight: true, runtime, previous_calls: previous, run_cap: currentCap,
  source_fingerprint: manifest.source_fingerprint, key_present: Boolean(key) }));
if (!process.argv.includes('--live')) process.exit(0);
assert(key, 'UPSTAGE_KEY_MISSING');
assert(previous + currentCap <= totalCap, 'PREFREEZE_CUMULATIVE_CAP');
const outfile = resolve(runtime, 'worker.mjs');
await build({ entryPoints: ['scripts/personal10-prefreeze.ts'], outfile, bundle: true,
  platform: 'node', target: 'node22', format: 'esm', packages: 'external',
  plugins: [{ name: 'server-only-stub', setup(b) {
    b.onResolve({ filter: /^server-only$/ }, () => ({ path: 'server-only', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: '', loader: 'js' }));
  } }] });
const env = Object.fromEntries(['PATH','SystemRoot','TEMP','TMP','USERPROFILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env, { UPSTAGE_API_KEY: key, APP_DATA_MODE: 'mock', COMPANY_DATA_MODE: 'mock',
  CONVERSATION_DATA_MODE: 'mock', AUTH_DATA_MODE: 'mock', CHAT_EXECUTION_MODE: 'dual_api',
  UPSTAGE_API_URL: 'https://api.upstage.ai/v1/chat/completions', UPSTAGE_MODEL: 'solar-pro3',
  SKT_API_KEY: '', OPENAI_API_KEY: '', MOCK_DELAY_MS: '0',
  RAG_API_URL: 'http://127.0.0.1:59999', PROMPT_DIR: resolve('prompts'),
  MW10_PREFREEZE_RUNTIME: runtime, MW10_PREFREEZE_CAP: String(currentCap) });
const child = spawn(process.execPath, [outfile], { env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
child.stdout.pipe(process.stdout);
child.stderr.on('data', chunk => { if (String(chunk).includes('Error')) console.error('PREFREEZE_WORKER_ERROR'); });
const code = await new Promise(done => child.once('exit', done));
if (code !== 0) process.exitCode = 2;
