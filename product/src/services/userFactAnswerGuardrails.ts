import type { ChatRequest } from "@/domain/chat";
import { referencedCompanyIds } from "@/services/companyAnswerScope";
import { documentStatusesForRequest } from "@/services/conversationDocumentStatus";
import { extractRecallFacts } from "@/services/conversationRecallService";
import { asksUserDocumentStatus, asksWageDocumentUse } from "@/services/chatQuestionPurpose";
import { mentionedCompanies, statementCompany } from "@/services/conversationCompanyScope";

function companySection(answer: string, name: string, others: string[]): string {
  const start = answer.indexOf(name);
  if (start < 0) return "";
  const end = others.map(other => answer.indexOf(other, start + name.length))
    .filter(index => index > start).sort((a, b) => a - b)[0];
  return answer.slice(start, end ?? answer.length);
}

function documentContradiction(answer: string, request: ChatRequest): boolean {
  if (!asksUserDocumentStatus(request.message) && !asksWageDocumentUse(request.message)) return false;
  // A new direct user correction in this turn supersedes retained history.
  if (!/[?？]/.test(request.message) && /(?:계약서|명세서|통장\s*사본).{0,22}(?:갖고|보유|분실|잃|못\s*받|없)/.test(request.message)) return false;
  const rows = documentStatusesForRequest(request);
  const names = [...new Set(rows.map(row => row.company_name))];
  if (new Set(rows.map(row => row.company_id)).size > names.length) return false;
  const patterns = {
    contract: /(?:근로)?계약서(?!\s*(?:원본|사본))|계약\s*문서/,
    contract_original: /(?:근로)?계약서\s*원본/,
    contract_copy: /(?:근로)?계약서\s*사본/,
    bank_copy: /통장\s*사본/,
    pay_slip: /(?:급여|임금)\s*명세서/,
  };
  const nextDocument = /(?:근로)?계약서|계약\s*문서|통장\s*사본|(?:급여|임금)\s*명세서/;
  return rows.some(row => {
    if (row.document === "contract" && row.state === "unstated"
      && rows.some(other => other.company_id === row.company_id && other.document.startsWith("contract_") && other.state !== "unstated")) return false;
    const section = names.length === 1 ? answer : companySection(answer, row.company_name, names.filter(name => name !== row.company_name));
    if (!section) return false;
    const sentences = section.split(/[.!?。\n]/).filter(sentence => patterns[row.document].test(sentence));
    return sentences.some(sentence => {
      const match = sentence.match(patterns[row.document])!;
      const rest = sentence.slice(match.index! + match[0].length);
      const next = rest.search(nextDocument);
      const clause = sentence.slice(match.index!, next < 0 ? undefined : match.index! + match[0].length + next);
      if (/없다면|없는\s*경우|분실했다면|못\s*받았다면|확인되지|단정할\s*수\s*없/.test(clause)) return false;
      const assertedMissing = /(?:없습니다|없어요|없다|미보유|미교부|받지\s*못했|못\s*받았|분실했|잃어버렸)/.test(clause);
      const assertedHeld = /(?:갖고\s*있|보유하고\s*있|받았|소지하고\s*있)/.test(clause);
      return (row.state === "held" || row.state === "unstated") && assertedMissing
        || (row.state === "lost" || row.state === "absent") && assertedHeld;
    });
  });
}

function paymentContradiction(answer: string, request: ChatRequest): boolean {
  if (!/미지급|입금|잔액|남은\s*금액/.test(request.message)) return false;
  const companies = request.conversation_recall?.companies ?? [];
  if (!mentionedCompanies(request.message, companies).length
    && statementCompany(request.message, request.company_id ?? null, companies).ambiguous) return false;
  const ids = referencedCompanyIds(request.message, companies, request.company_id);
  if (ids.length > 1) return false;
  const current = extractRecallFacts({ content: request.message, source_message_id: "current_request", sequence: Number.MAX_SAFE_INTEGER,
    company_id: request.company_id ?? null, companies });
  const facts = [...(request.conversation_recall?.facts ?? []), ...current]
    .filter(fact => fact.kind === "wage_balance" && (ids.length === 0 ? fact.company_id === null : ids.includes(fact.company_id ?? "")));
  const latest = facts.at(-1);
  const relation = latest?.value?.match(/^(\d+)만 원 중 (\d+)만 원 입금, 남은 금액 (\d+)만 원$/);
  if (!relation) return false;
  const paid = Number(relation[2]);
  const balance = Number(relation[3]);
  const balanceClaim = answer.match(/(?:잔액|남은\s*금액|미지급(?:된)?\s*(?:금액)?)[^\d\n]{0,12}(\d+)\s*만\s*원?/);
  const paidClaim = answer.match(/(?:입금(?:된)?\s*금액|받은\s*금액)[^\d\n]{0,12}(\d+)\s*만\s*원?/);
  return Boolean(balanceClaim && Number(balanceClaim[1]) !== balance
    || paidClaim && Number(paidClaim[1]) !== paid);
}

export function userFactGuardrailHits(answer: string, request: ChatRequest): string[] {
  return [
    ...(documentContradiction(answer, request) ? ["USER_DOCUMENT_STATE_CONTRADICTION"] : []),
    ...(paymentContradiction(answer, request) ? ["USER_PAYMENT_AMOUNT_REVERSED"] : []),
  ];
}
