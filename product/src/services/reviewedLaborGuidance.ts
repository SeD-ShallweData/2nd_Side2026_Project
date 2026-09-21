import type { ChatResponse } from "@/domain/chat";
import type { RagDocument, RagRetrievalResult } from "@/domain/rag";

/** Narrow, source-reviewed evidence bundles; not a replacement for general retrieval.
 * Revalidate on law/procedure changes. Provenance and review boundaries: followup-02.md.
 */
export const LABOR_REVIEW_DATE = "2026-09-21";
type Topic = "night" | "filing" | "certificate";
const PORTAL = "https://labor.moel.go.kr/minwonSysInfo/wagesolway.do";
const GUIDE = "고용노동부 노동포털 「체불임금 해결 방법」";

export function hasUnpaidWageQuestion(query: string): boolean {
  return /(?:월급|급여|임금).{0,12}(?:못\s*받|받지\s*못|안\s*(?:들어|줬|주)|미지급)/.test(query);
}

function nightWorkSize(query: string): "under_five" | "five_plus" | "unknown" {
  if (/(?:5|다섯)\s*(?:명|인)\s*미만|(?:상시(?:근로자)?(?:가|는)?\s*)?(?:4|네)\s*(?:명|인)(?:인|이하|\s)/.test(query)) return "under_five";
  if (/(?:5|다섯)\s*(?:명|인)\s*이상/.test(query)) return "five_plus";
  return "unknown";
}

export function reviewedLaborTopics(query: string): Topic[] {
  const topics: Topic[] = [];
  if (/야간|야근|(?:22\s*시|밤\s*(?:10|열)\s*시|오후\s*10\s*시)/.test(query)
    && /근로|근무|수당|가산|일하|시키|퇴근|임금|야근/.test(query)) topics.push("night");
  if (/체불.{0,20}확인서|사업주\s*확인서/.test(query)) topics.push("certificate");
  if ((/\b1350\b|진정(?:서|을|은|\s)|온라인.{0,12}(?:신고|접수)/.test(query)
    && /체불|임금|월급|급여|노동|진정|상담/.test(query)) || hasUnpaidWageQuestion(query)) topics.push("filing");
  return topics;
}

function document(citation: string, content: string, url: string): RagDocument {
  return { citation, content, distance: null, source: {
    name: citation, citation, category: "labor_law", url, as_of: LABOR_REVIEW_DATE,
    document_id: `reviewed-20260921:${citation}`,
  } };
}

function documents(topic: Topic): RagDocument[] {
  if (topic === "night") return [
    document("근로기준법 제56조", "야간 가산 대상은 22시부터 다음 날 6시 사이의 실제 근로다. 22시에 종료하고 해당 구간에 일하지 않았다면 야간근로 시간이 없다. 법 적용 사업장에서는 해당 시간에 통상임금의 50% 이상을 가산한다. 연장근로와 야간근로는 서로 다르며, 22시 이전에도 연장근로에 해당할 수 있어 소정/실제 근로시간과 휴게를 따로 확인한다.", "https://www.law.go.kr/법령/근로기준법/제56조"),
    document("근로기준법 제11조", "원칙적으로 상시 5명 이상 근로자를 사용하는 사업장에 적용하며, 상시 4명 이하는 시행령이 정한 일부 규정만 적용한다. 규모 미상이면 가산 의무를 확정하지 말고 상시근로자 수를 확인한다. 회사 규모 라벨이나 당일 출근 인원만으로 판단하지 않는다. 동거 친족만 사용하는 사업장과 가사 사용인 등 적용 범위도 확인한다.", "https://www.law.go.kr/법령/근로기준법/제11조"),
    document("근로기준법 시행령 제7조", "별표 1의 상시 4명 이하 사업장 적용 규정에 제56조는 포함되지 않는다. 따라서 상시 5명 미만은 제56조의 법정 연장·야간·휴일 가산임금 적용 대상이 아니다. 이것은 실제 일한 시간의 기본 임금이나 별도로 정한 지급 약정까지 없어지는 뜻이 아니다.", "https://www.law.go.kr/법령/근로기준법시행령/제7조"),
    document("근로기준법 제4조", "근로조건은 근로자와 사용자의 합의로 정한다. 법정 가산임금 적용 여부와 별도로 근로계약·취업규칙 등에 추가 지급 약정이 있는지, 그 조건을 충족하는지 확인해야 한다. 성별·연령·임신 여부는 입력 없이 추정하지 않는다.", "https://www.law.go.kr/법령/근로기준법/제4조"),
  ];
  if (topic === "certificate") return [
    document("임금채권보장법 제12조", "임금등을 지급받지 못한 근로자가 대지급금 청구 또는 법률구조 등 소송 절차에 필요한 경우 체불 임금등·사업주 확인서 발급을 신청할 수 있다. 감독사무 처리 과정에서 확인된 체불 내용에 따라 발급하므로 지급 약속일 경과만으로 자동 발급되는 서류가 아니다.", "https://www.law.go.kr/법령/임금채권보장법/제12조"),
    document(GUIDE, "체불 진정으로 관할 노동관서의 조사·확인을 거쳐 확인서 발급을 신청한다. 확인서는 간이대지급금 청구나 법률구조 소송 등에 쓰며 발급 자체가 지급 확정은 아니다. 대지급금은 근로복지공단의 별도 지급요건 심사가 필요하다. 근로계약서·급여명세서·입금내역 등 미지급 자료를 정리하고 담당 근로감독관에게 신청 목적과 절차를 확인한다.", PORTAL),
  ];
  return [
    document(GUIDE, "임금체불 진정은 고용노동부 노동포털에서 온라인 신청하거나 사업장 소재지 관할 고용노동관서를 방문하여 접수한다. 전화 상담과 진정서 접수는 별개다. 근로계약서, 급여명세서, 입금·근무 기록 등 지급일과 미지급 내역을 확인할 자료를 정리한다.", PORTAL),
    document("고용노동부 「고용노동부 고객상담센터 1350」", "1350은 고용노동 분야 전화 상담·안내 창구다. 전화 상담만으로 정식 진정서가 제출·접수된 것으로 안내하지 않는다.", "https://www.moel.go.kr/news/cardinfo/view.do?bbs_seq=20250900032"),
  ];
}

