# 단계 3 — 답변 흐름과 문맥 책임 설계

작성일: 2026-09-18  
적용 브랜치: `task/reply-prompt-upgrade`  
기준: 단계 1 재현 기록, 단계 2 답변 계약 및 `8698a6d`

## 결정

다음 구현부터는 `intent` 하나가 검색, 회사 조회, 거절, fallback을 모두 결정하지 않는다. 현재 질문을 해석한 뒤 **답변 계획(Answer Plan)** 을 만들고, 계획에서 요구한 근거만 가져와 최종 답변을 만든다. 이 문서는 그 계획의 최소 계약과 책임 경계를 고정한다. 단계 4에서 이 구조를 실제 일반 채팅 경로에 적용한다.

이는 모델 호출을 하나 더 추가하겠다는 결정이 아니다. 우선 현재 요청, 선택 회사, 짧은 대화 이력, 규칙으로 확정할 수 있는 부분은 코드에서 결정하고, 의미 판별이 필요한 좁은 부분만 기존 분류/생성 호출을 사용한다.

## 현재 흐름과 문제 지점

```text
요청 파싱
  → PolicyChatProvider로 기본 답변 생성
  → 후속 질문 재작성
  → intent 분류
  → intent가 회사/RAG/차단 경로를 선택
  → 회사 또는 RAG 자료 조회
  → 생성 모델
  → 문자열 중심 가드레일
  → 기본 답변 또는 교체 fallback
```

현재 코드 근거:

- `product/src/services/chatComparisonService.ts`는 재작성 직후 `intent`로 회사 자료·RAG·short circuit을 선택한다.
- 회사 질문은 RAG를 `company_context_only`로 고정하고, 노동 질문은 RAG 결과가 `matched`일 때만 생성으로 진행한다.
- `product/src/adapters/real/DualLlmChatProvider.ts`는 runtime JSON, 최근 6개 메시지, 회사/RAG 자료를 한 프롬프트에 합치고, 생성 후 가드레일에 걸리면 기본 답변으로 교체한다.
- `product/src/services/queryRewriteService.ts`는 짧은 후속 질문에 한해 직전 사용자 발화를 붙이는 실패 대비 경로를 이미 갖고 있다.

이 흐름은 다음 구분을 표현하지 못한다.

1. 회사 카드의 일반 의미와 선택 회사의 실제 공개 자료.
2. 하나의 요청 안에서 답할 수 있는 노동 부분과 범위 밖 투자·추천 부분.
3. 검색이 됐다는 사실과 그 문서가 현재 주장에 실제로 맞는다는 사실.
4. 질문이 불명확한 상태와 외부 서비스가 실패한 상태.
5. 생성 실패/가드레일 교체 뒤에도 원래 질문에 맞는 fallback.

## 재현 실패 → 책임 → 다음 수정 지점

| 재현 ID | 관측한 시작 지점 | 책임 | 단계 4 목표 |
| --- | --- | --- | --- |
| `QA-COMPANY-01` 선택 회사 추가 확인 | `intent` 분류 변동 | 요청 대상 해석 | 선택 회사, 지시어, 회사명 명시를 별도 대상 필드로 만들고 회사 자료가 필요한 쟁점을 명시한다. |
| `QA-GENERAL-01` 긍정 지표 0개 | 일반 개념이 회사 선택 요구로 단락 | 답변 가능 범위 | 회사 ID 없이 설명 가능한 일반 개념은 `general_guidance` 계획으로 만든다. |
| `QA-LABOR-01` 코딩 업무의 야간근무 | 생성이 내부 작성 지침을 노출 | 생성/출력 검사/복구 | 생성 전 계획에 허용 근거와 금지 주장을 넣고, 교체 시에도 노동 질문용 fallback을 쓴다. |
| `QA-FOLLOWUP-01` 체불 뒤 문의처 | 축약 후속 질문이 RAG `no_match` | 문맥 복원/검색 질의 | 사용자 발화에서만 복원한 질문을 계획의 대상·쟁점과 대조하고, 재질문은 필요한 누락 정보에만 한다. |
| `QA-COMPOUND-01` 노동 상담 + 코인 매수 | 전체가 `unclear`로 종료 | 요청 분해/범위 경계 | 답할 노동 부분과 답하지 않을 투자 부분을 한 계획의 `answerable`/`out_of_scope` 항목으로 나눈다. |
| 검색은 됐지만 무관한 조문 | `matched`가 생성 허가처럼 사용될 수 있음 | 근거 관련성 | 문서 수가 아니라 쟁점·대상·시점이 맞는지 판정한 근거만 주장에 사용한다. |
| 생성/가드레일 실패 | 기본 답변이 현재 질문과 어긋날 수 있음 | 복구 | 실패 종류와 Answer Plan의 미해결 쟁점에 맞는 fallback을 선택한다. |

