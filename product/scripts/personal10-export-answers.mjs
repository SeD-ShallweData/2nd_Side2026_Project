/** Export only synthetic scored answers, without sessions, keys, requests or prompt payloads. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const partial = resolve(process.argv[2] ?? '.runtime/personal10/1790618786371-8b8379');
const dialogue = resolve(process.argv[3] ?? '.runtime/personal10/1790618993951-1458bb');
const lines = (dir,name) => readFileSync(resolve(dir,name),'utf8').trim().split('\n').map(JSON.parse);
const sets = [
  {attempt:2, rows:lines(partial,'rows.jsonl').filter(r=>r.id.startsWith('S')), calls:lines(partial,'provider-calls.jsonl')},
  {attempt:3, rows:lines(dialogue,'rows.jsonl'), calls:lines(dialogue,'provider-calls.jsonl')},
];
const output = sets.flatMap(({attempt,rows,calls}) => rows.map(r => {
  const generation = calls.filter(c=>r.provider_call_numbers.includes(c.number)&&c.phase==='generation').at(-1);
  return { id:r.id, attempt, scope:r.scope, message:r.request.message,
    http_status:r.http_status, result_status:r.result?.status ?? null,
    raw_answer:generation?.injected_fault?null:generation?.raw_answer ?? null,
    synthetic_fault_raw:generation?.injected_fault?generation?.raw_answer ?? null:null,
    final_answer:r.result?.answer ?? null,
    guard_action:r.result?.trace?.guardrail_action ?? null,
    guard_hits:r.result?.trace?.guardrail_hits ?? [],
    sources:(r.result?.sources ?? []).map(s=>({name:s.name,url:s.url ?? null,as_of:s.as_of ?? null,category:s.category ?? null})),
    provider_phases:r.provider_phases,provider_call_count:r.provider_call_numbers.length,
    generation_finish_reason:generation?.finish_reason ?? null,
    generation_usage:generation?.usage ?? null,
    storage_source:r.storage?.source ?? null,duration_ms:Math.round(r.duration_ms) };
}));
assert.equal(output.length,72);
assert.equal(new Set(output.map(x=>x.id)).size,72);
writeFileSync('eval/personal10-answers.v1.jsonl',output.map(x=>JSON.stringify(x)).join('\n')+'\n');
console.log(JSON.stringify({rows:output.length,raw_answers:output.filter(x=>x.raw_answer).length,
  injected_raw:output.filter(x=>x.synthetic_fault_raw).length,
  final_answers:output.filter(x=>x.final_answer).length}));
