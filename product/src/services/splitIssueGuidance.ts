import type { ChatRequest, ChatResponse } from "@/domain/chat";
import { locationAliases } from "@/services/conversationCompanyScope";

/** The two actions are already explicit in the user's question; no classifier guess is needed. */
export function asksSplitWageInjuryActions(message: string): boolean {
  return /임금|급여|월급|체불/.test(message)
    && /발목|부상|다친|사고/.test(message)
    && /나눠|각각|구분|별도/.test(message)
    && /다음|우선|행동|자료|근거/.test(message);
}

export function splitWageInjuryGuidance(message: string, baseline: ChatResponse, request?: ChatRequest): ChatResponse {
  const companies = request?.conversation_recall?.companies ?? [];
  const label = (pattern: RegExp) => {
    const match = message.match(pattern);
    if (!match) return undefined;
    const before = message.slice(0, match.index).trim().split(/\s+/).at(-1) ?? "";
    const scoped = companies.find(company => company.company_name === match[1] && locationAliases(company).includes(before));
    return scoped ? `${before} ${match[1]}` : match[1];
  };
  const wageCompany = label(/([가-힣A-Za-z0-9]+)(?:의)?\s*(?:임금|급여|월급|체불)/);
  const injuryCompany = label(/([가-힣A-Za-z0-9]+)(?:의)?\s*(?:발목|부상|사고)/);
  const factNote = (companyLabel: string | undefined, kinds: string[]) => {
    const company = companies.find(item => companyLabel?.includes(item.company_name)
      && (companies.filter(other => other.company_name === item.company_name).length === 1
        || locationAliases(item).some(alias => companyLabel.includes(alias))));
    if (!company) return "";
    const latest = new Map<string,string>();
    for (const fact of request?.conversation_recall?.facts ?? []) {
      if (fact.company_id === company.company_id && kinds.includes(fact.kind) && fact.value) latest.set(fact.kind,fact.value);
    }
    return latest.size ? `사용자 진술은 ${[...latest.values()].join(", ")}입니다. ` : "";
  };
  return {
    ...baseline,
    answer: [
      `1. ${wageCompany ? `${wageCompany} ` : ""}임금: ${factNote(wageCompany,["payday","resignation_date","wage_balance"])}약정 지급일·대상 기간·실제 입금액을 대조해 부족분이 있는지 적고, 근로계약서·급여명세서·입금 기록을 구분해 보관하세요. 회사에 차액과 지급 예정일을 남는 방식으로 확인하세요.`,
      `2. ${injuryCompany ? `${injuryCompany} ` : ""}발목: ${factNote(injuryCompany,["accident_location"])}상태 확인과 필요한 진료를 우선하고, 사고 시간·장소·당시 업무·목격 내용과 진료 기록을 따로 보관하세요. 임금 자료를 사고 입증 자료로 바꾸어 쓰지 마세요.`,
      "근거 범위: 위 회사명과 문제는 현재 질문의 사용자 진술이며, 공개 회사 카드가 개인의 미지급액이나 부상 사실을 입증하지 않습니다. 공식 법률 검색 근거가 이 두 항목 모두에 직접 적용되는지 확인되지 않아 법적 인정 여부는 단정하지 않습니다.",
    ].join("\n\n"),
    answer_type: "general_guidance",
    sources: [],
    suggested_actions: [],
    limitations: ["사용자 진술을 기준으로 한 기록·확인 순서이며, 법적 인정 여부와 실제 상태는 별도 자료 확인이 필요합니다."],
    guardrail_status: "limited",
  };
}

export function splitWageInjuryGuardrailHits(message: string, answer: string): string[] {
  if (!asksSplitWageInjuryActions(message)) return [];
  if (!/(?:임금|급여|월급|체불)/.test(answer)
    || !/(?:발목|부상|사고)/.test(answer)
    || !/(?:기록|대조|입금)/.test(answer)
    || !/(?:진료|치료|의료)/.test(answer)
    || !/(?:사용자\s*진술|공개\s*(?:회사\s*)?카드|근거\s*범위)/.test(answer)) {
    return ["SPLIT_WAGE_INJURY_ACTION_MISSING"];
  }
  return [];
}