`QA-GENERAL-01`, `QA-LABOR-01`, `QA-FOLLOWUP-01`은 단계 1/2에서 각각 3회 반복 계약 PASS를 확인했다. 이는 새 구조가 불필요하다는 뜻이 아니라, 해당 개선을 회귀 기준으로 보존한다는 뜻이다. 복합 요청과 근거 관련성은 아직 해결 판정하지 않는다.

## 목표 흐름

```text
요청·권한·현재 선택 회사 확인
  → 허용된 짧은 문맥 복원
  → 요청 이해: 대상 / 쟁점 / 답할 부분 / 범위 밖 부분 / 부족한 사실
  → Answer Plan 생성
  → 계획에 필요한 회사·법령·계약 근거 조회
  → 근거의 대상·시점·관련성 확인
  → 허용된 문맥으로 최종 답변 생성
  → 주장·인용·회사/사용자 경계·내부정보 검사
  → 계획 기반 fallback 또는 최종 답변
  → 화면 표시
  → 완료된 최종 사용자/assistant 메시지만 저장 (단계 5 이후)
```

긴급 위험은 이 흐름보다 먼저 `emergency_guidance`로 종료한다. 범위 밖 요청도 생성 모델로 답을 만들지 않는다. 다만 복합 요청의 답할 수 있는 노동 부분까지 함께 버리지 않는다.

## Answer Plan 최소 계약

아래는 내부 데이터 계약이다. 프롬프트나 최종 응답에 직렬화하거나 노출하지 않는다.

```ts
type AnswerScope = "labor" | "company_specific" | "company_general" | "out_of_scope";
type EvidenceNeed = "labor_law" | "company_public" | "contract_result" | "none";
type BlockReason =
  | "missing_target"
  | "missing_fact"
  | "out_of_scope"
  | "evidence_unavailable"
  | "evidence_not_relevant"
  | "service_failure";

interface AnswerPlanPart {
  scope: AnswerScope;
  user_goal: string;
  target_company_id: string | null;
  evidence_needed: EvidenceNeed[];
  allowed_claims: string[];
  prohibited_inferences: string[];
  missing_fact: string | null;
  block_reason: BlockReason | null;
  next_action: string | null;
}

interface AnswerPlan {
  request_id: string;
  parts: AnswerPlanPart[];
  selected_company_id: string | null;
  context_message_ids: string[]; // 단계 5 전에는 요청의 recent_messages 순번만 사용
  requires_clarification: boolean;
}
```

필수 불변 조건:

- `company_specific`은 대상 회사 ID와 실제 공개 자료 없이는 특정 사실을 주장하지 않는다.
- `company_general`은 회사 선택을 요구하지 않고 일반 의미와 특정 회사 판단의 경계를 설명한다.
- `labor`는 관련성이 확인된 법령/공식 안내가 없으면 조문·기관 적용을 만들어 내지 않는다.
- `out_of_scope`은 추천·실행 답변을 만들지 않는다. 다른 `labor` part가 있으면 그 부분은 계속 답한다.
- `missing_fact`과 `service_failure`는 서로 바꾸지 않는다. 전자는 사용자에게 필요한 하나의 확인 질문, 후자는 실패 사실과 재시도/공식 경로를 사용한다.
- 어떤 `prohibited_inferences`나 Answer Plan 내부 필드도 최종 답변에 나타나면 실패다.

## 근거와 생성의 입출력 경계

### 근거 확인 입력

