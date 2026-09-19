# 긍정 지표 연결 실측 — 2026-09-17

## 결론

긍정 지표 연결은 전체적으로 막혀 있지 않다. `(명)형창건설`의 공개 API가 확인 항목 4개를 반환했고 실제 Upstage 상담도 같은 이름 4개를 답했다. 다만 미확인 항목의 의미를 묻는 동일 질문을 독립 요청으로 3회 검사했을 때 모두 사용자용 답변 대신 답변 작성 지침을 설명하는 출력이 반환됐고 출력 가드레일을 통과했다.

재현된 핵심 문제는 **DB/RAG 전체 장애가 아니라 회사 컨텍스트를 받은 뒤의 답변 생성·출력 검증**이다. 공급자 응답 원문과 서버 실행 커밋까지 확인하지 않았으므로 모델·프롬프트·응답 처리 중 단일 원인을 확정하지 않는다.

## 검사 범위

- 사이트: https://moneyworry-demo.tail87a779.ts.net/
- 시간: 2026-09-17 14:26~14:30 KST.
- 공개 GET: 시스템 상태·readiness, ‘건설’ 검색 첫 5개 사업장의 risk API.
- 상담 POST: 합성 질문 6회, compare=false, 대화 이력 없이 독립 요청. Upstage 기본 경로만 확인.
- 브라우저 연결이 없어 클릭·화면 렌더링은 미확인. API와 화면 표시 코드를 대조했다.
- 비교 코드: main `97f8ca5d786e7caf0bd69da75365bd81724b52ed`.
- 사이트 정책 버전: `donworry-chat-policy-2026-09-16-v6`. 상태 API가 실행 커밋을 제공하지 않아 정확한 배포 커밋은 미확인.
- 소규모 재현 검사이며 전체 모델 정확도나 전체 DB 완전성을 측정한 것은 아니다.

## DB → 공개 API

시스템 상태는 real 데이터·dual_api 경로이며 DB/RAG/계약/기본 LLM이 ready였다. readiness는 HTTP 200, 모든 체크 true였다.

| company_id | 사업장 | 긍정 지표 | 관측 |
| --- | --- | --- | --- |
| bdfd63ca1e63a366 | 나비종합건설 일용 현장 | unavailable / null | wage no_data, verdict null |
| 547c24cdcef9459c | 한결건설 일용 현장 | unavailable / null | wage ready이나 verdict null, level unknown |
| 32d50aea4df70bb4 | (명)형창건설 | ready / 4 | 고용 안정·성실 납부·업력 약 3년 이상·낮은 변동성 확인 |
| 9f5ad7778ca72938 | (사)건설원가연구원 | ready / 6 | 6항목 확인. 공개 판정은 유보이며 개수와 종합 판정은 다름 |
| ea60c154ba286110 | 대한산업안전협회 수도권건설시설광역사업단 | unavailable / null | verdict 유보_정보부족, level unknown |

null은 0개와 다르다. `MlRiskProvider.ts`는 같은 배치의 scored_active g1~g6과 safe_recommendation 판정을 조회한다. 판정이 unknown이거나 배치·6개 boolean·개수 일치 조건을 만족하지 못하면 긍정 지표를 unavailable로 만든다. 운영 DB를 직접 조회하지 않아 누락된 행·필드까지 확정하지 않았다.

표본 5곳 모두 data_as_of=2026-06-01, valid_until=2026-07-01, freshness=expired였다. 갱신 상태는 DB/ML·운영 확인 항목이며 이번 답변 형식 문제의 원인이라고 단정하지 않는다.

## 실제 상담 결과

| 검사 | 결과 | trace |
| --- | --- | --- |
| 형창건설의 개수·항목 질문 | API와 같은 4개 및 이름을 정확히 답함 | company / context attached=true / rag no_match / guardrail passed |
| 형창건설 미확인 의미 질문, 동일 문장 3회 | 3회 모두 답변 작성 지침·구성 설명 형태로 반환 | company / context attached=true / rag no_match / guardrail passed, hits=[] |
| 회사 미선택, ‘긍정 신호 0개면 나쁜 회사인가요?’ | 사업장을 먼저 선택하라는 확인 질문 | company / INTENT_CLARIFICATION / 최종 생성 생략 |
| 정보부족 사업장 개수·항목 질문 | 확인할 수 없다고 응답. 개수·항목을 만들지 않음 | company / context attached=true / rag no_match / guardrail passed |

재현 질문: `이 사업장의 긍정 신호에서 확인되지 않은 항목은 회사가 나쁘거나 위험하다는 뜻인가요?`

첫 문제 comparison ID: `cmp_a6c06246-7169-49ae-9cf1-63a5ac6402a4`. 첫 반복: `cmp_34c1f7b4-7557-4be0-856e-b3c1b4c1ab69`. 정상 개수 답변: `cmp_c2ec443c-4898-4cf9-b347-359797479761`. 전체 응답은 작업자 로컬 exports/weekly-task-review-2026-09-17의 site-read.json, site-chat.json, site-followup.json에 보존했다.

rag no_match여도 회사 자료로 답하는 것은 #82가 허용한 경로다. 개수·항목 질문은 실제로 성공했으므로 검색 미적중을 지표 연결 장애로 판단하지 않는다.

## 원인 범위와 인수인계

| 관측 | 확인할 영역 | 다음 확인 |
| --- | --- | --- |
| 특정 회사 지표 unavailable | DB/ML 및 공개 API 변환 | 동일 batch의 scored_active·safe_recommendation 존재, 판정·g1~g6·n_green 일치 |
| 자료 유효기간 경과 | DB/ML·운영 | 최신 배치 발행·적재 상태 |
| 데이터가 있는데 답변 작성 지침 출력 | 상담 생성·프롬프트·가드레일 | 공급자 content와 반환값 대조, 최종 답변 계약·출력 검사 보완 |
| 회사 없이 일반 의미도 설명하지 않음 | 상담 의도 분류·분기 | company ID 강제가 일반적인 지표 설명 질문에도 필요한지 검토 |

코드 근거:

- product/src/adapters/real/MlRiskProvider.ts: DB 조회·공개 가능 조건.
- product/src/components/risk/RiskInformationCard.tsx: 개수·6항목·unavailable 표시.
- product/src/adapters/real/DualLlmChatProvider.ts: confirmed_count·confirmed_items를 모델용 사본에 전달.
- product/src/services/chatComparisonService.ts: company 의도에서 검색 실패 허용, 회사 미선택 시 확인 질문.
- product/src/adapters/real/OpenAICompatibleChatClient.ts: 공급자 message.content를 answer로 사용.
- product/prompts/chat/system.md 및 product/src/server/guardrails.ts: 답변 지침과 출력 검사.

이번 안전 단정 보강은 과제의 누락 문장과 회귀를 수정한다. 새로 관측한 답변 형식 문제의 수정·재평가는 별도 후속 범위다. 팀 메시지 전송, 운영 DB 수정, 배포는 수행하지 않았다.
