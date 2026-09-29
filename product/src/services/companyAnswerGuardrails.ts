import type { ComparisonContext } from "@/domain/chatComparison";
import { locationAliases } from "@/services/conversationCompanyScope";
import type { RecallCompany } from "@/services/conversationCompanyScope";

function companyAnchor(answer: string, company: RecallCompany): number | undefined {
  const candidates = locationAliases(company).flatMap((alias) => {
    const positions: Array<{ index: number; score: number }> = [];
    let index = answer.indexOf(alias);
    while (index >= 0) {
      const endOfLine = answer.indexOf("\n", index);
      const line = answer.slice(index, endOfLine < 0 ? undefined : endOfLine);
      if (line.slice(0, 35).includes(company.company_name)) {
        const prefix = answer.slice(answer.lastIndexOf("\n", index - 1) + 1, index);
        positions.push({ index, score: /^\s*(?:[-*]|\d+\.)\s*\**\s*$/.test(prefix) ? 2 : prefix.trim() === "" ? 1 : 0 });
      }
      index = answer.indexOf(alias, index + alias.length);
    }
    return positions;
  });
  return candidates.sort((a, b) => b.score - a.score || b.index - a.index)[0]?.index;
}

function companySection(answer: string, company: RecallCompany, others: RecallCompany[]): string {
  const start = companyAnchor(answer, company)
    ?? locationAliases(company).map((alias) => answer.indexOf(alias))
      .filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (start === undefined) return "";
  const end = others.map((other) => companyAnchor(answer.slice(start + 2), other))
    .filter((index): index is number => index !== undefined).map((index) => index + start + 2)
    .filter((index) => index > start).sort((a, b) => a - b)[0];
  return answer.slice(start, end ?? answer.length);
}

function reversesWageWatch(section: string): boolean {
  const noSignal = /(?:뚜렷한\s*이상\s*신호\s*없음|이상\s*신호가?\s*없|이상\s*없음)/g;
  for (const match of section.matchAll(noSignal)) {
    const before = section.slice(Math.max(0, match.index - 110), match.index);
    if (/(?:이상\s*신호가?\s*없).{0,12}(?:아니|못|불가)/.test(section.slice(match.index, match.index + 35))) continue;
    const wage = Math.max(before.lastIndexOf("임금"), before.lastIndexOf("급여"));
    const safety = Math.max(before.lastIndexOf("안전"), before.lastIndexOf("산재"));
    if (/(?:임금|급여).{0,30}모두/.test(before) || wage > safety) return true;
  }
  return false;
}

export function companyAnswerGuardrailHits(answer: string, context: ComparisonContext): string[] {
  const hits: string[] = [];
  const cards = context.companyContexts?.length ? context.companyContexts
    : context.companyContext ? [context.companyContext] : [];
  if (context.questionIntent === "company" && cards.length) {
    if (answer.split(/[.!?。\n]/).some((sentence) =>
      /체불(?:이|로|을|를)?\s*(?:확정|입증|확인)/.test(sentence)
      && !/(?:체불(?:이|로|을|를)?\s*(?:확정|입증|확인).{0,20}(?:아니|아닙|않|못|불가|없))/.test(sentence))) {
      hits.push("WAGE_CARD_AS_CONFIRMED_ARREARS");
    }
    const sameName = cards.length > 1 && new Set(cards.map((card) => card.company_name)).size < cards.length;
    if (sameName && cards.some((card) => !locationAliases(card).some((alias) => answer.includes(alias)))) {
      hits.push("SAME_NAME_LOCATION_MISSING");
    }
    for (const card of cards) {
      const section = cards.length > 1 ? companySection(answer, card, cards.filter((other) => other.company_id !== card.company_id)) : answer;
      if (card.risk.wage_risk.level === "watch" && reversesWageWatch(section)) {
        hits.push("WAGE_WATCH_REVERSED");
      }
    }
  }

  // Only a request explicitly separating wage and injury topics enables this
  // narrow guard. It never infers a company's facts from arbitrary history.
  const companies = context.request.conversation_recall?.companies ?? [];
  if (/섞지|구분/.test(context.request.message) && /임금/.test(context.request.message)
    && /발목|부상|사고/.test(context.request.message)) {
    const named = companies.filter((company) => context.request.message.includes(company.company_name));
    if (named.length === 2 && named[0].company_name !== named[1].company_name) {
      const injury = named.find((company) => {
        const start = context.request.message.indexOf(company.company_name);
        return /발목|부상|사고/.test(context.request.message.slice(start, start + 20));
      });
      if (injury) {
        const injurySection = answer.slice(answer.indexOf(injury.company_name));
        const other = named.find((company) => company.company_id !== injury.company_id)!;
        const nextOther = injurySection.indexOf(other.company_name, injury.company_name.length);
        const scoped = nextOther >= 0 ? injurySection.slice(0, nextOther) : injurySection;
        if (injurySection && /급여명세서|임금체불|입금\s*내역|근로계약서/.test(scoped)) {
          hits.push("CROSS_COMPANY_TOPIC_LEAK");
        }
      }
    }
  }
  return [...new Set(hits)];
}