각 `AnswerPlanPart`와 후보 문서/회사 공개 자료를 입력으로 받아 다음을 낸다.

```ts
interface VerifiedEvidence {
  kind: EvidenceNeed;
  source: { name: string; citation?: string; url?: string; as_of?: string };
  supports: string[];       // 이 답변에서 허용하는 쟁점
  limitations: string[];    // 적용 조건, 대상·시점, 자료 한계
}
```

`RagRetrievalResult.status === "matched"` 자체는 `VerifiedEvidence`가 아니다. 후보 문서가 현재 쟁점과 대상에 맞고, 인용할 정확한 문서명이 있으며, 계획에 없는 주장을 뒷받침하지 않는 경우에만 사용한다. 공식 안내만 있는 경우에는 조문처럼 표현하지 않는다.

### 생성 입력

생성 모델에는 현재 질문, 허용된 짧은 문맥, Answer Plan의 사용자용 목적, `VerifiedEvidence`, 필요한 제한과 다음 행동만 전달한다. 원시 모델 payload, 내부 정책, ML/SHAP 값, 다른 대화방 내용, 삭제/만료된 메시지는 전달하지 않는다.

생성 후에는 다음을 각각 검사한다.

1. 현재 질문 또는 plan part 하나 이상에 실제로 답했는가.
2. 답변의 법령·회사 주장이 `VerifiedEvidence` 범위 안인가.
3. 특정 회사/다른 회사/사용자 진술/assistant 과거 안내를 혼동하지 않았는가.
4. 내부 지침·비공개 필드·가짜 인용이 없는가.

실패 시 단 한 번의 제한된 교체만 허용한다. 교체 답변은 Answer Plan의 `next_action`, `missing_fact`, 검증된 근거만 사용하며 재생성을 반복하지 않는다.

## 기억 문맥 인터페이스 (단계 5/6 연결점)

단계 4에서는 현재 요청의 `recent_messages`만 쓰며 영속 저장을 추가하지 않는다. 단계 5 이후에는 아래 인터페이스의 출처만 바뀐다.

```ts
interface PermittedConversationContext {
  active_company_id: string | null;
  recent_messages: Array<{
    message_id: string;
    role: "user" | "assistant";
    content: string;
    company_id_at_turn: string | null;
  }>;
  summary: null | {
    summary_id: string;
    user_stated_facts: string[];
    unresolved_questions: string[];
    corrected_fact_ids: string[];
  };
}
```

사용자 발화는 “사용자가 말한 사실”일 뿐 검증된 사실이 아니다. 과거 assistant 답변은 새 사실이나 현재 법률 근거가 아니다. 단계 5는 로그인 사용자의 소유권, 삭제/만료, 30일 원문·7일 trace 보존을 적용한 뒤 이 인터페이스를 채운다. 게스트는 현재 탭 문맥만 제공한다.

## 단계 4 수용 기준

- `AQ01`~`AQ08` 계약을 유지하고, 복합 노동+투자 사례는 노동 부분을 답하면서 투자 추천은 하지 않는다.
- 선택 회사/일반 지표/개인 노동 문제를 같은 `intent`의 부수 효과로 혼동하지 않는다.
- RAG `no_match`, `unavailable`, 근거 무관, 사용자 정보 부족이 서로 다른 trace와 최종 안내를 가진다.
- 가드레일 교체와 생성 API 실패 뒤에도 현재 질문과 plan part가 맞는 fallback을 제공한다.
- 새 Answer Plan이나 runtime 컨텍스트가 최종 답변에 노출되지 않는다.
- 단계 5의 DB 저장 없이도 위 단일 질문·짧은 대화 계약을 실제 `/api/chat`으로 측정한다.

## 비범위 및 재개 지점

이 단계는 DB migration, 대화 목록 UI, 요약 worker, 브라우저 E2E, 배포를 구현하지 않는다. 단계 4는 이 문서의 Answer Plan을 실제 일반 채팅 경로에 도입하는 작업부터 시작한다. 첫 구현 단위는 복합 요청 분해와 `evidence_unavailable`/`evidence_not_relevant` 구분이며, 그 전후를 새 독립 계약 사례로 측정한다.
