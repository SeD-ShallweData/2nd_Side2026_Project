# 회사 선택 해제 뒤 범위 밖 질문 회귀 (E-1, 결정 42)

- 시나리오: 사업장 `COMPANY_DEMO_001`(인천 OO건설)을 선택해 임금 카드 질문을
  한 뒤 선택을 해제하고(`company_id` 없음, 대화 이력·회사 이력은 남음)
  `회사 컴퓨터에 게임 설치하는 방법 알려줘`를 묻는다.
- 기대 동작: 의도 분류가 `off_topic`이면 Answer Plan이 `out_of_scope`로 가고,
  `chatComparisonService`의 정책 단축 응답이 생성 없이 끝난다. 답변에는 고정
  범위 안내 `이 상담은 노동·근로계약과 회사의 임금·안전 정보를 다룹니다. 해당
  질문은 이 상담에서 답하기 어렵습니다.`와 한계 문구 `질문 의도에 따른 범위
  안내이며 회사에 대한 평가가 아닙니다.`가 들어가고, `guardrail_hits`는
  `INTENT_OUT_OF_SCOPE`다. 이전 회사명·지역, 임금/산업재해 카드 요약, 확인 신호
  항목, 출처는 붙지 않는다. 회사가 계속 선택된 상태에서도 같은 질문은 회사
  요약 대신 범위 안내로 끝난다.
- 자동 회귀: `product/src/services/outOfScopeAfterCompanyClear.test.ts` (4개).
  정책 baseline(Mock 회사·위험 자료), 재작성, 실제 의도 분류 파서, Answer Plan,
  정책 단축 경로를 그대로 타고 공급자 호출만 가짜 `fetch`로 대신한다. 선택 상태의
  회사 맥락이 실제로 붙는 대조 1건, 재작성문에 이전 회사명이 섞이는 최악의 경우를
  포함한다.
- 실제 모델 분류 사례: `product/eval/chat-intent-cases.json`에 `O7`(선택 해제 상태,
  직전 회사 카드 대화 이력 포함)을 추가했다. 기본 실행에서는 건너뛰는 opt-in 평가다.
  `answer-quality05-regression.v1.json`은 26턴·호출 상한·체크포인트가 고정된
  프로토콜이라 수정하지 않았다.

재실행:

```bash
cd product
npx vitest run src/services/outOfScopeAfterCompanyClear.test.ts
# 실제 모델 분류(공급자 호출 발생)
RUN_CHAT_INTENT_LIVE=1 CHAT_INTENT_EVAL_CASE_IDS=O7 npx vitest run src/services/chatIntentLive.test.ts
```

검증: 위 테스트 4개와 관련 `chatComparisonService`·`answerPlanService`·
`chatIntentService` 테스트 PASS, 타입 검사·ESLint PASS.

검증 경계: 범위 안내는 분류기가 `off_topic`을 돌려줄 때만 나온다. 분류 실패
(`unavailable`)나 `unclear`이면 회사 요약 없이 일반 확인 질문으로 끝나며 범위 안내
문구는 나오지 않는다. 게임 설치는 규칙 기반 범위 밖 주제(투자·부동산·세금·코딩)에
없다. `CHAT_EXECUTION_MODE=openai_responses` 경로는 Answer Plan을 쓰지 않아 이
회귀 범위 밖이다. 실제 모델·화면에서의 선택 해제 흐름은 확인하지 않았으며,
데모 스크립트로 live-LLM 수동 QA를 지민/성현이 진행해야 한다.
