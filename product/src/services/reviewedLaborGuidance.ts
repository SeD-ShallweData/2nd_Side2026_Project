import type { ChatResponse } from "@/domain/chat";
import type { RagDocument, RagRetrievalResult } from "@/domain/rag";

/** Narrow, source-reviewed evidence bundles; not a replacement for general retrieval.
 * Revalidate on law/procedure changes. Provenance and review boundaries: followup-02.md.
 */
export const LABOR_REVIEW_DATE = "2026-09-21";
type Topic = "night" | "filing" | "certificate" | "payment";
const PORTAL = "https://labor.moel.go.kr/minwonSysInfo/wagesolway.do";
const GUIDE = "고용노동부 노동포털 「체불임금 해결 방법」";

/** Timing/recordkeeping intent, not a claim that retirement or agreement occurred. */
export function isPaymentTimingQuestion(query: string): boolean {
  if (/퇴직금|퇴직연금/.test(query) && !/제?\s*36\s*조|금품\s*청산/.test(query)) return false;
  return /제?\s*36\s*조|금품\s*청산/.test(query)
    || (/퇴직|퇴사|사망/.test(query) && /임금|월급|급여|금품|지급|14일|2주/.test(query))
    || (/지급|입금/.test(query) && /약속|하겠|예정|기일.{0,10}(?:연장|합의)/.test(query)
      && /회사|사장|문자|메시지|기록|못\s*받|언제|문의|합의|진정/.test(query));
}

function needsPaymentRecords(query: string): boolean {
  return /문자|메시지|카톡/.test(query) && /기록|보관|남겨|보존|준비/.test(query);
}

function needsSettlementConditions(query: string): boolean {
  return /퇴직|퇴사|사망|제?\s*36\s*조|금품\s*청산|기일.{0,10}(?:연장|합의)/.test(query);
}

function paymentTimingAnswer(query: string): string {
  const record = needsPaymentRecords(query)
    ? `회사 문자 원문과 앞뒤 대화가 보이도록 캡처하고 원본도 보관하세요. 발신자 이름·번호와 수신 날짜·시각, 약속 금액, 대상 임금 기간, 약속 지급일을 따로 적어 두세요. ${/다음\s*주/.test(query) ? "‘다음 주’는 문자에 적힌 표현 그대로 남기고 임의의 날짜로 바꾸지 마세요. " : ""}금액이나 정확한 지급 날짜가 없으면 미확인으로 표시하고 회사에 문자로 확인을 요청하세요. 기존 정기 급여일·미지급액과 실제 입금 내역도 구분해 보관하세요. 이는 사실관계 확인을 돕는 기록 제안이며 전부 갖춰야만 진정할 수 있는 필수서류 목록은 아닙니다.`
    : "기존 정기 급여일, 대상 임금 기간·금액, 실제 입금 내역과 회사가 약속한 지급일을 구분해 정리하세요.";
  const settlement = needsSettlementConditions(query)
    ? "퇴직 또는 사망한 경우의 금품 청산은 원칙적으로 그 지급 사유가 발생한 때부터 14일 이내이며, 특별한 사정이 있을 때 당사자 사이의 합의로 기일을 연장할 수 있습니다(근로기준법 제36조). 회사의 일방적인 지급 약속만으로 연장 합의가 성립했다고 볼 수 없고, 약속일에서 새 14일을 세는 것도 아닙니다. 실제 퇴직·사망 여부와 발생일, 특별한 사정 및 합의 내용은 기록으로 확인해야 합니다."
    : "퇴직·사망 사실이나 지급기일 연장 합의가 있었다고 추정하지 않습니다. 회사가 새 지급일을 알렸다는 사실과 당사자가 기일 연장에 합의했다는 사실은 구별해야 합니다.";
  const filing = needsSettlementConditions(query)
    ? "퇴직·사망 후 청산기한과 연장 합의 내용, 재직 중 정기 지급일에 이미 발생한 미지급을 구분해 확인하세요. 합의한 날짜·대상 금품이 불명확하면 회사에 서면 확인을 요청하고 관할 노동관서에 적용을 문의하세요."
    : "정기 급여일이 이미 지났는데 임금을 받지 못했다면 회사의 새 약속일까지 기다려야만 진정할 수 있는 것은 아닙니다.";
  return [record, "재직 중 정기 임금은 원칙적으로 매월 1회 이상 정해진 날에 지급해야 합니다(근로기준법 제43조).", settlement,
    `${filing} 정식 임금체불 진정은 고용노동부 노동포털 온라인 신청 또는 사업장 소재지 관할 고용노동관서 방문으로 접수합니다. 1350은 절차 상담 창구로 정식 진정 접수와 별개입니다(${GUIDE}).`].join("\n\n");
}

