/** Compact read-only index of the scored rows, for human review. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const dirs = process.argv.slice(2).map(path => resolve(path));
for (const dir of dirs) {
  const rows = readFileSync(resolve(dir, 'rows.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const r of rows) console.log(JSON.stringify({ id:r.id, http:r.http_status,
    status:r.result?.status, guard:r.result?.trace?.guardrail_action,
    sources:r.result?.sources?.length ?? 0, calls:r.provider_call_numbers.length,
    final:r.result?.answer?.replace(/\s+/g, ' ').slice(0, 155) ?? null }));
}
