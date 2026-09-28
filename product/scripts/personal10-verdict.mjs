/** Apply the pre-result threshold file verbatim to reviewed evidence. */
import { readFileSync, writeFileSync } from 'node:fs';
const read = path => JSON.parse(readFileSync(path,'utf8'));
const locked = read('eval/personal10-acceptance.v1.json');
const technical = read('eval/personal10-technical-results.v1.json');
const codex = read('eval/personal10-codex-review.v1.json');
const t = locked.thresholds;
const api = technical.technical.ordinary_http_200 / technical.technical.ordinary_requests;
const gates = {
  raw_severe_errors:{observed:codex.severe.raw_ids.length,max:t.raw_severe_errors_max},
  final_severe_errors:{observed:codex.severe.final_ids.length,max:t.final_severe_errors_max},
  ordinary_request_success_rate:{observed:api,min:t.ordinary_request_success_rate_min},
  raw_usefulness_rate:{observed:codex.rates.raw_usefulness.rate,min:t.raw_usefulness_rate_min},
  final_usefulness_rate:{observed:codex.rates.final_usefulness.rate,min:t.final_usefulness_rate_min},
  memory_fidelity_rate:{observed:codex.rates.memory_fidelity.rate,min:t.memory_fidelity_rate_min},
  source_fit_rate:{observed:codex.rates.source_fit.rate,min:t.source_fit_rate_min},
};
for (const gate of Object.values(gates)) gate.pass =
  'max' in gate ? gate.observed <= gate.max : gate.observed >= gate.min;
const output = {schema:'personal10-verdict.v1',decision:'FAIL',
  candidate_acceptance:'NOT_ACCEPTED',
  set_label:'code-frozen development-unused evaluation, not independent human review',
  criteria_id:locked.id, gates,
  summary:'All seven locked quality gates fail. Product changes belong to Task 11 defect closure; subsequent reruns are regression validation, not a new untouched holdout.',
  user_review_status:'Two narrow quality judgments supplied separately; neither can reverse this overall FAIL.'};
writeFileSync('eval/personal10-verdict.v1.json',JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(output.gates));
