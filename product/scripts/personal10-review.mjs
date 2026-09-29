/** Read-only worksheet for a completed Task 10 run. Never sends oracle to a provider. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const runtime = resolve(process.argv[2] ?? '');
const start = Number(process.argv[3] ?? 0);
const end = Number(process.argv[4] ?? 999);
const lines = name => readFileSync(resolve(runtime, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const rows = lines('rows.jsonl');
const calls = lines('provider-calls.jsonl');
const corpus = JSON.parse(readFileSync('eval/personal10-holdout.v1.json', 'utf8'));
const items = [...corpus.single_turns, ...corpus.dialogues.flatMap(x => x.steps)];
for (const [index, row] of rows.entries()) {
  if (index < start || index >= end) continue;
  const item = items.find(x => x.id === row.id);
  const raw = calls.filter(x => row.provider_call_numbers.includes(x.number) && x.phase === 'generation').at(-1);
  console.log(JSON.stringify({ index, id: row.id, category: item?.category,
    message: item?.message, oracle: item?.oracle,
    http: row.http_status, storage: row.storage, duration_ms: row.duration_ms,
    phases: row.provider_phases, guard: row.result?.trace?.guardrail_action,
    hits: row.result?.trace?.guardrail_hits,
    sources: row.result?.sources,
    raw: raw?.raw_answer ?? null, final: row.result?.answer ?? null }));
}
