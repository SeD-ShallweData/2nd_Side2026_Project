/**
 * 정책 분기 골든셋.
 *
 * `PolicyChatProvider`는 LLM을 호출하기 전에 규칙만으로 답변 골격(answer_type,
 * 출처, 다음 행동, 한계)을 정합니다. 이 결과는 두 곳으로 흘러갑니다.
 *
 *   1. `DualLlmChatProvider`의 시스템 프롬프트에 `policy_baseline`으로 주입
 *   2. LLM API가 실패하면 그대로 사용자에게 노출(fallback)
 *
 * 즉 여기서 분기가 틀리면 프롬프트를 아무리 다듬어도 답변이 어긋납니다.
 * 이 파일은 그 분기를 질문 단위로 고정해 두는 회귀 케이스 모음입니다.
 *
 * 케이스는 순수 함수 경로만 태우므로 LLM·DB·RAG를 호출하지 않습니다.
 * 공용 API 키를 쓰지 않으니 몇 번을 돌려도 팀 작업에 영향이 없습니다.
 *
 * 질문을 추가할 때는 실제 사용자 말투로 쓰고, `branch`에 어느 분기를 겨냥한
 * 케이스인지 적습니다. 실패했던 케이스는 반드시 여기에 남깁니다.
 */

import type { AnswerType, ChatMode, GuardrailStatus, RecentMessage } from "@/domain/chat";

/** `PolicyChatProvider.sendMessage`가 가진 분기. 위에서부터 먼저 평가됩니다. */
export const POLICY_BRANCHES = [
  "emergency",
  "other_company_referenced",
  "no_company_context_keyword",
  "no_company_out_of_scope",
  // 회사를 선택하지 않은 상태의 노동 주제. LABOR_TOPICS 의 항목마다 케이스를 둔다.
  // 주제를 추가하고 케이스를 빠뜨리면 커버리지 검사가 실패한다.
  "no_company_wage",
  "no_company_safety",
  "no_company_termination",
  "no_company_contract",
  "no_company_leave",
  "no_company_worktime",
  "no_company_harassment",
  "no_company_insurance",
  "no_company_fallback",
  "company_wage_future",
  "company_conclusion",
  "company_reason",
  "company_checklist",
  "company_fallback",
] as const;

export type PolicyBranch = (typeof POLICY_BRANCHES)[number];

export interface PolicyRoutingCase {
  id: string;
  /** 이 케이스가 겨냥한 분기. 분기 커버리지 집계에 쓰입니다. */
  branch: PolicyBranch;
  question: string;
  chat_mode?: ChatMode;
  company_id?: string;
  recent_messages?: RecentMessage[];
  expect_answer_type: AnswerType;
  expect_guardrail: GuardrailStatus;
  /** 출처를 만들어내지 않는지 본다. 근거가 없으면 반드시 "none". */
  expect_sources: "none" | "some";
  /** 반드시 포함돼야 하는 다음 행동 코드. */
  expect_actions?: string[];
  expect_contains?: string[];
  forbid_contains?: string[];
  note?: string;
}

export interface PolicyErrorCase {
  id: string;
  question: string;
  company_id: string;
  expect_code: string;
  expect_status: number;
}

/**
 * 어떤 분기를 타든 정책 답변에 절대 나오면 안 되는 표현.
 *
 * `DualLlmChatProvider`의 출력 가드레일과 같은 문제를 입력 쪽에서 막습니다.
 * baseline이 이미 단정 표현을 담고 있으면 LLM이 그것을 따라 쓰기 때문에,
 * 출력 가드레일에만 의존하지 않고 여기서도 검사합니다.
 */
export const FORBIDDEN_IN_ANY_ANSWER = [
  "안전한 회사입니다",
  "위험한 회사입니다",
  "문제가 없는 사업장입니다",
  "임금체불이 발생할 것입니다",
  "임금체불 가능성이 확실합니다",
  "산재가 발생할 것입니다",
  "입사하지 마세요",
  "입사해도 됩니다",
  "위법입니다",
  "불법입니다",
  "반드시 승소",
];

/** 사용자에게 노출되면 안 되는 내부 필드 이름. */
export const FORBIDDEN_INTERNAL_FIELDS = [
  "raw_probability",
  "shap_value",
  "internal_score",
  "model_threshold",
  "feature_importance",
  "system_prompt",
  "hidden_prompt",
];

