import type { ConversationDocumentStatement } from "@/domain/conversationRecall";

export type DocumentName = "contract_original" | "contract_copy" | "bank_copy" | "pay_slip";
export type DocumentState = "held" | "lost" | "absent" | "unstated";
export interface UserDocumentStatus {
  company_id: string;
  document: DocumentName;
  state: DocumentState;
  source_message_id: string | null;
}

const names: DocumentName[] = ["contract_original", "contract_copy", "bank_copy", "pay_slip"];
const missing = /없|분실|잃|못\s*받|보유하지\s*않|갖고\s*있지\s*않/;
const present = /갖고|보유|소지|받았|있습니다|있어요/;

/** Only unambiguous document statements update status. Silence stays unstated. */
export function documentStatusFromStatements(
  statements: ConversationDocumentStatement[], companyIds: string[],
): UserDocumentStatus[] {
  const status = new Map<string, UserDocumentStatus>();
  const set = (company_id: string, document: DocumentName, state: DocumentState, source_message_id: string) => {
    status.set(`${company_id}:${document}`, { company_id, document, state, source_message_id });
  };
  for (const item of statements) {
    const company = item.company_id;
    if (!company || !companyIds.includes(company)) continue;
    const text = item.text;
    const contract = /(?:근로)?계약서|계약\s*문서/.test(text);
    // "계약서 원본과 통장 사본" mentions a bank copy, not a contract copy.
    const withoutBankCopy = text.replace(/통장\s*사본/g, "");
    if (contract && /원본/.test(text)) {
      if (/원본.{0,18}(?:분실|잃|없|보유하지\s*않|갖고\s*있지\s*않)/.test(text))
        set(company, "contract_original", /분실|잃/.test(text) ? "lost" : "absent", item.source_message_id);
      else if (present.test(text) && !missing.test(text))
        set(company, "contract_original", "held", item.source_message_id);
    }
    if (contract && /사본/.test(withoutBankCopy)) {
      if (/사본.{0,18}(?:분실|잃|없|보유하지\s*않|갖고\s*있지\s*않)/.test(withoutBankCopy))
        set(company, "contract_copy", /분실|잃/.test(withoutBankCopy) ? "lost" : "absent", item.source_message_id);
      else if (/사본.{0,24}(?:갖고|보유|소지|받았|있습니다|있어요)/.test(withoutBankCopy))
        set(company, "contract_copy", "held", item.source_message_id);
    }
    if (/통장\s*사본/.test(text)) {
      if (/통장\s*사본.{0,16}(?:분실|잃|없|보유하지\s*않|갖고\s*있지\s*않)/.test(text))
        set(company, "bank_copy", /분실|잃/.test(text) ? "lost" : "absent", item.source_message_id);
      else if (/통장\s*사본.{0,24}(?:갖고|보유|소지|받았|있습니다|있어요)/.test(text))
        set(company, "bank_copy", "held", item.source_message_id);
    }
    if (/급여\s*명세서/.test(text)) {
      if (/급여\s*명세서.{0,16}(?:분실|잃|없|보유하지\s*않|갖고\s*있지\s*않)/.test(text))
        set(company, "pay_slip", /분실|잃/.test(text) ? "lost" : "absent", item.source_message_id);
      else if (/급여\s*명세서.{0,24}(?:갖고|보유|소지|받았|있습니다|있어요)/.test(text))
        set(company, "pay_slip", "held", item.source_message_id);
    }
  }
  return companyIds.flatMap(company_id => names.map(document =>
    status.get(`${company_id}:${document}`) ?? { company_id, document, state: "unstated", source_message_id: null }));
}