/** Checks conditional relations and necessary content, not just one observed phrase. */
export function paymentTimingGuardrailHits(query: string, answer: string): string[] {
  const text = answer.replace(/[*_]/g, "");
  const hits: string[] = [];
  if (/(?:자료|서류|증빙)[^.\n]{0,70}(?:모두|전부).{0,15}(?:갖춘\s*뒤|갖춰야|준비해야)|(?:자료|서류|증빙)[^.\n]{0,70}함께\s*제출해야/.test(text)
    && /진정|체불/.test(text) && !/없어도|어려워도|필수.{0,12}아닙/.test(text)) hits.push("WAGE_EVIDENCE_NOT_PREREQUISITE");
  const clauses = text.split(/[.。!?\n]+/);
  for (const clause of clauses) {
    if (!/14\s*일|2\s*주|십사\s*일/.test(clause)) continue;
    if (!/임금|금품|지급|청산|36\s*조/.test(clause)) continue;
    const negated = /아닙니다|아니며|아니고|아니라|않습니다|없습니다|적용할 수 없/.test(clause);
    if (!negated && (!/퇴직|퇴사|사망/.test(clause)
      || /(?:약속|예정|정기|급여일)[^。.!?\n]{0,35}(?:부터|기준|기산)/.test(clause))) {
      hits.push("PAYMENT_SETTLEMENT_TRIGGER");
    }
  }
  if (!isPaymentTimingQuestion(query)) return [...new Set(hits)];
  if (needsPaymentRecords(query) && [/원문|원본/, /발신|보낸\s*사람/, /수신|받은\s*(?:날|시)|받았.*시각/, /금액/, /지급\s*(?:예정일|일|날짜)|지급할\s*날짜/].some(p => !p.test(text))) hits.push("PAYMENT_RECORD_DETAILS");
  if (needsPaymentRecords(query) && /다음\s*주/.test(query)
    && (!/다음\s*주/.test(text) || !/미확인|정확한.{0,20}확인|임의.{0,15}(?:날짜|확정)|날짜.{0,20}확인/.test(text))) hits.push("PAYMENT_PROMISE_UNCERTAINTY");
  if (/문의|어디|진정|신고/.test(query) && [/노동포털/, /관할/, /1350/, /정기\s*(?:급여일|지급일)|정해진\s*(?:급여일|지급일)/].some(p => !p.test(text))) hits.push("PAYMENT_NEXT_STEPS");
  if ((/합의|연장/.test(query) || (needsSettlementConditions(query) && clauses.some(clause => /14\s*일/.test(clause) && /지급해야|지급하여야|지급해야\s*합니다|청산해야/.test(clause))))
    && [/특별한\s*사정/, /당사자|쌍방/, /합의/].some(p => !p.test(text))) hits.push("PAYMENT_EXTENSION_CONDITIONS");
  if (/약속.{0,20}(?:지나야|지난\s*후에만)|(?:14일|2주).{0,15}기다린.{0,12}(?:진정|신고)/.test(text)) hits.push("PAYMENT_FILING_DELAY");
  return [...new Set(hits)];
}

export function hasUnpaidWageQuestion(query: string): boolean {
  const wage = "(?:월급|급여|임금|수당)";
  const unpaid = "(?:못\\s*받|받지\\s*못|안\\s*(?:들어|줬|주)|들어오지\\s*않|미지급|미입금|체불|밀렸|밀린|지급일.{0,5}(?:지났|넘겼)|월급날.{0,5}(?:지났|넘겼)|입금.{0,7}(?:없|안\\s*됐|되지\\s*않|들어오지\\s*않))";
  return new RegExp(`${wage}.{0,18}${unpaid}|${unpaid}.{0,18}${wage}`).test(query);
}

/** An explicit user-side nonpayment report overrides a mistaken company intent. */
export function hasActualUnpaidWageReport(query: string): boolean {
  return hasUnpaidWageQuestion(query)
    && /못\s*받(?:았|았습니다)|받지\s*못(?:했|했습니다)|안\s*줬|미입금|안\s*들어(?:왔|왔습니다)|들어오지\s*않(?:았|았습니다)|미지급(?:됐|되었|입니다|이다)|(?:지급일|월급날).{0,8}(?:지났|넘겼)/.test(query);
}

function nightWorkSize(query: string): "under_five" | "five_plus" | "unknown" {
  if (/(?:5|다섯)\s*(?:명|인)\s*미만|(?:상시(?:근로자)?(?:가|는)?\s*)?(?:4|네)\s*(?:명|인)(?:인|이하|\s)/.test(query)) return "under_five";
  if (/(?:5|다섯)\s*(?:명|인)\s*이상/.test(query)) return "five_plus";
  return "unknown";
}

