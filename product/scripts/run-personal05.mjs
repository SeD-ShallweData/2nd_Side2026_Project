/** Synthetic development diagnostics only; no app env or DB connections. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
assert.equal(process.versions.node.split('.')[0], '22');
const mode = process.argv[2] ?? 'preflight';
assert(['preflight', 'diagnostic', 'fixed'].includes(mode));
const base = resolve('.runtime/personal05'); mkdirSync(base, { recursive: true });
const runtime = resolve(base, `${Date.now()}-${mode}`); mkdirSync(runtime);
const files = {};
function visit(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) {
  const file = resolve(dir, entry.name); if (entry.isDirectory()) visit(file);
  else if (entry.isFile()) files[relative(process.cwd(), file).replaceAll('\\','/')] = createHash('sha256').update(readFileSync(file)).digest('hex');
} }
for (const dir of ['src','prompts','../db/migrations']) visit(resolve(dir));
const count = (dir, file) => { try { return readFileSync(resolve(dir,file),'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
const used = readdirSync(base,{withFileTypes:true}).filter(x=>x.isDirectory()).reduce((n,x)=>n+Math.max(count(resolve(base,x.name),'calls.jsonl'),count(resolve(base,x.name),'provider-calls.jsonl'),count(resolve(base,x.name),'attempts.jsonl')),0);
writeFileSync(resolve(runtime,'source.json'),JSON.stringify(files,null,2));
writeFileSync(resolve(runtime,'manifest.json'),JSON.stringify({ mode, started_at:new Date().toISOString(), node:process.version, previous_calls:used, total_cap:72, source_digest:createHash('sha256').update(JSON.stringify(files)).digest('hex') },null,2));
console.log(JSON.stringify({ mode, runtime, previous_calls:used, total_cap:72 }));
if(mode !== 'preflight') {
  assert(used+8<=72,'BUNDLE_CALL_CAP'); assert(process.env.UPSTAGE_API_KEY);
  const out=resolve(runtime,'worker.mjs');
  await build({entryPoints:['scripts/personal05-diagnostic.ts'],outfile:out,bundle:true,platform:'node',target:'node22',format:'esm',packages:'external',plugins:[{name:'standalone',setup(b){b.onResolve({filter:/^server-only$/},()=>({path:'server-only',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'',loader:'js'}));}}]});
  const env=Object.fromEntries(['PATH','SystemRoot','TEMP','TMP','USERPROFILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  Object.assign(env,{UPSTAGE_API_KEY:process.env.UPSTAGE_API_KEY,APP_DATA_MODE:'mock',COMPANY_DATA_MODE:'mock',CONVERSATION_DATA_MODE:'mock',MOCK_DELAY_MS:'0',MW05_RUNTIME:runtime,MW05_MODE:mode});
  const child=spawn(process.execPath,[out],{env,windowsHide:true,stdio:['ignore','pipe','pipe']}); child.stdout.pipe(process.stdout); child.stderr.resume();
  assert.equal(await new Promise(done=>child.once('exit',done)),0,'DIAGNOSTIC_FAILED');
}
