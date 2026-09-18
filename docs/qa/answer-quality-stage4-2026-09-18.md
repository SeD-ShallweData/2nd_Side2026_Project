# 단계 4 답변 구조 개선 결과

작성일: 2026-09-18  
브랜치: `task/reply-prompt-upgrade`  
기준 커밋: `8698a6d` + 미커밋 단계 3/4 변경

## 변경

- `AnswerPlan`을 추가해 현재 질문을 `labor`, `company_specific`, `company_general`, `out_of_scope`, `clarification` 부분으로 해석한다.
- 명시적인 노동+투자/추천 복합 요청은 기존 분류가 `unclear` 또는 `off_topic`이어도 노동 부분을 유지하고, 투자 실행 요청만 범위 밖으로 제한한다.
- 선택한 회사가 있으면 분류기의 `company/general` 결과보다 회사별 공개 자료 경로를 우선한다. 회사가 선택되지 않은 일반 지표 질문만 일반 설명으로 short circuit한다.
- 노동법 RAG 결과를 `ready`, `not_found`, `not_relevant`, `unavailable`으로 바꿔 fallback과 trace를 구분한다.
  - `not_found` → `RAG_EVIDENCE_NOT_FOUND`
  - `not_relevant` → `RAG_EVIDENCE_NOT_RELEVANT`
  - `unavailable` → `RAG_UNAVAILABLE`
- 복합 요청의 생성 컨텍스트에는 노동 부분을 먼저 답하고 투자·매수·추천은 제한하도록 명시한다. 생성/가드레일 교체 시에도 근로기록·1350 안내와 범위 경계를 보존한다.

## 실제 `/api/chat` 반복 결과

| 계약 | 실행 | 최종 결과 | 비고 |
| --- | --- | --- | --- |
| `AQ09` 체불 + 코인 매수 타이밍 | 3회 | 3/3 PASS | RAG `no_match`에서도 노동 대응 + 투자 제한 fallback 유지 |
| `AQ10` 야근수당 + 비트코인 구매 | 첫 실행 3회 | 0/3 FAIL | `사도 될까요`를 투자 실행 표현으로 감지하지 못해 기존 `off_topic`으로 단락 |
| `AQ10` 수정 후 | 3회 | 3/3 PASS | `사도` 자연어 표현을 일반 규칙에 추가 |
| `AQ01` 선택 회사 추가 확인 | 첫 회귀 3회 | 0/3 FAIL | 선택 회사가 있어도 `company/general`을 일반 설명으로 우선한 회귀 |
| `AQ01` 수정 후 | 3회 | 3/3 PASS | 선택 회사의 회사별 공개 자료 경로 우선 복구 |
| `AQ02` 일반 긍정 지표 | 3회 | 3/3 PASS | 회사 선택 없는 일반 설명 유지 |
| `AQ03` 체불 후 문의처 | 3회 | 3/3 PASS | 재작성 + RAG `matched` 유지 |

실패한 두 사례를 숨기지 않고 규칙·테스트·재실행으로 닫았다. 이 결과는 자동 계약 판정이며, 법률 적용의 사실성·각 문서의 쟁점 관련성은 여전히 각 계약의 인간/공식 근거 검토 항목이다.

## 자동 검증

- Answer Plan / chat route / comparison 회귀: 42 tests passed.
- 전체 제품 테스트: 65 files passed, 745 tests passed; opt-in live intent tests 85 skipped.
- TypeScript: passed.
- `git diff --check`: passed.
- 린트: passed.
- Production build: passed (Next.js optimized production build, 27 static pages generated).

## 미검증 및 다음 단계

- 브라우저 E2E, Real PostgreSQL, 대화 영속 저장, 요약, 배포/GCP는 검증하지 않았다.
- “RAG matched”는 문서 후보가 있다는 뜻일 뿐 법률 주장 전체의 참을 보장하지 않는다.
- 다음 단계는 새 개발용 PostgreSQL에서 로그인 사용자 대화 원문을 소유권·삭제·중복 방지와 함께 저장/복원하는 단계 5다. 현재 `recent_messages`는 요청/브라우저 단기 문맥일 뿐 영속 기억이 아니다.