export function reviewedLaborRetrieval(query: string): RagRetrievalResult | null {
  const topics = reviewedLaborTopics(query);
  if (!topics.length) return null;
  const unique = new Map(topics.flatMap(documents).map((doc) => [doc.citation, doc]));
  return { query, status: "matched", reason: "reviewed_applicability_bundle", topic: topics.join("+"),
    threshold: null, documents: [...unique.values()] };
}

/** Source-linked, useful replacement only for the selected issue, never a global fallback. */
export function reviewedLaborFallback(query: string, baseline: ChatResponse): ChatResponse | null {
  const retrieval = reviewedLaborRetrieval(query);
  if (!retrieval) return null;
  const paragraphs = reviewedLaborTopics(query).map((topic) => {
    if (topic === "night") return [
      `${/(?:22\s*시|10\s*시|열\s*시)까지/.test(query) ? "22시까지 일하고 바로 종료했다면 그 사실만으로 야간근로가 되는 것은 아닙니다. " : ""}야간근로는 22시부터 다음 날 6시 사이의 실제 근로이며, 22시 이후 일한 시간이 있는지 구분해야 합니다(근로기준법 제56조).`,
      `${nightWorkSize(query) === "under_five" ? "상시 4명인 경우처럼 상시 5명 미만이면 제56조의 법정 야간 가산임금 규정은 적용되지 않습니다. " : ""}상시 5명 이상 사업장에서는 해당 야간근로에 통상임금의 50% 이상을 가산하는 것이 원칙입니다. ${nightWorkSize(query) !== "under_five" ? "상시 5명 미만이면 이 법정 가산임금 규정은 적용되지 않습니다. " : ""}${nightWorkSize(query) === "unknown" ? "상시근로자 수가 몇 명인지 확인해 주시겠어요? " : ""}(근로기준법 제11조, 근로기준법 시행령 제7조, 근로기준법 제56조).`,
      "법정 가산 대상이 아니어도 실제 일한 시간의 임금은 별개이며, 근로계약·취업규칙에 별도 수당 지급 약정이 있는지도 확인하세요(근로기준법 제4조). 출퇴근·휴게 기록과 급여명세서를 대조하고, 22시 이전의 연장근로수당은 실제 근로시간과 적용 요건을 따로 확인하세요(근로기준법 제56조). 상시근로자 수나 기록 해석이 어렵다면 1350에서 상담받을 수 있습니다.",
    ].join("\n\n");
    if (topic === "certificate") return [
      "체불 임금등·사업주 확인서는 임금등을 지급받지 못한 근로자가 대지급금 청구 또는 법률구조 등 소송에 필요한 경우 신청하는 서류입니다. 약속한 지급일이 지났다는 이유만으로 자동 발급되지는 않고, 근로감독 과정에서 체불 내용이 확인되어야 합니다(임금채권보장법 제12조).",
      `먼저 미지급 임금·지급일과 근로계약서·급여명세서·입금내역을 정리해 노동포털 온라인 진정 또는 관할 고용노동관서 방문으로 접수하세요. 조사·확인 후 담당 근로감독관에게 사용 목적을 알리고 확인서 발급을 신청합니다. 이미 조사를 받았다면 새 진정부터 반복하기보다 담당자에게 발급 가능 여부를 확인하세요(${GUIDE}).`,
      `발급받은 뒤 대지급금 청구는 근로복지공단, 법률구조·소송은 대한법률구조공단 등 해당 절차로 이어집니다. 확인서 발급이 곧 지급 확정은 아니며 각 제도의 자격·기한·지급요건은 별도 확인이 필요합니다(${GUIDE}).`,
    ].join("\n\n");
    return `${/지표|긍정|신호/.test(query) ? "납부·고용 지표는 실제 임금 지급이나 과거 체불 부재를 증명하지 않습니다. 미지급 사실은 지표와 별개로 지급일과 입금내역을 대조해야 합니다.\n\n" : ""}1350은 전화 상담·안내 창구이며, 전화 상담만으로 임금체불 진정서가 정식 접수되는 것은 아닙니다(고용노동부 「고용노동부 고객상담센터 1350」).\n\n진정은 고용노동부 노동포털에서 온라인으로 신청하거나 사업장 소재지 관할 고용노동관서를 방문해 접수하세요. 지급일·미지급 내역과 근로계약서·급여명세서·입금·근무 기록을 정리하고, 접수 후 담당자의 조사 안내를 확인하세요(${GUIDE}).`;
  });
  return { ...baseline, answer: paragraphs.join("\n\n"), answer_type: "general_guidance",
    sources: retrieval.documents.map((doc) => doc.source), guardrail_status: "limited",
    limitations: ["공식 자료의 일반 기준이며 실제 근로관계·기록과 개별 제도의 적용 요건을 확인해야 합니다."],
    suggested_actions: [{ code: "CHECK_WORK_RECORDS", label: "근로계약·근무·지급 기록 확인", priority: "now" },
      { code: "CONTACT_LABOR_HOTLINE", label: "1350 상담 또는 노동포털 절차 확인", url: PORTAL, priority: "next" }],
  };
}

