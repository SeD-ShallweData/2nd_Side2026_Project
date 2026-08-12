import { describe, expect, it } from "vitest";
import { parseToolArguments, ToolArgumentsError } from "@/server/responses/toolArguments";
import { getToolDefinitions } from "@/server/responses/toolDefinitions";

function uploadContext() {
  const file = new File(["contract"], "contract.pdf", { type: "application/pdf" });
  return {
    contractRequest: {
      file,
      file_metadata: {
        file_name: file.name,
        content_type: file.type,
        size_bytes: file.size,
      },
    },
  };
}

describe("Responses function tool 명세", () => {
  it("strict mode가 요구하는 모든 필드와 additionalProperties 규칙을 선언한다", () => {
    const definitions = getToolDefinitions(uploadContext());

    expect(definitions.map((definition) => definition.name)).toEqual([
      "search_company",
      "get_company_risk",
      "retrieve_labor_law",
      "review_contract",
    ]);
    for (const definition of definitions) {
      expect(definition.type).toBe("function");
      expect(definition.strict).toBe(true);
      expect(definition.parameters.additionalProperties).toBe(false);
      expect(new Set(definition.parameters.required as string[])).toEqual(
        new Set(Object.keys(definition.parameters.properties as object)),
      );
    }
  });

  it("현재 업로드가 없으면 review_contract 자체를 모델에 노출하지 않는다", () => {
    expect(getToolDefinitions().map((definition) => definition.name)).not.toContain(
      "review_contract",
    );
    expect(getToolDefinitions(uploadContext()).map((definition) => definition.name)).toContain(
      "review_contract",
    );
  });
});

describe("Responses function tool 런타임 인자 계약", () => {
  it("유효한 인자를 정규화한다", () => {
    expect(
      parseToolArguments("search_company", '{"query":"  한빛 산업  ","limit":null}'),
    ).toEqual({ query: "한빛 산업", limit: null });
    expect(
      parseToolArguments("get_company_risk", '{"company_id":" firm-1 "}'),
    ).toEqual({ company_id: "firm-1" });
    expect(
      parseToolArguments("retrieve_labor_law", '{"query":" 임금 지급일은? "}'),
    ).toEqual({ query: "임금 지급일은?" });
    expect(
      parseToolArguments("review_contract", '{"document_ref":"current_upload"}'),
    ).toEqual({ document_ref: "current_upload" });
  });

  it.each([
    ["잘못된 JSON", "search_company", "{"],
    ["배열", "search_company", "[]"],
    ["필수값 누락", "search_company", '{"query":"한빛"}'],
    ["추가 필드", "search_company", '{"query":"한빛","limit":5,"admin":true}'],
    ["prototype 키", "get_company_risk", '{"company_id":"firm-1","__proto__":{}}'],
    ["빈 문자열", "retrieve_labor_law", '{"query":"   "}'],
    ["범위 밖 limit", "search_company", '{"query":"한빛","limit":21}'],
    ["소수 limit", "search_company", '{"query":"한빛","limit":1.5}'],
    ["잘못된 문서 참조", "review_contract", '{"document_ref":"/tmp/contract.pdf"}'],
  ] as const)("%s을 거부한다", (_label, name, serializedArguments) => {
    expect(() => parseToolArguments(name, serializedArguments)).toThrow(ToolArgumentsError);
  });
});
