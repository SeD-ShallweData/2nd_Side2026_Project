import type { ConversationDocumentStatement } from "@/domain/conversationRecall";
import type { ChatRequest } from "@/domain/chat";
import { referencedCompanyIds } from "@/services/companyAnswerScope";
import { defaultStatementSubject, hasCompanyLocationQualifier, mentionedCompanies, recallCompanyLabel, statementCompanies, statementCompany } from "@/services/conversationCompanyScope";

export type DocumentName = "contract" | "contract_original" | "contract_copy" | "bank_copy" | "pay_slip";
export type DocumentState = "held" | "lost" | "absent" | "unstated";
export interface UserDocumentStatus {
  company_id: string | null;
  document: DocumentName;
  state: DocumentState;
  source_message_id: string | null;
}

const names: DocumentName[] = ["contract", "contract_original", "contract_copy", "bank_copy", "pay_slip"];
const missing = /없|분실|잃|못\s*받|(?:보유|보관)하지\s*않|갖고\s*있지\s*않/;
const present = /갖고|보유|보관|소지|받았|있습니다|있어요/;

function documentClause(text: string, marker: RegExp, nextDocument: RegExp): string {
  const match = text.match(marker);
  if (!match) return "";
  const rest = text.slice(match.index! + match[0].length);
  const next = rest.search(nextDocument);
  return `${match[0]}${next < 0 ? rest : rest.slice(0, next)}`;
}

/** Only unambiguous document statements update status. Silence stays unstated. */
export function documentStatusFromStatements(
  statements: ConversationDocumentStatement[], companyIds: Array<string | null>,
): UserDocumentStatus[] {
  const status = new Map<string, UserDocumentStatus>();
  const set = (company_id: string | null, document: DocumentName, state: DocumentState, source_message_id: string) => {
    status.set(`${company_id}:${document}`, { company_id, document, state, source_message_id });
  };
  for (const item of statements) {
    const company = item.company_id;
    if (!companyIds.includes(company)) continue;
    const text = item.text.replace(/임금\s*명세서/g, "급여명세서").replace(/사진\s*(?:사본)?/g, "사본");
    const contract = /(?:근로)?계약서|계약\s*문서/.test(text);
    if (contract && !/원본|사본/.test(text.replace(/통장\s*사본/g, ""))) {
      const subject = text.match(/(?:근로)?계약서|계약\s*문서/)!;
      const tail = text.slice(subject.index! + subject[0].length)
        .split(/통장\s*사본|급여\s*명세서/)[0];
      const state = /(?:분실|잃)/.test(tail) ? "lost" : missing.test(tail) ? "absent"
        : present.test(tail) ? "held" : null;
      if (state) set(company, "contract", state, item.source_message_id);
    }
    // "계약서 원본과 통장 사본" mentions a bank copy, not a contract copy.
    const withoutBankCopy = text.replace(/통장\s*사본/g, "");
    if (contract && /원본/.test(text)) {
      const clause = documentClause(text, /원본/, /사본|통장|급여\s*명세서/);
      if (missing.test(clause))
        set(company, "contract_original", /분실|잃/.test(clause) ? "lost" : "absent", item.source_message_id);
      else if (present.test(clause) || present.test(text) && !missing.test(text))
        set(company, "contract_original", "held", item.source_message_id);
    }
    if (contract && /사본/.test(withoutBankCopy)) {
      const clause = documentClause(withoutBankCopy, /사본/, /원본|통장|급여\s*명세서/);
      if (missing.test(clause))
        set(company, "contract_copy", /분실|잃/.test(clause) ? "lost" : "absent", item.source_message_id);
      else if (present.test(clause) || present.test(withoutBankCopy) && !missing.test(withoutBankCopy))
        set(company, "contract_copy", "held", item.source_message_id);
    }
    if (/통장\s*사본/.test(text)) {
      const clause = documentClause(text, /통장\s*사본/, /(?:근로)?계약서|급여\s*명세서/);
      if (missing.test(clause))
        set(company, "bank_copy", /분실|잃/.test(clause) ? "lost" : "absent", item.source_message_id);
      else if (present.test(clause) || present.test(text) && !missing.test(text))
        set(company, "bank_copy", "held", item.source_message_id);
    }
    if (/급여\s*명세서/.test(text)) {
      const clause = documentClause(text, /급여\s*명세서/, /(?:근로)?계약서|통장\s*사본/);
      if (missing.test(clause))
        set(company, "pay_slip", /분실|잃/.test(clause) ? "lost" : "absent", item.source_message_id);
      else if (present.test(clause))
        set(company, "pay_slip", "held", item.source_message_id);
    }
  }
  return companyIds.flatMap(company_id => names.map(document =>
    status.get(`${company_id}:${document}`) ?? { company_id, document, state: "unstated", source_message_id: null }));
}