export function reviewedLaborTopics(query: string): Topic[] {
  const topics: Topic[] = [];
  if (isPaymentTimingQuestion(query)) topics.push("payment");
  if (/야간|야근|(?:22\s*시|밤\s*(?:10|열)\s*시|오후\s*10\s*시)/.test(query)
    && /근로|근무|수당|가산|일하|시키|퇴근|임금|야근/.test(query)) topics.push("night");
  if (/체불.{0,20}확인서|사업주\s*확인서/.test(query)) topics.push("certificate");
  if (/\b1350\b|진정(?:서|을|은|\s)|온라인.{0,12}(?:신고|접수)/.test(query)
    && /체불|임금|월급|급여|노동|진정|상담/.test(query)) topics.push("filing");
  return topics;
}

function document(citation: string, content: string, url: string): RagDocument {
  return { citation, content, distance: null, source: {
    name: citation, citation, category: "labor_law", url, as_of: LABOR_REVIEW_DATE,
    document_id: `reviewed-20260921:${citation}`,
  } };
}

function documents(topic: Topic): RagDocument[] {
  if (topic === "payment") return [
    document("근로기준법 제43조", "재직 중 정기 임금은 원칙적으로 매월 1회 이상 정한 날짜에 전액 지급한다. 임시 임금 등 법정 예외는 별도로 확인한다. 회사가 일방적으로 다음 지급을 약속한 날은 기존 정기 지급일과 구별한다.", "https://www.law.go.kr/LSW/lsLinkCommonInfo.do?chrClsCd=010202&lsJoLnkSeq=1029729647"),
    document("근로기준법 제36조", "사망 또는 퇴직한 근로자의 금품 청산에 적용한다. 원칙적 14일은 그 지급 사유(사망·퇴직) 발생 때부터다. 특별한 사정이 있으면 당사자 사이의 합의로 기일을 연장할 수 있다. 회사의 일방적 지급 약속은 연장 합의가 아니며 약속일에서 새 14일을 세지 않는다. 퇴직·사망 사실이 없으면 이 청산기한을 현재 사안에 적용하지 않는다.", "https://www.law.go.kr/LSW/lsSideInfoP.do?docCls=jo&joBrNo=00&joNo=0036&lsiSeq=283457&urlMode=lsScJoRltInfoR"),
    document(GUIDE, "재직자는 정기지급일에 임금 전부나 일부를 받지 못했다면 임금체불 진정을 제기할 수 있다. 회사가 새로 약속한 날까지 기다려야만 진정할 수 있는 것은 아니다. 노동포털 온라인 또는 사업장 소재지 관할 지방고용노동관서 방문으로 접수한다. 1350은 상담이며 정식 접수와 다르다.", "https://labor.moel.go.kr/minwonApply/minwonFormat.do?searchVal=SN001"),
    document("고용노동부 빠른인터넷상담 「임금체불 진정 입증자료 안내」", "급여자료·근로계약서·근로시간 증빙자료는 사실관계 조사에 도움이 된다. 별도 증빙이 어려워도 진정 후 담당 감독관 조사에서 확인할 수 있다. 다음은 그 안내를 구체화한 서비스의 기록 제안이며 법정 필수서류 목록은 아니다: 회사 문자 원문·발신자·수신 일시·약속 금액·약속 지급일·대상 임금 기간·실제 입금 내역을 보존하고, 빠진 내용은 추가 확인한다.", "https://www.moel.go.kr/minwon/fastcounsel/fastcounselView.do?inetDcssMngId=202207131221236051000"),
  ];
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
  const unique = new Map(topics.flatMap(documents)
    .filter(doc => doc.citation !== "근로기준법 제36조" || needsSettlementConditions(query))
    .map((doc) => [doc.citation, doc]));
  return { query, status: "matched", reason: "reviewed_applicability_bundle", topic: topics.join("+"),
    threshold: null, documents: [...unique.values()] };
}

/** Source-linked, useful replacement only for the selected issue, never a global fallback. */
export function reviewedLaborFallback(query: string, baseline: ChatResponse): ChatResponse | null {
  const retrieval = reviewedLaborRetrieval(query);
  if (!retrieval) return null;
  const paragraphs = reviewedLaborTopics(query).map((topic) => {
    if (topic === "payment") return paymentTimingAnswer(query);
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
  const hits: string[] = paymentTimingGuardrailHits(query, answer);
  const text = answer.replace(/[*_]/g, "");
  for (const topic of reviewedLaborTopics(query)) {
    if (topic === "payment") continue;
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
