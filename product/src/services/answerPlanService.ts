import type {
  AnswerPlan,
  AnswerPlanPart,
  EvidenceState,
} from "@/domain/answerPlan";
import type { ChatRequest } from "@/domain/chat";
import type { RagRetrievalResult } from "@/domain/rag";
import type { IntentDecision } from "@/services/chatIntentService";
import { hasActualUnpaidWageReport, hasUnpaidWageQuestion, reviewedLaborTopics } from "@/services/reviewedLaborGuidance";

const DIRECT_LABOR_TERMS = [
  "체불", "근로계약", "근로시간", "퇴근", "수당", "연차", "해고", "휴가", "야근", "노동",
];
const WAGE_TROUBLE_PATTERN = /(?:임금|월급|급여).{0,18}(?:밀|못\s*받|지급|체불|문제|상담|받는\s*방법)|(?:밀|못\s*받|지급|체불|문제|상담).{0,18}(?:임금|월급|급여)/;

const OUT_OF_SCOPE_TOPICS = [
  {
    topic: "investment" as const,
    noun: /주식|코인|비트코인|가상자산/,
    execution: /추천|매수|매도|사야|사도|팔아|타이밍|투자해/,
  },
  {
    topic: "real_estate" as const,
    noun: /아파트|부동산|전세|매매/,
    execution: /시세|추천|매수|매도|계약해/,
  },
  {
    topic: "tax" as const,
    noun: /세금|종합소득세|양도소득세/,
    execution: /절세|신고해|계산해/,
  },
  {
    topic: "programming" as const,
    noun: /코드|프로그래밍|개발/,
    execution: /작성해|만들어|구현해|디버그해/,
  },
];

type OutOfScopeTopic = AnswerPlanPart["out_of_scope_topic"];

function detectedOutOfScopeTopic(message: string): OutOfScopeTopic {
  return OUT_OF_SCOPE_TOPICS.find((candidate) =>
    candidate.noun.test(message) && candidate.execution.test(message),
  )?.topic ?? null;
}

function hasLaborRequest(message: string): boolean {
  return DIRECT_LABOR_TERMS.some((term) => message.includes(term)) || WAGE_TROUBLE_PATTERN.test(message);
}

function part(
  scope: AnswerPlanPart["scope"],
  userGoal: string,
  request: ChatRequest,
  overrides: Partial<AnswerPlanPart> = {},
): AnswerPlanPart {
  return {
    scope,
    user_goal: userGoal,
    target_company_id: scope === "company_specific" ? request.company_id ?? null : null,
    evidence_needed: scope === "labor"
      ? ["labor_law"]
      : scope === "company_specific"
        ? ["company_public"]
        : ["none"],
    missing_fact: null,
    out_of_scope_topic: null,
    ...overrides,
  };
}

/**
 * Creates an internal routing contract from the current request.  It is
 * intentionally rule-first for explicit mixed requests, so no additional
 * model call is needed merely to preserve the answerable labor portion.
 */
export function createAnswerPlan(request: ChatRequest, decision: IntentDecision): AnswerPlan {
  const outOfScopeTopic = detectedOutOfScopeTopic(request.message);
  if (hasLaborRequest(request.message) && outOfScopeTopic) {
    return {
      request: { message: request.message, company_id: request.company_id, chat_mode: request.chat_mode },
      parts: [
        part("labor", "사용자가 묻는 임금 또는 근로조건 문제", request),
        part("out_of_scope", "투자·추천 등 범위 밖 실행 요청", request, { out_of_scope_topic: outOfScopeTopic }),
      ],
      requires_clarification: false,
    };
  }

  if (decision.intent === "labor"
    || (hasUnpaidWageQuestion(request.message)
      && (decision.intent !== "company" || hasActualUnpaidWageReport(request.message)))
    || (!outOfScopeTopic && reviewedLaborTopics(request.message).length > 0)) {
    return {
      request: { message: request.message, company_id: request.company_id, chat_mode: request.chat_mode },
      parts: [part("labor", "사용자가 묻는 임금 또는 근로조건 문제", request)],
      requires_clarification: false,
    };
  }
  if (decision.intent === "company" && decision.company_scope === "general" && !request.company_id) {
    return {
      request: { message: request.message, company_id: request.company_id, chat_mode: request.chat_mode },
      parts: [part("company_general", "회사 지표의 일반적인 의미", request)],
      requires_clarification: false,
    };
  }
  if (decision.intent === "company" && request.company_id) {
    return {
      request: { message: request.message, company_id: request.company_id, chat_mode: request.chat_mode },
      parts: [part("company_specific", "선택한 회사의 공개 자료 의미", request)],
      requires_clarification: false,
    };
  }
  if (decision.intent === "off_topic") {
    const topic: OutOfScopeTopic = ["real_estate", "tax", "investment", "programming"].includes(decision.topic)
      ? decision.topic as Exclude<OutOfScopeTopic, null>
      : null;
    return {
      request: { message: request.message, company_id: request.company_id, chat_mode: request.chat_mode },
      parts: [part("out_of_scope", "범위 밖 요청", request, { out_of_scope_topic: topic })],
      requires_clarification: false,
    };
  }
  const missingTarget = decision.intent === "company" ? "확인할 회사" : "현재 질문의 대상";
  return {
    request: { message: request.message, company_id: request.company_id, chat_mode: request.chat_mode },
    parts: [part("clarification", "질문의 대상 또는 필요한 사실 확인", request, { missing_fact: missingTarget })],
    requires_clarification: true,
  };
}

export function primaryAnswerScope(plan: AnswerPlan): AnswerPlanPart["scope"] {
  return plan.parts[0]?.scope ?? "clarification";
}

export function hasOutOfScopePart(plan: AnswerPlan): boolean {
  return plan.parts.some((item) => item.scope === "out_of_scope");
}

export function evidenceStateForPlan(
  plan: AnswerPlan,
  retrieval: RagRetrievalResult,
): EvidenceState {
  if (!plan.parts.some((item) => item.evidence_needed.includes("labor_law"))) return "not_needed";
  if (retrieval.status === "unavailable") return "unavailable";
  if (retrieval.status === "no_match") {
    return retrieval.reason === "out_of_scope" ? "not_relevant" : "not_found";
  }
  const categorized = retrieval.documents.filter((document) => document.source.category !== undefined);
  if (categorized.length > 0 && !categorized.some((document) => document.source.category === "labor_law")) {
    return "not_relevant";
  }
  return "ready";
}
