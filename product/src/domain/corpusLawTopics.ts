/**
 * 2026-10 RAG 코퍼스에 추가한 산업재해보상보험법·외국인근로자의 고용 등에 관한 법률
 * 주제를 알아보는 규칙.
 *
 * 이 주제는 임금 규칙과 낱말이 겹칩니다. 예를 들어 "요양급여·휴업급여·유족급여"에는
 * "급여"가 들어 있습니다. 그래서 규칙이 없으면 이런 질문이 검토된 임금 번들이나
 * 응급 안내로 빠져 RAG에 닿지 못합니다. 여기서는 두 법이 직접 다루는 절차·급여 이름만
 * 봅니다. 산업안전보건법·중대재해처벌법은 여전히 수록 범위 밖이므로 넣지 않습니다.
 */

/** 산재보험 급여·절차. 회사 화면의 "산업재해 카드·지표·신호" 질문은 제외한다. */
const INDUSTRIAL_ACCIDENT_INSURANCE =
  /산재|산업재해|업무상\s*(?:재해|사고|질병)|요양급여|휴업급여|장해급여|유족급여|상병보상연금|간병급여|근로복지공단/;
const COMPANY_SIGNAL_CONTEXT = /카드|지표|신호|공표|우선순위|집계/;

/** 외국인고용법 고유 제도. "보증보험·상해보험"은 전세보증보험 등과 겹쳐 외국인 맥락이 함께 있어야 한다. */
const FOREIGN_EMPLOYMENT_PROCEDURE =
  /출국만기|귀국비용\s*보험|고용허가|외국인\s*(?:근로자|노동자)?\s*고용\s*(?:제한|허가)|(?:외국인|이주\s*노동자|E-?9|비자).{0,30}(?:보증보험|상해보험|사업장\s*(?:변경|이동|을\s*(?:옮|바꾸)))|사업장\s*변경.{0,20}(?:신청|허가|횟수|몇\s*(?:번|회)|고용센터)|(?:보증보험|상해보험).{0,30}외국인/i;

export function asksIndustrialAccidentInsurance(message: string): boolean {
  return INDUSTRIAL_ACCIDENT_INSURANCE.test(message) && !COMPANY_SIGNAL_CONTEXT.test(message);
}

export function asksForeignEmploymentProcedure(message: string): boolean {
  return FOREIGN_EMPLOYMENT_PROCEDURE.test(message);
}

/** 두 법 중 하나의 고유 절차·급여를 묻는지. 노동 상담 경로로 보내는 근거로만 쓴다. */
export function asksNewCorpusLawTopic(message: string): boolean {
  return asksIndustrialAccidentInsurance(message) || asksForeignEmploymentProcedure(message);
}
