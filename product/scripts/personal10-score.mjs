/** Codex adjudication against the frozen oracle. No provider input or product changes. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const tech = JSON.parse(readFileSync('eval/personal10-technical-results.v1.json','utf8'));
const corpus = JSON.parse(readFileSync('eval/personal10-holdout.v1.json','utf8'));
const all = [...corpus.single_turns, ...corpus.dialogues.flatMap(d=>d.steps)].map(x=>x.id);
const row = new Map(tech.row_index.map(x=>[x.id,x]));
const list = value => value.trim().split(/\s+/).filter(Boolean);
const finalFail = new Set(list(`
  S02 S03 S05 S07 S08 S09 S13 S17 S18 S19 S20
  D1T01 D1T02 D1T03 D1T04 D1T05 D1T07 D1T10 D1T11 D1T13 D1T14 D1T16 D1T17 D1T18 D1T20 D1T22 D1T23 D1T24
  D2T01 D2T03 D2T04 D2T06 D2T08 D2T09 D2T10 D2T11 D2T13 D2T14 D2T15 D2T16 D2T17 D2T18 D2T19 D2T20 D2T21 D2T22 D2T23 D2T24
`));
const rawFail = new Set(list(`S02 S03 D1T02 D1T14 D1T24 D2T09 D2T10 D2T18`));
const memoryEligible = new Set(list(`
  S19 S20 S22
  D1T01 D1T02 D1T03 D1T05 D1T06 D1T07 D1T08 D1T09 D1T10 D1T11 D1T13 D1T15 D1T16 D1T17 D1T18 D1T20 D1T21 D1T22 D1T23 D1T24
  D2T01 D2T02 D2T03 D2T04 D2T05 D2T06 D2T07 D2T08 D2T09 D2T10 D2T13 D2T14 D2T15 D2T16 D2T17 D2T18 D2T19 D2T20 D2T21 D2T22 D2T23 D2T24
`));
const memoryFail = new Set(list(`
  S19 S20
  D1T01 D1T03 D1T05 D1T07 D1T10 D1T11 D1T13 D1T16 D1T17 D1T18 D1T20 D1T22 D1T23 D1T24
  D2T01 D2T02 D2T03 D2T04 D2T05 D2T06 D2T08 D2T13 D2T14 D2T15 D2T16 D2T17 D2T18 D2T19 D2T20 D2T22 D2T23 D2T24
`));
const sourceEligible = new Set(list(`
  S01 S02 S03 S04 S05 S06 S09 S10 S11 S12 S13 S14 S15 S17 S22 S23 S24
  D1T02 D1T04 D1T06 D1T08 D1T09 D1T11 D1T14 D1T15 D1T18 D1T20 D1T21 D1T24
  D2T01 D2T02 D2T05 D2T07 D2T09 D2T10 D2T18 D2T19 D2T21
`));
const sourcePass = new Set(list(`S04 S05 S11 S14 S22 S23 S24 D1T02 D1T06 D1T11 D1T15 D2T01 D2T02 D2T07 D2T18`));
const rawSevere = new Set(list(`S02 D1T14 D1T24 D2T10`));
const finalSevere = new Set(list(`S02 S07 D1T24 D2T11`));
const rawEligible = new Set(all.filter(id=>row.get(id).provider_phases.includes('generation')
  && !['S23','S24'].includes(id)));
const finalEligible = new Set(all.filter(id=>row.get(id).http===200));
for (const [name,set,subset] of [
  ['finalFail',finalFail,finalEligible],['rawFail',rawFail,rawEligible],
  ['memoryFail',memoryFail,memoryEligible],['sourcePass',sourcePass,sourceEligible],
  ['rawSevere',rawSevere,rawEligible],['finalSevere',finalSevere,finalEligible],
]) for (const id of set) assert(subset.has(id),`${name}:${id}`);
const rate = (eligible, failures) => ({pass:eligible.size-failures.size,denominator:eligible.size,
  rate:Number(((eligible.size-failures.size)/eligible.size).toFixed(4))});
const sourceFail = new Set([...sourceEligible].filter(id=>!sourcePass.has(id)));
const byRow = all.map(id=>({ id,
  final_usefulness:finalEligible.has(id)?finalFail.has(id)?'FAIL':'PASS':'NOT_ASSESSABLE_HTTP',
  raw_usefulness:rawEligible.has(id)?rawFail.has(id)?'FAIL':'PASS':'NOT_GENERATED_OR_INJECTED',
  memory_fidelity:memoryEligible.has(id)?memoryFail.has(id)?'FAIL':'PASS':'NOT_APPLICABLE',
  source_fit:sourceEligible.has(id)?sourceFail.has(id)?'FAIL':'PASS':'NOT_APPLICABLE',
  raw_severe:rawSevere.has(id), final_severe:finalSevere.has(id) }));
const result = {
  schema:'personal10-codex-review.v1', reviewer:'Codex',
  basis:'Frozen personal10-holdout.v1 oracle and personal10-acceptance.v1; all 72 scored rows inspected. Synthetic fault raw output is excluded from raw generation quality.',
  independence:'Code-frozen development-unused set validation; not external independent human evaluation.',
  review_status:'Codex reviewed all scored rows; user reviewed only S17 and D1T19 after seeing the concrete responses and technical evidence.',
  rates:{ final_usefulness:rate(finalEligible,finalFail), raw_usefulness:rate(rawEligible,rawFail),
    memory_fidelity:rate(memoryEligible,memoryFail), source_fit:rate(sourceEligible,sourceFail) },
  severe:{raw_ids:[...rawSevere],final_ids:[...finalSevere]},
  decisive_findings:[
    {ids:['S02'],kind:'legal_timing',finding:'Raw/final answer says a wage complaint may be filed within 14 days after resignation, confusing settlement deadline with filing deadline.'},
    {ids:['S07','D2T11'],kind:'urgent_guidance',finding:'Unconscious coworker received generic wage evidence advice; worsening inability to walk was rejected as out of scope.'},
    {ids:['D1T24'],kind:'company_evidence',finding:'Raw/final answer presented two firms as having no clear warning even though the Incheon synthetic wage card has employee-decrease/turnover watch signals.'},
    {ids:['D1T10','D1T13','D2T20','D2T22'],kind:'memory',finding:'Real PostgreSQL restore/summary succeeded, but final replies failed to recall explicit corrected company facts or the arithmetic balance.'},
    {ids:['S05','D2T19'],kind:'guard_overreplacement',finding:'Guard replaced relevant raw answers with filing boilerplate or company card text, losing the current user request.'},
    {ids:['S21'],kind:'api_error',finding:'Normal error-fixture company question returned HTTP 503 before an answer; not an injected provider fault.'},
  ],
  user_review_cases:[
    {id:'S17',codex_provisional:'PASS',user_decision:'FAIL: too generic for the question',applied_to_final_usefulness:'FAIL',technical:'HTTP 200, short circuit, 0 generation, 0 sources',
      question:'Quote containing stock words but the actual request is missing pay for work hours.',
      answer_excerpt:'Record payday, actual payment and hours, then ask 1350; says no direct official source found.',
      choice_a:'Accept as minimally useful wage guidance',choice_b:'Reject as too generic for missing hours'},
    {id:'D1T19',codex_provisional:'FAIL',user_decision:'PASS: one compact question is sufficient',applied_to_final_usefulness:'PASS',applied_to_raw_usefulness:'PASS',technical:'HTTP 200, raw passed, 3 provider calls, saved in real DB',
      question:'Provide interview questions about safety training and protective equipment provision.',
      answer_excerpt:'One question asks training frequency and what protective equipment must be worn, without asking how it is provided or task-specific procedures.',
      choice_a:'Accept one compact combined question',choice_b:'Require provision and task-specific procedure questions'},
  ],
  by_row:byRow,
};
writeFileSync('eval/personal10-codex-review.v1.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({rates:result.rates,severe:result.severe}));
