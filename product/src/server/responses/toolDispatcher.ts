import { ToolArgumentsError, parseToolArguments } from "@/server/responses/toolArguments";
import {
  isToolName,
  type AnyToolExecutionResult,
  type ToolExecutionContext,
  type ToolOutputMap,
} from "@/server/responses/toolContracts";
import {
  createToolHandlers,
  type ToolHandlerMap,
} from "@/server/responses/toolHandlers";
import { ServiceError } from "@/utils/errors";

const MAX_SERIALIZED_ARGUMENT_LENGTH = 16_384;
const MAX_SERIALIZED_RESULT_LENGTH = 128 * 1024;

export interface ToolDispatcher {
  dispatch(
    name: string,
    serializedArguments: string,
    context?: ToolExecutionContext,
  ): Promise<AnyToolExecutionResult>;
}

function success<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

function failure(
  code: string,
  message: string,
  retryable: boolean,
  details?: { field?: string; reason: string }[],
): AnyToolExecutionResult {
  return { ok: false, error: { code, message, retryable, details } };
}

async function invokeAllowedTool(
  handlers: ToolHandlerMap,
  name: keyof ToolOutputMap,
  serializedArguments: string,
  context: ToolExecutionContext,
): Promise<AnyToolExecutionResult> {
  switch (name) {
    case "search_company":
      return success(
        await handlers.search_company(
          parseToolArguments("search_company", serializedArguments),
          context,
        ),
      );
    case "get_company_risk":
      return success(
        await handlers.get_company_risk(
          parseToolArguments("get_company_risk", serializedArguments),
          context,
        ),
      );
    case "retrieve_labor_law":
      return success(
        await handlers.retrieve_labor_law(
          parseToolArguments("retrieve_labor_law", serializedArguments),
          context,
        ),
      );
    case "review_contract":
      return success(
        await handlers.review_contract(
          parseToolArguments("review_contract", serializedArguments),
          context,
        ),
      );
  }
}

export function createToolDispatcher(
  handlers: ToolHandlerMap = createToolHandlers(),
): ToolDispatcher {
  return {
    async dispatch(name, serializedArguments, context = {}) {
      if (!isToolName(name)) {
        return failure(
          "UNSUPPORTED_TOOL",
          "허용되지 않은 도구입니다.",
          false,
          [{ field: "name", reason: "등록된 도구 이름이 아닙니다." }],
        );
      }
      if (new TextEncoder().encode(serializedArguments).byteLength > MAX_SERIALIZED_ARGUMENT_LENGTH) {
        return failure(
          "INVALID_TOOL_ARGUMENTS",
          "도구 인자가 허용된 크기를 초과했습니다.",
          false,
          [{ field: "$", reason: `${MAX_SERIALIZED_ARGUMENT_LENGTH}바이트 이하여야 합니다.` }],
        );
      }

      try {
        const result = await invokeAllowedTool(handlers, name, serializedArguments, context);
        const serialized = JSON.stringify(result);
        if (
          typeof serialized !== "string" ||
          new TextEncoder().encode(serialized).byteLength > MAX_SERIALIZED_RESULT_LENGTH
        ) {
          return failure(
            "TOOL_RESULT_TOO_LARGE",
            "도구 실행 결과가 모델에 전달할 수 있는 크기를 초과했습니다.",
            false,
          );
        }
        return result;
      } catch (error) {
        if (error instanceof ToolArgumentsError) {
          return failure(error.code, error.message, false, error.issues);
        }
        if (error instanceof ServiceError) {
          return failure(
            error.code,
            error.message,
            error.retryable,
            error.details,
          );
        }
        return failure(
          "TOOL_EXECUTION_FAILED",
          "도구를 실행하는 중 오류가 발생했습니다.",
          true,
        );
      }
    },
  };
}

export function serializeToolResult(result: AnyToolExecutionResult): string {
  return JSON.stringify(result);
}
