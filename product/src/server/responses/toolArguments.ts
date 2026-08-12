import type { ToolInputMap, ToolName } from "@/server/responses/toolContracts";

const SEARCH_QUERY_MAX_LENGTH = 100;
const COMPANY_ID_MAX_LENGTH = 64;
const RAG_QUERY_MAX_LENGTH = 2_000;

export interface ToolArgumentIssue {
  field: string;
  reason: string;
}

export class ToolArgumentsError extends Error {
  readonly code = "INVALID_TOOL_ARGUMENTS";

  constructor(readonly issues: ToolArgumentIssue[]) {
    super("도구 인자의 형식이나 범위를 확인해 주세요.");
    this.name = "ToolArgumentsError";
  }
}

function invalid(field: string, reason: string): never {
  throw new ToolArgumentsError([{ field, reason }]);
}

function parseObject(serializedArguments: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(serializedArguments);
  } catch {
    return invalid("$", "유효한 JSON 객체여야 합니다.");
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("$", "JSON 객체여야 합니다.");
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
): void {
  const unknownKey = Object.keys(value).find((key) => !requiredKeys.includes(key));
  if (unknownKey) {
    invalid(unknownKey, "허용되지 않은 필드입니다.");
  }

  const missingKey = requiredKeys.find(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  if (missingKey) {
    invalid(missingKey, "필수 필드입니다.");
  }
}

function normalizedString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    return invalid(field, "문자열이어야 합니다.");
  }
  const normalized = value.trim();
  if (!normalized) {
    return invalid(field, "빈 문자열일 수 없습니다.");
  }
  if (normalized.length > maxLength) {
    return invalid(field, `${maxLength}자 이하여야 합니다.`);
  }
  return normalized;
}

function parseSearchCompany(value: Record<string, unknown>): ToolInputMap["search_company"] {
  assertExactKeys(value, ["query", "limit"]);
  const limit = value.limit;
  if (
    limit !== null &&
    (!Number.isInteger(limit) || typeof limit !== "number" || limit < 1 || limit > 20)
  ) {
    invalid("limit", "null 또는 1 이상 20 이하의 정수여야 합니다.");
  }
  return {
    query: normalizedString(value.query, "query", SEARCH_QUERY_MAX_LENGTH),
    limit,
  };
}

function parseCompanyRisk(value: Record<string, unknown>): ToolInputMap["get_company_risk"] {
  assertExactKeys(value, ["company_id"]);
  return {
    company_id: normalizedString(value.company_id, "company_id", COMPANY_ID_MAX_LENGTH),
  };
}

function parseLaborLaw(value: Record<string, unknown>): ToolInputMap["retrieve_labor_law"] {
  assertExactKeys(value, ["query"]);
  return {
    query: normalizedString(value.query, "query", RAG_QUERY_MAX_LENGTH),
  };
}

function parseContractReview(value: Record<string, unknown>): ToolInputMap["review_contract"] {
  assertExactKeys(value, ["document_ref"]);
  if (value.document_ref !== "current_upload") {
    invalid("document_ref", '"current_upload"이어야 합니다.');
  }
  return { document_ref: "current_upload" };
}

export function parseToolArguments<K extends ToolName>(
  name: K,
  serializedArguments: string,
): ToolInputMap[K] {
  const value = parseObject(serializedArguments);
  switch (name) {
    case "search_company":
      return parseSearchCompany(value) as ToolInputMap[K];
    case "get_company_risk":
      return parseCompanyRisk(value) as ToolInputMap[K];
    case "retrieve_labor_law":
      return parseLaborLaw(value) as ToolInputMap[K];
    case "review_contract":
      return parseContractReview(value) as ToolInputMap[K];
  }
}
