# Chat answer-quality evaluation

`chat-quality-cases.json` is the shared 60-case corpus. It contains five cases for each category A-L, 24 holdout cases, multi-turn cases, expected routing, evidence fixtures, required/forbidden answer properties, and metamorphic-pair identifiers.

The corpus contract is checked by `src/services/chatQualityEvaluation.test.ts`. The opt-in real-provider intent harness is `src/services/chatIntentLive.test.ts`; use `CHAT_INTENT_EVAL_CASE_IDS` to keep live runs small. Do not treat the default skipped live suite as executed provider evidence.

## 2026-09-17 local candidate run

- Baseline: branch base `36f932f`, Mock company data, local sealed BGE-M3/Chroma, real Upstage, no Real PostgreSQL.
- Candidate: the same data/provider boundary with the changes in the working tree.
- Machine-readable core comparison: `results/chat-quality-core-2026-09-17.jsonl`.
- Deterministic product verification: 731 tests passed; 85 opt-in live tests skipped by the default suite. Typecheck and production build passed. Lint had only the existing `src/app/api/admin/batches/route.ts` unused-variable warning after the candidate cleanup.
- Python RAG verification: 27 of 28 tests passed. The one error is the known Windows writable-path semantics check; the affected test is an operating-permission gate rather than retrieval behavior. This preserved CPython 3.12.10 environment is local QA only, not the CPython 3.12.13 production-equivalent runtime.
- Direct candidate RAG check for `파이썬 코딩을 밤 10시까지 시키고 돈은 더 안 준대요`: `matched`, top distance `0.3196946382522583`, first citation `근로기준법 제56조`.
- Selected-company intent live checks: C4-C7 passed 4/4 with Upstage; the generic named-company future-claim case C8 passed 1/1. The explicit labor-plus-investment mixed request is now deterministically limited to `unclear` before provider generation.
- In the v1 snapshot, the exact Hanbit question and the neutral wage-card question produced a useful final response in six repeated local integration calls, but all six raw Upstage generations needed guardrail replacement.
- In the v8 follow-up, a company-only output contract was appended after the runtime context. The exact regression question passed raw output checks in 2/3 calls and the neutral wage-card question passed in 3/3; final user responses remained useful in 6/6. The remaining exact-question failure invented an unverified law citation and was correctly replaced, so raw generation is improved but not fully stable.
- Browser verification was not completed: the computer-use runtime exposed no browser/app surface, and both in-app-browser and Chrome session creation returned `Browser is not available`.
- GCP/deployed behavior was not changed or verified. No PR, merge, commit, or deployment was performed.

The JSONL file is a sanitized trace summary, not a raw provider log. It intentionally excludes prompts, answer bodies, credentials, request IDs, and private data.
