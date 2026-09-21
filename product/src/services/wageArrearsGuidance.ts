import type { ChatResponse } from "@/domain/chat";
import type { RagRetrievalResult } from "@/domain/rag";
import { hasUnpaidWageQuestion } from "@/services/reviewedLaborGuidance";

const LABOR_PORTAL = "https://labor.moel.go.kr/minwonSysInfo/wagesolway.do";

/**
 * Builds a source-linked recovery answer only after the ordinary RAG path has
 * returned relevant wage-arrears evidence. It is not a replacement for search
 * and must never turn an unavailable or no-match result into a sourced answer.
 */
export function wageArrearsFallback(
  query: string,
  baseline: ChatResponse,
  retrieval: RagRetrievalResult,
  hasOutOfScopePart = false,
): ChatResponse | null {
  if (!hasUnpaidWageQuestion(query) || retrieval.status !== "matched" || retrieval.documents.length === 0) {
    return null;
  }
  // A matched but unrelated article (e.g. delayed interest alone) cannot support filing advice.
  if (!retrieval.documents.some(doc => doc.citation === "근로기준법 제43조")
    || !retrieval.documents.some(doc => doc.source.url?.startsWith("https://labor.moel.go.kr/"))) return null;

  const periodNote = /두\s*(?:달|개월)|2\s*(?:달|개월)/.test(query)
    ? "두 달분은 각 월의 약정 지급일, 약정액, 실제 입금액을 나눠 미지급액을 합산하세요."
    : "약정 지급일과 실제 입금 내역을 대조해 미지급 기간과 금액을 적어 두세요.";
  const evidenceNote = /근로계약서|계약서|통장|입금\s*내역|거래\s*내역/.test(query)
    ? "보유한 근로계약서와 통장·거래 내역은 원본을 보관하고 제출용 사본을 준비하세요."
    : "근로계약서, 급여명세서, 출퇴근·업무 기록, 통장 입금 내역, 회사의 지급 약속 메시지를 확보하세요.";
  const outOfScopeNote = hasOutOfScopePart
    ? "\n\n코인·가상자산의 매수 시점이나 종목 추천은 이 노동 상담에서 안내하지 않습니다."
    : "";

  return {
    ...baseline,
    answer: [
      `급여일이 지났는데 임금이 입금되지 않았다면 먼저 지급일과 미지급액을 기록으로 고정하세요. ${periodNote}`,
      `${evidenceNote} 회사가 지급을 약속했다면 금액과 지급 예정일을 문자나 이메일처럼 남는 방식으로 다시 확인하세요.`,
      `재직 중 정기 임금은 원칙적으로 매월 1회 이상 정한 날짜에 지급해야 합니다(근로기준법 제43조). 정기 급여일이 이미 지났다면 회사가 새로 약속한 날까지 기다려야만 진정할 수 있는 것은 아닙니다. 1350에서 절차를 상담할 수 있습니다. 정식 임금체불 진정은 전화 상담과 별개로 고용노동부 노동포털에서 온라인 신청하거나 사업장 소재지 관할 고용노동관서를 방문해 접수하고, 준비한 지급일·미지급액·근무 및 입금 자료를 제출하세요(고용노동부 노동포털 「체불임금 해결 방법」).${outOfScopeNote}`,
    ].join("\n\n"),
    answer_type: "general_guidance",
    sources: retrieval.documents.map((document) => document.source),
    suggested_actions: [
      { code: "RECORD_UNPAID_WAGES", label: "지급일·미지급액과 증빙 정리", priority: "now" },
      { code: "FILE_WAGE_COMPLAINT", label: "노동포털 또는 관할 노동관서 확인", url: LABOR_PORTAL, priority: "next" },
    ],
    limitations: [
      "검색된 공식 자료에 따른 일반 절차이며, 실제 근로관계와 미지급액은 계약·근무·입금 기록으로 확인해야 합니다.",
    ],
    guardrail_status: "limited",
  };
}

/** Detect model-added filing prerequisites that are absent from the retrieved wage evidence. */
export function wageArrearsGuardrailHits(query: string, answer: string): string[] {
  if (!hasUnpaidWageQuestion(query)) return [];
  const hits: string[] = [];
  if (/(?:4대보험|고용보험|국민연금).{0,25}(?:가입|가입 여부|확인).{0,20}(?:필요|먼저|해야|하세요)|(?:먼저|필요).{0,20}(?:4대보험|고용보험|국민연금).{0,20}(?:가입|확인)/.test(answer)) {
    hits.push("UNSUPPORTED_WAGE_FILING_PREREQUISITE");
  }
  if (/체불\s*임금등?\s*사업주\s*확인서|체불\s*임금\s*확인서/.test(answer)
    && !/조사|근로감독|체불\s*(?:내용|사실|여부).{0,12}확인|자동.{0,8}(?:발급|교부).{0,8}(?:아니|않)/.test(answer)) {
    hits.push("WAGE_CONFIRMATION_CERTIFICATE_CONDITIONS");
  }
  return hits;
}
