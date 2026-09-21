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

## Answer-contract evaluator (stage 2)

`answer-contract-cases.json` is a small, explicit set of answer obligations derived from the reproduced QA cases. It is intentionally separate from the 60-case routing corpus: its purpose is to evaluate the displayed final answer, not just intent fields or fixture shape.

Run a bounded live batch against a started local app (default: all registered cases, one attempt each):

```powershell
npm.cmd run eval:answer-quality
```

Use `-- --cases AQ01-selected-company-reason,AQ02-general-positive-indicator --runs 3` for the mandatory repeated checks of a changed case. Raw final answers and safe response traces are written only to the ignored `.runtime/answer-quality/` directory. The runner sends the same `Sec-Fetch-Site: same-origin` compatibility signal as the other trusted local HTTP scripts; this does not authenticate the script or prove that a real browser was used.

Each JSONL row records transport and answer quality separately:

- `request_status`: `ok`, `http_error`, `network_error`, `parse_error`, or `missing_result`.
- `contract_status`: `PASS`, `FAIL`, `ORACLE_UNCERTAIN`, or `NOT_EVALUATED`.
- `guardrail_status` appears only after a valid provider result was received. A request failure is never treated as a guardrail or answer-contract result.

The process preserves the JSONL and then exits `2` when any request/infrastructure failure occurred, `1` when all requests arrived but at least one answer contract failed, and `0` otherwise. Legal correctness and source relevance remain listed as required human/source review rather than being falsely promoted to string-match success.

The manual-QA regressions added after the 2026-09-21 review are development cases. They were used to define and repair behavior and must not be described as an independent evaluation set.

## Authenticated continuous-conversation evaluation

Fixed-history replay above is deliberately separate from real continuity. To verify server persistence and restoration, start the app against a **new isolated local PG16 database** (never production/restored data), set `ANSWER_EVAL_EMAIL` and `ANSWER_EVAL_PASSWORD` in the current shell for a local test account without printing/saving them, and set `ANSWER_EVAL_ISOLATED_PG16=1` only after confirming the app's database target. Then run:

```powershell
npm.cmd run eval:conversation-continuity
```

The continuity runner refuses non-local URLs, reads credentials only from process environment, keeps the returned `donworry_session` cookie in memory, and never writes it to its JSONL. It carries the server-returned `conversation_id` into later `/api/chat` calls with empty client history, fetches `/api/conversations/{id}` after every turn, and requires `source: "database"`. The development scenario now contains six distinct questions followed by a seventh recall **after re-login and detail restoration**, plus a final re-login/detail check. The structural limit is twelve turns, not twelve repeated trials; use at most three attempts per core case unless new evidence warrants more. This is an HTTP/storage test, not browser refresh/navigation or process-restart proof.

Rows retain allowlisted summary status/version/checkpoint and hydration counts, never summary text or prompts. Earlier successful rows survive a later blocker, and re-login verification is not marked true prematurely. Missing credentials/isolation confirmation, unavailable persistence, Mock conversation storage, response/restore mismatch, or a missing local database are `blocked` and exit `2`; contract failures exit `1`. Confirmation is an operator precondition, not automatic proof of database isolation. See `docs/qa/2026-09-21-followup-03.md` for the blocked real-DB acceptance and resumption checklist.