/** Caller must supply server-hydrated statements; raw client recall is discarded upstream. */
export function documentStatusesForRequest(request: ChatRequest): Array<UserDocumentStatus & { company_name: string }> {
  const companies = statementCompanies(request);
  const defaultSubject = defaultStatementSubject(request);
  const statements = [...(request.conversation_recall?.document_statements ?? [])];
  let currentSubject = defaultSubject;
  let ambiguous = false;
  for (const sentence of request.message.match(/[^.!?。？\n]+[.!?。？]?/g) ?? []) {
    const scope = statementCompany(sentence, currentSubject, companies);
    if (scope.ambiguous) { ambiguous = true; continue; }
    if (mentionedCompanies(sentence, companies).length === 1) ambiguous = false;
    if (ambiguous) continue;
    currentSubject = scope.company_id;
    if (!/[?？]|알려|정리해|설명해|어떻게|만약|라면|동료|친구/.test(sentence)
      && /계약서|명세서|통장\s*사본/.test(sentence) && /있|없|받았|못\s*받|분실|잃|보관|보유|갖고/.test(sentence)) {
      statements.push({ text: sentence, company_id: currentSubject, source_message_id: "current_request",
        sequence: Number.MAX_SAFE_INTEGER, is_correction: /정정|분실|아니라/.test(sentence) });
    }
  }
  if (!statements.length) return [];
  const ids: Array<string | null> = referencedCompanyIds(request.message, companies, defaultSubject ?? undefined);
  if (!ids.length && defaultSubject === null && !companies.length) ids.push(null);
  const named = mentionedCompanies(request.message, companies);
  if (named.length > 1 && new Set(named.map(item => item.company_name)).size < named.length
    && !named.every(item => hasCompanyLocationQualifier(request.message, item))) return [];
  if (!named.length && ids.length < 2 && statementCompany(request.message, defaultSubject, companies).ambiguous) return [];
  const statuses = documentStatusFromStatements(statements, ids);
  return statuses.filter(item => !(item.document === "contract" && item.state === "unstated"
    && statuses.some(other => other.company_id === item.company_id
      && (other.document === "contract_original" || other.document === "contract_copy")
      && other.state !== "unstated"))).map(item => ({ ...item,
    company_name: companies.some(company => company.company_id === item.company_id)
      ? recallCompanyLabel(companies.find(company => company.company_id === item.company_id)!, companies) : "이 상담" }));
}

export const DOCUMENT_LABELS: Record<DocumentName, string> = {
  contract: "근로계약서", contract_original: "근로계약서 원본", contract_copy: "근로계약서 사본",
  bank_copy: "통장 사본", pay_slip: "급여명세서",
};
export const DOCUMENT_STATE_LABELS: Record<DocumentState, string> = {
  held: "보유한다고 진술", lost: "분실했다고 진술", absent: "없다고 진술", unstated: "보유·부재를 진술하지 않음",
};

export function documentStatusSummaryForRequest(request: ChatRequest): string {
  return documentStatusesForRequest(request).map(item =>
    `${item.company_name}의 ${DOCUMENT_LABELS[item.document]}: ${DOCUMENT_STATE_LABELS[item.state]}`).join("; ");
}