export const POLICY_ROUTING_CASES: PolicyRoutingCase[] = [
  // ────────────────────────────────────────────── 응급
  // 응급 판정은 회사 조회보다 먼저 일어난다. 사고 상황에서 사업장 선택을
  // 요구하거나 404를 던지면 안 되기 때문이다.
  {
    id: "emg-01",
    branch: "emergency",
    question: "작업 중에 손을 크게 다쳤어요",
    expect_answer_type: "emergency_guidance",
    expect_guardrail: "escalated",
    expect_sources: "some",
    expect_actions: ["MOVE_TO_SAFETY", "CALL_1350"],
    expect_contains: ["안전을 확보", "119"],
  },
  {
    id: "emg-02",
    branch: "emergency",
    question: "현장에서 화재가 났어요",
    company_id: "COMPANY_DEMO_001",
    expect_answer_type: "emergency_guidance",
    expect_guardrail: "escalated",
    expect_sources: "some",
    expect_actions: ["MOVE_TO_SAFETY"],
    note: "사업장이 선택돼 있어도 응급 안내가 회사 맥락 답변보다 우선한다.",
  },
  {
    id: "emg-03",
    branch: "emergency",
    question: "동료가 의식이 없어요",
    company_id: "NO_SUCH_COMPANY_999",
    expect_answer_type: "emergency_guidance",
    expect_guardrail: "escalated",
    expect_sources: "some",
    note: "없는 company_id여도 404를 던지지 않고 응급 안내를 먼저 내보낸다.",
  },

  // ────────────────────────────────────────────── 회사 미선택
  {
    id: "ctx-01",
    branch: "no_company_context_keyword",
    question: "여기 분위기 어때요?",
    expect_answer_type: "clarification",
    expect_guardrail: "limited",
    expect_sources: "none",
    expect_actions: ["SEARCH_COMPANY"],
    expect_contains: ["사업장 검색"],
  },
  {
    id: "ctx-02",
    branch: "no_company_context_keyword",
    question: "입사해도 괜찮을지 궁금해요",
    expect_answer_type: "clarification",
    expect_guardrail: "limited",
    expect_sources: "none",
    expect_actions: ["SEARCH_COMPANY"],
    note: "'입사'만 있고 노동 주제가 없으면 사업장 선택을 안내한다.",
  },
  {
    id: "ctx-03",
    branch: "no_company_context_keyword",
    question: "이직하려는 회사가 안전한지 알고 싶어요",
    expect_answer_type: "clarification",
    expect_guardrail: "limited",
    expect_sources: "none",
    expect_actions: ["SEARCH_COMPANY"],
    note:
      "조사 하나 차이('회사 안전' vs '회사가 안전')로 일반 안내로 새던 자리다. " +
      "회사 안전을 묻는 질문은 사업장 선택 안내를 받아야 한다.",
  },
  {
    id: "wage-04",
    branch: "no_company_wage",
    question: "사업장에서 월급을 두 달째 못 받았어요",
    chat_mode: "wage",
    expect_answer_type: "general_guidance",
    expect_guardrail: "passed",
    expect_sources: "some",
    note: "맨 '사업장'이 회사 지시 표현에서 빠지면서 임금 안내로 제대로 간다.",
  },
  {
    id: "oos-01",
    branch: "no_company_out_of_scope",
    question: "해외 본사면 대표 개인재산으로 바로 받을 수 있나요?",
    expect_answer_type: "insufficient_evidence",
    expect_guardrail: "limited",
    expect_sources: "none",
    expect_actions: ["CALL_1350"],
    expect_contains: ["1350"],
    note: "연결된 문서 범위 밖이면 근거를 만들지 않고 공식 창구로 넘긴다.",
  },
  {
    id: "wage-01",
    branch: "no_company_wage",
    question: "월급이 두 달째 밀렸어요",
    chat_mode: "wage",
    expect_answer_type: "general_guidance",
    expect_guardrail: "passed",
    expect_sources: "some",
    expect_actions: ["COLLECT_WAGE_RECORDS", "CALL_1350"],
    expect_contains: ["근로계약서"],
  },
  {
    id: "wage-02",
    branch: "no_company_wage",
    question: "퇴직금을 못 받았는데 어디에 신고하나요?",
    chat_mode: "wage",
    expect_answer_type: "general_guidance",
    expect_guardrail: "passed",
    expect_sources: "some",
  },
  {
    id: "safety-01",
    branch: "no_company_safety",
    question: "산재 신청 절차가 궁금해요",
    chat_mode: "safety",
    expect_answer_type: "general_guidance",
    expect_guardrail: "passed",
    expect_sources: "some",
    expect_actions: ["RECORD_ACCIDENT", "CALL_1350"],
  },
  {
    id: "safety-02",
    branch: "no_company_safety",
    question: "업무상 재해로 인정받으려면 뭐가 필요한가요?",
    chat_mode: "safety",
    expect_answer_type: "general_guidance",
    expect_guardrail: "passed",
    expect_sources: "some",
    forbid_contains: ["승인됩니다", "인정됩니다"],
    note: "산재 승인 여부를 대신 판정하지 않는다.",
  },
  {
    id: "termination-01",
    branch: "no_company_termination",
    question: "사장이 갑자기 내일부터 나오지 말라고 했어요",
    expect_answer_type: "general_guidance",
    expect_guardrail: "passed",
    expect_sources: "none",
    expect_actions: ["RECORD_NOTICE", "CALL_1350"],
    forbid_contains: ["부당해고입니다", "위법입니다"],
    note: "해고의 정당성을 대신 판정하지 않고 기록과 기한 확인으로 안내한다.",
  },
  {
    id: "termination-02",
    branch: "no_company_termination",
    question: "해고 통보를 문자로만 받았는데 효력이 있나요?",
    expect_answer_type: "general_guidance",
    expect_guardrail: "passed",
    expect_sources: "none",
  },
  {
    id: "contract-01",
    branch: "no_company_contract",
    question: "근로계약서를 아직 못 받았어요",
    expect_answer_type: "general_guidance",
    expect_guardrail: "passed",
    expect_sources: "none",
    expect_actions: ["COMPARE_CONTRACT", "REVIEW_CONTRACT"],
    note: "'못 받'이 임금 주제로 새지 않는지 함께 본다.",
  },
  {
    id: "contract-02",
    branch: "no_company_contract",
    question: "근로계약서에 꼭 들어가야 할 내용이 뭔가요?",
    expect_answer_type: "general_guidance",
    expect_guardrail: "passed",
    expect_sources: "none",
  },
  {
    id: "leave-01",
    branch: "no_company_leave",
    question: "연차를 안 쓰면 돈으로 받을 수 있나요?",
    expect_answer_type: "general_guidance",
    expect_guardrail: "passed",
    expect_sources: "none",
    expect_actions: ["COLLECT_LEAVE_RECORDS", "CALL_1350"],
  },
  {
    id: "leave-02",
    branch: "no_company_leave",
    question: "휴게시간을 안 주는데 괜찮은 건가요?",
    expect_answer_type: "general_guidance",
    expect_guardrail: "passed",
    expect_sources: "none",
  },
  {
    id: "worktime-01",
    branch: "no_company_worktime",
    question: "주 52시간을 넘겨 일하고 있어요",
    expect_answer_type: "general_guidance",
    expect_guardrail: "passed",
    expect_sources: "none",
    expect_actions: ["COLLECT_WORKTIME_RECORDS", "CALL_1350"],
  },
  {
    id: "harassment-01",
    branch: "no_company_harassment",
    question: "직장 내 괴롭힘을 당했는데 어디에 신고하나요?",
    expect_answer_type: "general_guidance",
    expect_guardrail: "passed",
    expect_sources: "none",
    expect_actions: ["RECORD_HARASSMENT", "CALL_1350"],
  },
  {
    id: "insurance-01",
    branch: "no_company_insurance",
    question: "4대보험에 가입을 안 시켜줘요",
    expect_answer_type: "general_guidance",
    expect_guardrail: "passed",
    expect_sources: "none",
    expect_actions: ["COLLECT_EMPLOYMENT_PROOF", "CALL_1350"],
    note: "보험별 담당 기관이 달라 단정하지 않고 확인 경로를 안내한다.",
  },
  {
    id: "wage-03",
    branch: "no_company_wage",
    question: "주휴수당은 어떤 조건에서 받나요?",
    chat_mode: "wage",
    expect_answer_type: "general_guidance",
    expect_guardrail: "passed",
    expect_sources: "some",
    note: "예전에는 되묻기로 떨어져 RAG가 찾은 법령 근거가 통째로 버려지던 질문이다.",
  },
  {
    id: "topic-over-weak-reference",
    branch: "no_company_contract",
    question: "입사하려는데 근로계약서를 아직 못 받았어요",
    expect_answer_type: "general_guidance",
    expect_guardrail: "passed",
    expect_sources: "none",
    note: "'입사'가 있어도 노동 주제가 분명하면 사업장 선택 안내로 빠지지 않는다.",
  },
  {
    id: "fallback-01",
    branch: "no_company_fallback",
    question: "노동 상담은 어디서 받을 수 있나요?",
    expect_answer_type: "clarification",
    expect_guardrail: "passed",
    expect_sources: "none",
    expect_actions: ["SEARCH_COMPANY", "CALL_1350"],
    note: "어느 주제에도 걸리지 않을 때만 되묻는다.",
  },

  // ────────────────────────────────────────────── 회사 선택됨
  {
    id: "other-01",
    branch: "other_company_referenced",
    question: "미래산업은 어때요?",
    company_id: "COMPANY_DEMO_001",
    expect_answer_type: "clarification",
    expect_guardrail: "limited",
    expect_sources: "none",
    expect_actions: ["SEARCH_COMPANY"],
    expect_contains: ["현재 상담에는 OO건설만 연결", "미래산업"],
    note: "선택하지 않은 사업장의 신호를 현재 회사 답변에 섞지 않는다.",
  },
  {
    id: "future-01",
    branch: "company_wage_future",
    question: "여기 임금 체불할 거 같은데 맞나요?",
    company_id: "COMPANY_DEMO_001",
    chat_mode: "wage",
    expect_answer_type: "company_context",
    expect_guardrail: "limited",
    expect_sources: "some",
    expect_actions: ["CHECK_PAYDAY", "CHECK_INSURANCE"],
    expect_contains: ["확정할 수 없습니다"],
  },
  {
    id: "concl-01",
    branch: "company_conclusion",
    question: "여기 입사해도 될까요?",
    company_id: "COMPANY_DEMO_001",
    expect_answer_type: "company_context",
    expect_guardrail: "limited",
    expect_sources: "some",
    expect_contains: ["확정할 수는 없습니다"],
  },
  {
    id: "reason-01",
    branch: "company_reason",
    question: "왜 추가 확인이 필요한가요?",
    company_id: "COMPANY_DEMO_001",
    expect_answer_type: "company_context",
    expect_guardrail: "passed",
    expect_sources: "some",
  },
  {
    id: "reason-02",
    branch: "company_reason",
    question: "왜 추가 확인이 필요한가요?",
    company_id: "UNKNOWN_001",
    expect_answer_type: "company_context",
    expect_guardrail: "limited",
    expect_sources: "none",
    expect_contains: ["세부 확인 신호가 제공되지 않았습니다"],
    note: "자료가 없으면 근거를 지어내지 않고 없다고 밝히며 출처도 비운다.",
  },
  {
    id: "checklist-01",
    branch: "company_checklist",
    question: "입사 전에 무엇을 확인해야 하나요?",
    company_id: "COMPANY_DEMO_001",
    expect_answer_type: "company_context",
    expect_guardrail: "passed",
    expect_sources: "some",
    expect_actions: ["OPEN_CHECKLIST", "REVIEW_CONTRACT"],
  },
  {
    id: "cfallback-01",
    branch: "company_fallback",
    question: "이 결과를 좀 더 풀어서 설명해 주세요",
    company_id: "COMPANY_DEMO_001",
    expect_answer_type: "company_context",
    expect_guardrail: "passed",
    expect_sources: "some",
    expect_contains: ["어느 부분을 더 확인하고 싶은지"],
  },
  {
    id: "cfallback-02",
    branch: "company_fallback",
    question: "이 결과를 좀 더 풀어서 설명해 주세요",
    company_id: "UNKNOWN_001",
    expect_answer_type: "company_context",
    expect_guardrail: "limited",
    expect_sources: "none",
    note: "임금·산업재해가 모두 unknown이면 guardrail을 limited로 낮춘다.",
  },
];

