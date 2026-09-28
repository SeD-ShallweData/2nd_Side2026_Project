import { describe, expect, it } from "vitest";
import { documentStatusFromStatements } from "@/services/conversationDocumentStatus";

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
});