/** Observable omissions + known contradictory relations. Not a legal correctness oracle. */
export function applicabilityGuardrailHits(query: string, answer: string): string[] {
  const hits: string[] = [];
  const text = answer.replace(/[*_]/g, "");
  for (const topic of reviewedLaborTopics(query)) {
    const size = nightWorkSize(query);
    const requirements = topic === "night"
      ? [/(?:22\s*시|10\s*시|열\s*시)/, /(?:6\s*시|여섯\s*시)/, /(?:5|다섯)\s*(?:명|인)/,
        ...(size === "under_five" ? [/적용(?:되지|하지|\s*제외)|의무.{0,8}없/, /약정|계약|취업규칙/] : [/50\s*%|100분의\s*50/]),
        ...(size === "unknown" ? [/상시[^.\n]{0,45}(?:확인|몇\s*명)|(?:몇\s*명|확인)[^.\n]{0,30}상시/] : []),
        ...(/약정|계약/.test(query) ? [/약정|계약/] : []),
        ...(/(?:22\s*시|10\s*시|열\s*시)까지/.test(query) ? [/(?:22\s*시|10\s*시|열\s*시)(?:까지|에)[^.\n]{0,100}(?:아니|아닙|않|없)/] : [])]
      : topic === "certificate"
        ? [/대지급금/, /소송|법률구조/, /조사|근로감독/, /확인서[^.\n]{0,40}(?:신청|요청)|발급[^.\n]{0,15}신청/, /지급.{0,15}(?:요건|심사)|요건.{0,12}(?:확인|심사)/]
        : [/1350/, /상담/, /노동포털/, /진정/, /관할|고용노동관서/];
    if (requirements.some((pattern) => !pattern.test(text))) hits.push(`APPLICABILITY_${topic.toUpperCase()}_CONDITIONS`);
  }
  if (/(?:22\s*시|10\s*시|열\s*시)까지[^.\n]{0,50}(?:야간근로(?:에\s*해당합니다|입니다|로\s*분류됩니다)|야간\s*수당을\s*(?:지급해야|받을\s*수\s*있))/.test(text)) hits.push("NIGHT_END_TIME_CONFUSION");
  if (/(?:5\s*(?:명|인)\s*미만|4\s*(?:명|인)(?:\s*이하)?)[^.\n]{0,60}(?:법정|법적)[^.\n]{0,45}(?:의무가\s*(?:있|적용)|반드시\s*지급|적용됩니다)/.test(text)) hits.push("SMALL_WORKPLACE_PREMIUM_CONFUSION");
  if (/1350(?:에|으로)[^.\n]{0,30}(?:진정서[를가]?\s*(?:제출|접수)|진정을\s*접수)/.test(text)) hits.push("HOTLINE_FILING_CONFUSION");
  if (/진정서\s*조회.{0,8}메뉴|양식을\s*내려받아/.test(text) && reviewedLaborTopics(query).includes("filing")) hits.push("UNVERIFIED_FILING_UI_DETAIL");
  return hits;
}
