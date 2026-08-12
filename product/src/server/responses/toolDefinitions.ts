import {
  hasCurrentContractUpload,
  type ToolExecutionContext,
  type ToolName,
} from "@/server/responses/toolContracts";

export interface ResponsesFunctionToolDefinition {
  type: "function";
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
  strict: true;
}

const TOOL_DEFINITIONS: readonly ResponsesFunctionToolDefinition[] = [
  {
    type: "function",
    name: "search_company",
    description:
      "사업장명 일부 또는 전체를 검색해 후보와 company_id를 찾는다. 사용자가 회사명을 말했지만 정확한 company_id를 모를 때 먼저 사용한다.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "검색할 사업장명. 사용자가 입력한 이름에서 불필요한 설명은 제외한다.",
        },
        limit: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 20,
          description: "반환할 최대 후보 수. 기본값을 사용하려면 null.",
        },
      },
      required: ["query", "limit"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "get_company_risk",
    description:
      "사용자가 화면이나 API에서 명시적으로 선택한 company_id의 최신 공개 위험 정보와 근거를 조회한다. 검색 후보를 자동 선택하지 않으며 선택된 company_id와 정확히 같아야 한다.",
    parameters: {
      type: "object",
      properties: {
        company_id: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description: "search_company 결과의 정확한 company_id.",
        },
      },
      required: ["company_id"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "retrieve_labor_law",
    description:
      "근로기준법·노동관계 법령 질문에 답할 검증 가능한 문서 근거를 검색한다. 검색 결과에 없는 법령명·조문·판례를 만들지 않는다.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
          description: "법률 근거가 필요한 독립적인 자연어 질문.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "review_contract",
    description:
      "현재 HTTP 요청에 업로드된 계약서를 검토한다. 이 도구가 노출된 경우에만 호출하며 파일 경로나 원문을 인자로 만들지 않는다.",
    parameters: {
      type: "object",
      properties: {
        document_ref: {
          type: "string",
          enum: ["current_upload"],
          description: "현재 요청의 업로드를 가리키는 고정 참조값.",
        },
      },
      required: ["document_ref"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export function getToolDefinitions(
  context: ToolExecutionContext = {},
): ResponsesFunctionToolDefinition[] {
  return TOOL_DEFINITIONS.filter(
    (definition) =>
      definition.name !== "review_contract" || hasCurrentContractUpload(context),
  );
}