/** 오류로 끝나야 하는 요청. 화면이 처리할 수 있는 코드·상태로 나가는지 본다. */
export const POLICY_ERROR_CASES: PolicyErrorCase[] = [
  {
    id: "err-01",
    question: "월급이 밀렸어요",
    company_id: "NO_SUCH_COMPANY_999",
    expect_code: "COMPANY_NOT_FOUND",
    expect_status: 404,
  },
  {
    id: "err-02",
    question: "월급이 밀렸어요",
    company_id: "ERROR_001",
    expect_code: "RISK_SOURCE_UNAVAILABLE",
    expect_status: 503,
  },
];

/**
 * 현재 동작을 고정해 두되 개선 후보로 표시한 케이스.
 *
 * 여기 있는 항목은 "정답"이 아니라 "지금 이렇게 동작한다"는 기록입니다.
 * 분기 순서를 고칠 때 무엇이 바뀌는지 바로 보이게 하려고 분리했습니다.
 * 동작을 바꾸기로 결정하면 기대값을 고쳐 위 목록으로 옮깁니다.
 */
export const KNOWN_ROUTING_GAPS: PolicyRoutingCase[] = [
  {
    id: "gap-02",
    branch: "company_reason",
    question: "왜 이렇게 월급이 적은지 모르겠어요",
    company_id: "COMPANY_DEMO_001",
    chat_mode: "wage",
    expect_answer_type: "company_context",
    expect_guardrail: "passed",
    expect_sources: "some",
    note:
      "'왜' 한 글자가 트리거라서 임금 수준을 묻는 질문에도 확인신호 설명이 나간다. " +
      "분기 키워드가 넓지만 answer_type 은 어느 쪽이든 company_context 라 영향이 작아 " +
      "이번에는 건드리지 않았다.",
  },
];
