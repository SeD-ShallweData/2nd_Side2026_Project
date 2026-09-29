import { describe, expect, it } from "vitest";
import { documentStatusFromStatements, documentStatusesForRequest } from "@/services/conversationDocumentStatus";

describe("owner statement document status", () => {
  it("does not misread a bank copy as a contract copy", () => {
    const rows = documentStatusFromStatements([
      { text: "근로계약서 종이 원본과 통장 사본을 갖고 있습니다.", company_id: "A",
        source_message_id: "one", sequence: 1, is_correction: false },
    ], ["A"]);
    expect(rows.find(row => row.document === "contract_original")?.state).toBe("held");
    expect(rows.find(row => row.document === "contract_copy")?.state).toBe("unstated");
    expect(rows.find(row => row.document === "bank_copy")?.state).toBe("held");
  });
  it("applies only the named document correction and keeps silence as unstated", () => {
    const A = "COMPANY_DEMO_008", B = "COMPANY_DEMO_002";
    const rows = documentStatusFromStatements([
      { text: "근로계약서 종이 원본과 통장 사본을 갖고 있습니다.", company_id: A, source_message_id: "a1", sequence: 1, is_correction: false },
      { text: "급여명세서는 없습니다.", company_id: A, source_message_id: "a2", sequence: 1, is_correction: false },
      { text: "계약서 사본과 급여명세서를 갖고 있습니다.", company_id: B, source_message_id: "b1", sequence: 3, is_correction: false },
      { text: "근로계약서 원본은 분실했고 사본만 갖고 있습니다.", company_id: A, source_message_id: "a3", sequence: 17, is_correction: true },
    ], [A, B]);
    const state = (company_id: string, document: string) => rows.find(row => row.company_id === company_id && row.document === document)?.state;
    expect(state(A, "contract_original")).toBe("lost");
    expect(state(A, "contract_copy")).toBe("held");
    expect(state(A, "bank_copy")).toBe("held");
    expect(state(A, "pay_slip")).toBe("absent");
    expect(state(B, "contract_original")).toBe("unstated");
    expect(state(B, "contract_copy")).toBe("held");
    expect(state(B, "bank_copy")).toBe("unstated");
    expect(state(B, "pay_slip")).toBe("held");
  });
  it("keeps an unspecified contract distinct from its original and copy", () => {
    const rows = documentStatusFromStatements([
      { text: "근로계약서를 갖고 있습니다.", company_id: "A", source_message_id: "a", sequence: 1, is_correction: false },
      { text: "급여명세서는 분실했습니다.", company_id: "A", source_message_id: "b", sequence: 2, is_correction: false },
    ], ["A", "B"]);
    const state = (company_id: string, document: string) => rows.find(row => row.company_id === company_id && row.document === document)?.state;
    expect(state("A", "contract")).toBe("held");
    expect(state("A", "contract_original")).toBe("unstated");
    expect(state("A", "contract_copy")).toBe("unstated");
    expect(state("A", "pay_slip")).toBe("lost");
    expect(state("B", "contract")).toBe("unstated");
  });
  it("requires location for same-name document attribution after a company switch", () => {
    const companies = [
      { company_id: "A", company_name: "OO건설", region: "인천광역시", address: "인천광역시 서구 샘플로 10" },
      { company_id: "B", company_name: "OO건설", region: "경기도", address: "경기도 김포시 예시로 21" },
    ];
    const recall = { facts: [], companies, company_history: [], diagnostics: {
      summary_status: "absent" as const, summary_version: null, summarized_through_sequence: 0,
      stored_message_count: 2, hydrated_recent_count: 2, summary_included: false,
      recall_fact_count: 0, legacy_recall_rebuilt: false,
    }, document_statements: [
      { text: "통장 사본을 갖고 있습니다.", company_id: "A", source_message_id: "a", sequence: 1, is_correction: false },
    ] };
    const base = { company_id: "B", chat_mode: "wage" as const, recent_messages: [], conversation_recall: recall };
    expect(documentStatusesForRequest({ ...base, message: "OO건설의 통장 사본 상태는?" })).toEqual([]);
    const incheon = documentStatusesForRequest({ ...base, message: "인천 OO건설의 통장 사본 상태는?" });
    expect(incheon.find(row => row.document === "bank_copy")).toMatchObject({ company_id: "A", state: "held" });
  });
});
