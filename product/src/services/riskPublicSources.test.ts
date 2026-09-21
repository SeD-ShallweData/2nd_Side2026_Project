import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { publicRiskSources } from "@/services/riskService";

describe("public risk source boundary", () => {
  it("replaces internal risk batch and model identifiers with stable public card ids", () => {
    const sources = publicRiskSources({
      company_id: "firm-1", company_name: "회사", data_as_of: null, generated_at: null,
      valid_until: null, freshness: "unknown",
      wage_risk: {} as never, safety_context: {} as never,
      sources: [
        { name: "임금", category: "wage", document_id: "batch:394" },
        { name: "안전", category: "safety", document_id: "model:internal-v7" },
        { name: "법령", category: "labor_law", document_id: "law-36" },
      ],
    });
    expect(sources.map((source) => source.document_id)).toEqual([
      "moneyworry-wage-card-v1", "moneyworry-safety-card-v1", "law-36",
    ]);
  });
});
