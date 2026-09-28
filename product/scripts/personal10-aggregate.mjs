/** Assemble immutable Task 10 technical evidence; no provider calls. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.runtime/personal10');
const attemptPaths = [
  '1790618584798-09aef2',
  '1790618786371-8b8379',
  '1790618993951-1458bb',
].map(name => resolve(root, name));
const read = (dir, file) => JSON.parse(readFileSync(resolve(dir, file), 'utf8'));
const lines = (dir, file) => {
  try { return readFileSync(resolve(dir, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch { return []; }
};
const hash = value => createHash('sha256').update(value).digest('hex');
const attempts = attemptPaths.map((dir, index) => ({
  index: index + 1, path: dir, manifest: read(dir, 'manifest.json'),
  failure: index < 2 ? read(dir, 'runner-failure.json') : null,
  rows: lines(dir, 'rows.jsonl'), calls: lines(dir, 'provider-calls.jsonl'),
  cleanup: read(dir, 'cleanup.json'),
}));
const [setup, partial, dialogue] = attempts;
const corpus = JSON.parse(readFileSync('eval/personal10-holdout.v1.json', 'utf8'));
const frozen = read(root, 'freeze.json');
const expectedIds = [...corpus.single_turns.map(x => x.id),
  ...corpus.dialogues.flatMap(d => d.steps.map(x => x.id))];
const scoredRows = [...partial.rows.filter(x => x.id.startsWith('S')), ...dialogue.rows];
assert.equal(scoredRows.length, 72);
assert.deepEqual(scoredRows.map(x => x.id), expectedIds);
for (const attempt of attempts) {
  assert.equal(attempt.manifest.corpus_sha256, hash(readFileSync('eval/personal10-holdout.v1.json')));
  assert.equal(attempt.manifest.source_digest_sha256, frozen.source_digest_sha256);
}
const calls = attempts.flatMap(a => a.calls.map(c => ({ ...c, attempt: a.index })));
const scoredCallIds = new Set(scoredRows.flatMap(r => r.provider_call_numbers.map(n =>
  `${r.id.startsWith('S') ? 2 : 3}:${n}`)));
const scoredCalls = calls.filter(c => scoredCallIds.has(`${c.attempt}:${c.number}`));
const count = (list, fn) => list.filter(fn).length;
const group = (list, key) => Object.fromEntries([...new Set(list.map(key))].map(value =>
  [value ?? 'null', count(list, item => key(item) === value)]));
const values = (list, key) => list.map(key).filter(Number.isFinite);
const stats = list => {
  const sorted = [...list].sort((a,b) => a-b);
  if (!sorted.length) return { count:0, mean:null, p50:null, p95:null, max:null };
  const at = p => sorted[Math.ceil(p*sorted.length)-1];
  return { count:sorted.length, mean:Math.round(sorted.reduce((a,b)=>a+b,0)/sorted.length),
    p50:Math.round(at(.5)), p95:Math.round(at(.95)), max:Math.round(sorted.at(-1)) };
};
const usage = list => ({ prompt_tokens:list.reduce((n,c)=>n+(c.usage?.prompt_tokens ?? 0),0),
  completion_tokens:list.reduce((n,c)=>n+(c.usage?.completion_tokens ?? 0),0),
  total_tokens:list.reduce((n,c)=>n+(c.usage?.total_tokens ?? 0),0),
  reported_calls:count(list,c=>c.usage?.total_tokens!=null),
  missing_usage_calls:count(list,c=>c.usage?.total_tokens==null) });
const actualExternal = calls.filter(c => !c.injected_fault);
const ordinary = scoredRows.filter(r => !r.planned_fault);
const checkpoint = read(dialogue.path, 'checkpoints.json');
const output = {
  schema:'personal10-technical-results.v1',
  evaluated_at:dialogue.manifest.finished_at,
  candidate:{ head:frozen.head, branch:frozen.branch, product_status:frozen.product_status,
    source_digest_sha256:frozen.source_digest_sha256, file_count:frozen.file_count,
    build_id:dialogue.manifest.build_id, node:dialogue.manifest.node,
    next:dialogue.manifest.next, postgres:dialogue.manifest.postgres,
    migration_ledger_count:dialogue.manifest.migration_ledger_count,
    provider:dialogue.manifest.provider, model:dialogue.manifest.model,
    app_data_mode:dialogue.manifest.app_data_mode, company_data_mode:dialogue.manifest.company_data_mode,
    rag_mode:dialogue.manifest.rag_mode, execution_mode:dialogue.manifest.execution_mode },
  frozen_inputs:{ corpus_sha256:partial.manifest.corpus_sha256,
    acceptance_sha256:partial.manifest.acceptance_sha256,
    corpus_items:expectedIds.length, single_turns:24, dialogues:2, dialogue_turns:[24,24] },
  attempts:attempts.map(a=>({ number:a.index, runtime:a.manifest.runtime,
    segment:a.manifest.segment ?? 'setup', rows:a.rows.length, proxy_calls:a.calls.length,
    runner_failure:a.failure?.message ?? null,
    status:a.failure ? 'INVALID_RUNNER_PARTIAL' : 'COMPLETE',
    synthetic_account_delete_200:a.cleanup.synthetic_account_delete_200,
    tmpfs_stopped:a.cleanup.user_data_retained_after_container_stop===false })),
  invalidation:{ setup_attempt_1:'0 rows, signup fixture exceeded password length; 0 calls',
    partial_attempt_2:'D1T01-D1T16 excluded from scored dialogue because Windows signalCode was misread at planned restart; all 40 original rows and 70 calls preserved',
    unaffected_singles:'S01-S24 from attempt 2 retained',
    scored_dialogues:'D1T01-D2T24 from new attempt 3; both restarted from turn 1' },
  technical:{
    scored_rows:scoredRows.length, http_200:count(scoredRows,r=>r.http_status===200),
    ordinary_requests:ordinary.length, ordinary_http_200:count(ordinary,r=>r.http_status===200),
    ordinary_http_failures:ordinary.filter(r=>r.http_status!==200).map(r=>({id:r.id,status:r.http_status})),
    planned_fault_rows:scoredRows.filter(r=>r.planned_fault).map(r=>({id:r.id,fault:r.planned_fault,http:r.http_status})),
    authenticated_saved_db:count(scoredRows,r=>r.scope!=='frozen_history'&&r.conversation_persistence==='saved'&&r.storage?.source==='database'),
    frozen_history_guest_rows:count(scoredRows,r=>r.scope==='frozen_history'),
    guard_actions:group(scoredRows,r=>r.result?.trace?.guardrail_action ?? 'no_result'),
    scored_provider_phase_calls:group(scoredCalls,c=>c.phase),
    scored_generation_rows:count(scoredRows,r=>r.provider_phases.includes('generation')),
    scored_no_generation_rows:count(scoredRows,r=>!r.provider_phases.includes('generation')),
    scored_zero_provider_rows:count(scoredRows,r=>r.provider_call_numbers.length===0),
    dialogue_generation_rows:corpus.dialogues.map(d=>({id:d.id,
      count:count(dialogue.rows.filter(r=>r.id.startsWith(d.id)),r=>r.provider_phases.includes('generation'))})),
    relogin_restore_checkpoints:count(checkpoint,c=>c.type==='relogin_restore'&&c.source==='database'&&c.turns===c.expected_turns),
    app_restart_checkpoints:count(checkpoint,c=>c.type==='app_restart'),
    summary_checkpoints:checkpoint.filter(c=>c.dialog).map(c=>({dialog:c.dialog,at:c.at,
      db_turns:c.turns,summary_status:c.memory?.summary_status,
      summarized_through_sequence:c.memory?.summarized_through_sequence,
      recall_fact_count:c.memory?.recall_fact_count})),
    scored_row_latency_ms:stats(values(scoredRows,r=>r.duration_ms)),
    scored_provider_call_latency_ms:stats(values(scoredCalls,c=>c.duration_ms)),
  },
  all_attempt_usage:{ proxy_calls:calls.length, actual_external_provider_calls:actualExternal.length,
    synthetic_fault_calls:count(calls,c=>Boolean(c.injected_fault)),
    actual_external_http_200:count(actualExternal,c=>c.status===200),
    actual_external_failures:actualExternal.filter(c=>c.status!==200).map(c=>({attempt:c.attempt,number:c.number,status:c.status})),
    phase_calls:group(calls,c=>c.phase), returned_model:group(actualExternal,c=>c.model),
    finish_reasons:group(actualExternal,c=>c.finish_reason), tokens:usage(calls),
    call_latency_ms:stats(values(calls,c=>c.duration_ms)),
    automatic_retries_detected:count(scoredRows,r=>new Set(r.provider_phases).size<r.provider_phases.length),
    billed_amount:null, ttft_ms:null },
  row_index:scoredRows.map(r=>({id:r.id,scope:r.scope,http:r.http_status,
    status:r.result?.status ?? null,guard:r.result?.trace?.guardrail_action ?? null,
    source_count:r.result?.sources?.length ?? 0,
    provider_phases:r.provider_phases,provider_call_count:r.provider_call_numbers.length,
    storage:r.storage?.source ?? null,duration_ms:Math.round(r.duration_ms),
    final_sha256:r.result?.answer ? hash(r.result.answer) : null})),
};
writeFileSync('eval/personal10-technical-results.v1.json', JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({scored:output.technical.scored_rows,
  ordinary_success:`${output.technical.ordinary_http_200}/${output.technical.ordinary_requests}`,
  all_calls:output.all_attempt_usage.proxy_calls,external:output.all_attempt_usage.actual_external_provider_calls,
  returned_tokens:output.all_attempt_usage.tokens.total_tokens,
  dialogue_generation:output.technical.dialogue_generation_rows}));
