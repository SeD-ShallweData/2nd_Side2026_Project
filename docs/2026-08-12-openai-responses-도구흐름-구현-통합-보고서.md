# OpenAI Responses 도구 흐름 구현·통합 보고서

- 문서 상태: Final
- 작성·검증일: 2026-08-12 (Asia/Seoul)
- 원 구현 브랜치: `feat/responses-tooling-y1oo5b`
- 원 구현 커밋: `4694ee6`
- 최신 팀 기준: `origin/main` `feeb627` (PR #10 병합본)
- 재배치된 기능 커밋: `9cf14b0`
- 원격 게시 브랜치: `origin/feat/responses-tooling-y1oo5b`
- 대상 PR: 아직 생성하지 않음
- 기본 실행 모드: `dual_api`

이 문서는 최신 배치 선택 결함 보완부터 OpenAI Responses tool 실행, 기존 Upstage/SKT 호환, 테스트와 운영 준비까지의 구현 결과와 최신 팀 코드 통합 검증을 기록한다. 비밀값, DB 비밀번호, 계약서 원문은 기록하지 않는다.

## 1. 결과 요약

요청한 구현 1~8은 모두 완료됐다. 기존 Upstage/SKT 이중 모델 흐름은 기본값으로 보존하고, OpenAI Responses 흐름은 feature flag로만 활성화한다. 팀원이 먼저 구현한 최신 배치 정렬, RAG 생활어 확장, UI·정책 개선은 제거하거나 재작성하지 않고 기준 구현으로 유지했다.

공식 최신 `origin/main` 위에 기능 커밋을 재적용한 결과 텍스트 충돌은 없었다. 동일 통합 tree에서 웹 전체 검사 265개가 통과했고, 현재 공유 서버에서 작업 중인 `feat/ui-rag-rebuild`까지 추가한 시나리오에서도 268개 테스트와 production build가 통과했다.

다만 아직 `main`에 병합되지 않은 `feat/chat-prompt-rebuild`와는 프롬프트·인용 가드레일 두 파일에서 실제 충돌이 예상된다. 이 브랜치가 먼저 병합되면 PR 병합 전에 다시 rebase하고 두 의미를 수동 결합해야 한다.

운영 PostgreSQL은 애플리케이션 실행과 별개로 migration ledger drift 상태다. `0006`, `0007`의 schema 객체는 있으나 ledger 행이 없고 `0008`은 적용 대기이므로, 현 DB에 `npm run migrate`를 직접 실행해서는 안 된다.

## 2. 최신 팀 코드 동기화 및 충돌 검증

### 2.1 동기화 전후

2026-08-12 17:00 KST에 원격 refs를 다시 가져왔다.

| 항목 | 확인 결과 |
| --- | --- |
| 공식 최신 기준 | `origin/main` `feeb627` |
| 포함된 팀 작업 | PR #8 평가 도구, PR #9 정책 분기, PR #10 통합 UI·RAG |
| 과거 통합 브랜치 | `origin/feat/combine-prototypes`는 PR #10 병합 후 삭제됨 |
| 개인 브랜치 동기화 전 | `4694ee6`, main보다 1 ahead / 8 behind |
| 개인 브랜치 동기화 후 | `9cf14b0`, main보다 1 ahead / 0 behind |
| 원격 동명 브랜치 | 최초 push 전에는 존재하지 않았음 |
| 작업트리 | rebase 전후 clean |

단순 `git pull`은 사용하지 않았다. 개인 worktree에서 `git fetch --prune origin`으로 원격 상태만 갱신하고, 임시 worktree에서 통합과 테스트를 먼저 재현한 뒤 개인 브랜치를 `origin/main` 위로 rebase했다.

### 2.2 서버에서 실제 사용 중인 코드

공식 배포·PR 기준은 `origin/main`이지만, 공유 서버의 주 작업 clone은 감사 시점에 다음 상태였다.

```text
/data/shared-SeD/jcu0304/2nd_Side2026_Project
branch: feat/ui-rag-rebuild
HEAD:   b206458
```

이 브랜치는 `main`보다 2커밋 앞선 미병합 작업이다. 다른 팀원의 `feat/chat-prompt-rebuild`도 `main`보다 3커밋 앞서지만 두 브랜치는 서로 갈라져 있어 어느 하나를 “전체 팀 최신본”이라고 볼 수 없다. 따라서 개인 브랜치의 기준은 공식 `main`으로 삼고, 서버 작업 브랜치는 별도 호환 시나리오로 검사했다.

오래된 다른 공유 clone들은 뒤처져 있거나 팀원의 미커밋 파일을 포함하므로 동기화·push 작업에 사용하지 않았다.

### 2.3 통합 시나리오 결과

| 시나리오 | 결과 | 검증 |
| --- | --- | --- |
| `origin/main` + Responses 기능 | 충돌 없음 | 24 test files / 265 tests, typecheck, lint, build 통과 |
| 위 조합 + `feat/ui-rag-rebuild` | 충돌 없음 | 25 test files / 268 tests, typecheck, lint, build 통과 |
| 위 조합 + `feat/chat-prompt-rebuild` | 실제 충돌 2개 | `system.md`, `guardrails.ts` 수동 병합 필요 |

현재 `main`과 우리 기능이 함께 수정한 파일은 `product/src/app/globals.css` 하나였고 수정 구간이 달라 자동 병합됐다. 서버 UI 브랜치는 `api-contract.md`, `HttpRagRetriever.ts`, `MlRiskProvider.ts`, `globals.css`, `ChatPanel.tsx` 등과 겹쳤지만 모두 자동 병합됐으며 전체 검사를 통과했다.

프롬프트 브랜치가 먼저 병합될 경우 다음 원칙으로 해결한다.

1. 팀 브랜치의 새 company context, no-match 응답, 미수록 법령 및 공식 안내 인용 검증을 기준으로 유지한다.
2. Responses 구현의 `review_contract` finding별 `legal_basis` 허용 범위를 추가한다.
3. `contractLaw` alias 정규화와 축약형 법령명 우회 방지를 유지한다.
4. 두 파일에서 한쪽 버전을 통째로 선택하지 않고 관련 회귀 테스트를 함께 실행한다.

### 2.4 중복 구현 보존 판단

| 영역 | 팀 선행 구현 | 이번 작업의 순증분 | 최종 판단 |
| --- | --- | --- | --- |
| 최신 배치 | 네 조회 경로에서 기준일·적재시각·ID 정렬 | 공통 SQL, null 제외, 4개 회귀 테스트, DB view용 `0008` | 팀 의미를 유지하고 공통화·DB 계약만 보완 |
| RAG 생활어 | query expansion과 제품 평가셋 | 기존 RAG service를 tool로 재사용, TS 응답 검증·취소 전달 | Python RAG 구현은 팀 버전을 유지 |
| 계약 검토 | 전용 화면, API, 실제 provider | 요청별 파일 문맥을 가진 `review_contract` tool과 응답 검증 | 기존 API를 삭제하지 않고 tool 경로 추가 |
| UI | 통합 UI와 정책 개선 | Responses 단일 결과, tool trace, 계약 파일 첨부 | 양쪽 기능 유지 |
| CI | Product web + RAG workflow | DB migration + contract workflow | 경로와 역할이 달라 둘 다 유지 |
| Responses | 선행 구현 없음 | schema, dispatcher, client, runner, flag 전체 | 이번 구현 유지 |

`git cherry origin/main HEAD`에서도 Responses 기능과 patch-equivalent인 팀 커밋은 발견되지 않았다.

## 3. 구현 1~8

| 단계 | 구현 결과 | 주요 경계 | 검증 |
| --- | --- | --- | --- |
| 1 | 최신 batch 결정성 통일 | `product/src/server/latestBatchSql.ts`, DB migration `0008` | 소비 경로 4개 회귀 테스트 |
| 2 | 기존 Repository/service 기반 handler 경계 | 회사 검색·위험·RAG·계약 service 주입 | handler unit test |
| 3 | 네 tool strict schema | `toolContracts.ts`, `toolDefinitions.ts`, `toolArguments.ts` | schema와 exact-key test |
| 4 | allowlist dispatcher | `toolDispatcher.ts` | 미등록 tool, 크기, 오류 정제 test |
| 5 | Responses 반복 실행 | `responsesClient.ts`, `responsesRunner.ts` | call ID, reasoning, output roundtrip test |
| 6 | 기존 dual 흐름과 feature flag | `chatExecutionService.ts`, `/api/chat`, `ChatPanel` | dual·Responses 분기 test |
| 7 | 단위·통합·wire E2E | Vitest, RAG, contract, PostgreSQL, fake Responses | 아래 검증 표 참조 |
| 8 | CI·운영·배포 준비 | drift 검사, 런북, env 권한 검사, live smoke | read-only 운영 DB 검사 |

### 3.1 최신 배치 선택

제품 조회는 공통적으로 다음 의미를 사용한다.

```sql
WHERE as_of_date IS NOT NULL
ORDER BY as_of_date DESC, ingested_at DESC, id DESC
LIMIT 1
```

팀 코드에 이미 들어 있던 정렬 의미를 제거하지 않고 `LATEST_BATCH_ORDER_SQL`로 공통화했다. `RealCompanyRepository`, `MlRiskProvider`, 감독관 overview/detail 네 경로가 같은 기준을 쓰는지 테스트한다.

DB의 `v_current_batch`도 같은 기준일에 여러 모델 batch가 있을 때 결과가 결정적이도록 `0008_deterministic_current_batch.sql`을 추가했다. 기존 `0007` migration은 수정하지 않았다.

### 3.2 Tool handler 경계

새 tool 계층은 데이터 접근을 다시 구현하지 않는다.

- `search_company` → 기존 회사 검색 service
- `get_company_risk` → 기존 위험 조회 service
- `retrieve_labor_law` → 기존 RAG service
- `review_contract` → 기존 계약 검토 service

`get_company_risk`는 요청 문맥에서 선택한 회사와 같은 ID만 허용한다. 검색 결과 첫 회사를 모델이 임의로 선택할 수 없다. 계약 파일은 모델 인자가 아니라 요청 수명 내 `ToolExecutionContext`에서 주입된다.

### 3.3 Tool 입출력 계약

네 tool은 flat Responses function schema를 사용한다. 모든 필드는 명시적으로 required이며 `additionalProperties: false`, `strict: true`다.

```text
search_company({ query, limit })
get_company_risk({ company_id })
retrieve_labor_law({ query })
review_contract({ document_ref: "current_upload" })
```

JSON으로 `File`, 로컬 경로, base64 본문을 넘기지 않는다. 계약 upload가 없는 요청에는 `review_contract` definition 자체를 제공하지 않는다.

### 3.4 Dispatcher

dispatcher는 등록된 이름만 실행하며 다음 경계를 적용한다.

- 인자 최대 16 KiB
- 결과 최대 128 KiB
- exact-key runtime 검증
- 내부 예외·비밀값 정제
- 회사 선택 문맥 검증
- 계약 파일 문맥 검증
- 계약 검토 run당 1회 제한
- RAG·계약 adapter로 요청 취소 신호 전달

tool 실행이 실패했는데 모델이 성공했다고 주장해도 전체 결과를 성공으로 반환하지 않는다.

### 3.5 OpenAI Responses 반복 실행

반복 구조는 다음과 같다.

```text
Responses 요청
→ response.output에서 function_call 수집
→ allowlist dispatcher 실행
→ call_id가 같은 function_call_output 생성
→ 이전 response.output 전체와 함께 재요청
→ function_call이 없을 때 최종 output_text 반환
```

reasoning item을 재구성하지 않고 원본 output 전체를 다음 input으로 되돌린다. raw REST 응답에서 모든 assistant message의 `output_text`를 안전하게 결합하며, refusal·timeout·사용자 취소·중복 call ID·최대 라운드·사용량 합산을 처리한다.

계약 파일이 있는 첫 라운드는 `review_contract`를 강제하고 이후에는 `auto`로 돌아간다. 업로드가 있는데 계약 tool이 실행되지 않으면 정책 fallback 처리한다.

### 3.6 기존 Upstage/SKT 호환

기본 실행은 계속 다음과 같다.

```env
CHAT_EXECUTION_MODE=dual_api
```

Responses는 명시적으로만 활성화한다.

```env
CHAT_EXECUTION_MODE=openai_responses
OPENAI_API_KEY=...
OPENAI_RESPONSES_MODEL=...
```

기존 `ChatComparisonResponse` wrapper를 보존하고 Responses 결과는 `results` 한 건으로 매핑한다. UI는 단일 결과일 때 비교·동률 피드백을 숨기고 tool trace와 계약 첨부 상태를 표시한다. 실패 시 환경변수를 `dual_api`로 되돌리면 기존 흐름으로 rollback할 수 있다.

### 3.7 법령 인용과 계약 결과

RAG가 반환한 citation과 계약 finding의 `legal_basis`를 실행 ledger에 수집한다. 계약 법률명 축약형은 canonical 이름으로 정규화하고, 검색·계약 결과에 없는 조문을 최종 답변이 인용하면 기존 가드레일이 결과를 교체한다.

### 3.8 운영 산출물

- `db/scripts/check-migration-drift.mjs`: ledger와 schema 후조건을 읽기 전용으로 검사
- `db/docs/MIGRATION_OPERATIONS.md`: drift 복구 원칙
- `infra/OPERATIONS.md`: 종료 전 PostgreSQL dump, RAG archive, 복원 검증
- `product/scripts/check-env-permissions.mjs`: env 파일 권한만 검사
- `product/scripts/openai-responses-live-smoke.mjs`: 명시적 opt-in 실제 API smoke
- `.github/workflows/ci.yml`: DB·contract CI
- 기존 `.github/workflows/product-ci.yml`: 팀의 web·RAG CI로 그대로 유지

## 4. 검증 결과

### 4.1 원 구현 커밋 검증

| 검증 | 결과 |
| --- | --- |
| Vitest | 23 files / 251 tests PASS |
| TypeScript | PASS |
| ESLint | PASS |
| Next production build | PASS |
| RAG 정책 unit | 7/7 PASS |
| Contract API compile | PASS |
| Migration drift 판정 unit | PASS |
| Wire E2E | PASS |
| 실제 OpenAI API | SKIP — key와 model 미설정 |

Wire E2E에서는 실제 PostgreSQL, 실제 RAG, 실제 contract API를 사용했다. OpenAI endpoint만 비용과 credential 부재 때문에 protocol 검증용 fake raw Responses server를 사용했다. 최신 배치 `2026-06`, 회사 위험, 검색 후보, 회사 선택 불일치 차단, RAG citation, 미등록 tool 차단, 계약 finding을 검증했다.

### 4.2 최신 팀 코드 통합 후 검증

| 기준 tree | Vitest | TypeScript | ESLint | Next build |
| --- | ---: | --- | --- | --- |
| `origin/main feeb627` + 기능 commit | 24 files / 265 tests | PASS | PASS | PASS |
| 위 tree + `feat/ui-rag-rebuild b206458` | 25 files / 268 tests | PASS | PASS | PASS |

임시 통합 commit과 실제 rebase 후 기능 commit의 Git tree SHA가 동일함을 확인했다. 따라서 임시 worktree에서 검사한 265-test 결과는 최종 재배치된 기능 tree와 같은 소스 상태에 대한 결과다.

정책 코퍼스는 117개 중 허용된 known mismatch 두 건을 제외한 현재 gate를 통과했다. 이 known mismatch는 Responses 작업이 새로 만든 것이 아니라 팀 정책 평가의 기존 상태다.

### 4.3 실제 OpenAI smoke

서버 환경에는 감사 시점에 `OPENAI_API_KEY`, `OPENAI_RESPONSES_MODEL`이 없었다. 따라서 실제 유료 OpenAI 호출은 실행하지 않았다.

```bash
RUN_OPENAI_LIVE_E2E=1 npm run test:e2e:openai-live
```

기본 실행은 네트워크 호출 없이 SKIP하며, opt-in 실행은 상태 API의 Responses readiness, 실제 회사 ID, `get_company_risk`, source와 trace를 확인한다.

## 5. DB migration 및 배포 상태

2026-08-12 운영 PostgreSQL을 read-only session과 read-only transaction으로 검사한 결과다.

```text
상태: schema_ahead_of_ledger — DEPLOY BLOCKED
로컬 journal: 9개
DB ledger: 6개 (0000~0005 일치)
0006 schema 후조건: 7/7 존재
0007 schema 후조건: 7/7 존재
0008: 적용 대기
```

이 상태는 제품 read-only 조회를 막는다는 뜻이 아니라 자동 migration을 막아야 한다는 뜻이다. `0006`의 비멱등 rename 등을 다시 실행할 수 있으므로 현 DB에서 `npm run migrate`를 실행하지 않는다.

안전한 순서는 다음과 같다.

1. PostgreSQL dump와 RAG archive를 외부 저장소에 확보한다.
2. 별도 staging DB에서 restore를 검증한다.
3. `0006`, `0007` schema를 독립 확인한다.
4. migration ledger reconciliation 방식을 리뷰한다.
5. `0008`을 staging에 적용하고 view tie-breaker를 확인한다.
6. read-only drift 검사 결과가 aligned인지 확인한다.
7. 운영 적용과 rollback을 진행한다.

상세 절차는 [DB migration 운영 문서](../db/docs/MIGRATION_OPERATIONS.md)와 [인프라 운영 문서](../infra/OPERATIONS.md)를 따른다.

## 6. 보안·운영상 확인사항

요청에 따라 권한은 구현 완료 후 정리 대상으로만 기록했고 파일 mode를 변경하지 않았다.

| 파일 | 감사 당시 mode | 판정 |
| --- | ---: | --- |
| `/data/shared-SeD/.env.local` | `0640` | 정상 |
| `/data/shared-SeD/api_key.env` | `0644` | 경고 |
| 공유 clone root `.env.local` | `0666` | 경고 |
| 공유 clone `product/.env.local` | `0666` | 경고 |

비밀값은 읽거나 문서에 기록하지 않았다. 서버 종료 전에는 credential을 배포 환경 secret store에 다시 등록하고 공유 파일의 키를 회전하는 것이 권장된다.

복구용 `stash@{0}` (`codex-responses-integration-backup`)은 원 구현 백업으로 남아 있다. 원격 push와 PR 검토가 끝난 뒤 명시적으로 제거할 수 있다.

## 7. Git 게시 및 인계

게시 대상은 개인 기능 브랜치뿐이다.

```text
origin/feat/responses-tooling-y1oo5b
```

- `main` 직접 push 없음
- force push 없음
- 공유 clone 변경 없음
- 원 구현 commit `4694ee6`은 reflog와 stash 기준으로 보존
- 재배치된 기능 commit `9cf14b0`이 최신 `main` 바로 위에 위치
- 이 보고서와 `docs/README.md` 링크도 같은 기능 브랜치에 포함

PR을 만들기 직전에는 다시 `git fetch origin`을 실행한다. `main`이 전진했으면 rebase와 전체 검사를 반복한다. 특히 `feat/chat-prompt-rebuild`가 먼저 병합됐다면 앞에서 설명한 두 파일을 수동 결합한다.

## 8. 남은 작업 권장 순서

1. 원격 기능 브랜치에서 PR 생성 및 팀 리뷰
2. 미병합 prompt/UI 브랜치의 선행 병합 여부 확인
3. 필요 시 최신 `main` rebase와 충돌 회귀 테스트
4. 운영 PostgreSQL·RAG 외부 백업과 restore 리허설
5. migration ledger reconciliation 검토
6. staging에서 `0008` 적용 및 drift aligned 확인
7. 배포 secret 등록과 env 권한 정리
8. 제한된 실제 OpenAI live smoke
9. 핵심 회사 검색·위험·RAG·계약·Responses smoke 후 운영 전환

## 9. 주요 문서와 코드

- [제품 아키텍처](../product/docs/system-architecture.md)
- [API 계약](../product/docs/api-contract.md)
- [배포 가이드](../product/docs/deployment-guide.md)
- [Tool definitions](../product/src/server/responses/toolDefinitions.ts)
- [Tool dispatcher](../product/src/server/responses/toolDispatcher.ts)
- [Responses client](../product/src/server/responses/responsesClient.ts)
- [Responses runner](../product/src/server/responses/responsesRunner.ts)
- [Responses chat service](../product/src/services/responsesChatService.ts)
- [최신 batch SQL](../product/src/server/latestBatchSql.ts)
- [DB migration 운영](../db/docs/MIGRATION_OPERATIONS.md)
- [종료·백업 운영 절차](../infra/OPERATIONS.md)

## 10. 공식 참고자료

- [OpenAI function calling guide](https://developers.openai.com/api/docs/guides/function-calling)
