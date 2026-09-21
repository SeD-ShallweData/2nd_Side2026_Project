import { describe, expect, it, vi } from "vitest";

import {
  answerQualityExitCode,
  evaluateAnswerQualityCase,
  type AnswerQualityEvaluationCase,
} from "@/services/answerQualityEvalRunner";

const CASE: AnswerQualityEvaluationCase = {
  id: "AQ-transport-test",
  split: "development",
  request: { message: "질문", chat_mode: "general", recent_messages: [] },
  contract: { required_all: ["정상"] },
  human_review: [],
};

function successResponse(answer = "정상 답변") {
  return {
    results: [{
      answer,
      answer_type: "general_guidance",
      guardrail_status: "passed",
      sources: [],
      suggested_actions: [],
      trace: {},
    }],
  };
}

describe("answer-quality evaluation transport boundary", () => {
  it("uses the trusted-script browser-context header and evaluates a normal response", async () => {
    const fetchImpl = vi.fn(async () => Response.json(successResponse()));
    const row = await evaluateAnswerQualityCase({
      fetchImpl,
      baseUrl: "http://127.0.0.1:3000",
      item: CASE,
      attempt: 1,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/chat",
      expect.objectContaining({ headers: expect.objectContaining({ "sec-fetch-site": "same-origin" }) }),
    );
    expect(row).toMatchObject({ request_status: "ok", contract_status: "PASS", guardrail_status: "passed" });
    expect(answerQualityExitCode([row])).toBe(0);
  });

  it("parses the nested API error envelope from a 403 without treating it as answer quality", async () => {
    const row = await evaluateAnswerQualityCase({
      fetchImpl: async () => Response.json(
        { error: { code: "FORBIDDEN", message: "화면 문맥 필요" } },
        { status: 403 },
      ),
      baseUrl: "http://127.0.0.1:3000",
      item: CASE,
      attempt: 1,
    });

    expect(row).toMatchObject({
      request_status: "http_error",
      contract_status: "NOT_EVALUATED",
      http_status: 403,
      error: { code: "FORBIDDEN", message: "화면 문맥 필요" },
    });
    expect(row.guardrail_status).toBeUndefined();
    expect(answerQualityExitCode([row])).toBe(2);
  });

  it("separates a missing provider result from a contract failure", async () => {
    const row = await evaluateAnswerQualityCase({
      fetchImpl: async () => Response.json({ results: [] }),
      baseUrl: "http://127.0.0.1:3000",
      item: CASE,
      attempt: 1,
    });

    expect(row).toMatchObject({
      request_status: "missing_result",
      contract_status: "NOT_EVALUATED",
      error: { code: "MISSING_PROVIDER_RESULT" },
    });
  });

  it.each([
    [200, "parse_error", "INVALID_JSON_RESPONSE"],
    [502, "http_error", "NON_JSON_HTTP_ERROR"],
  ] as const)("classifies non-JSON HTTP %i as %s", async (status, requestStatus, code) => {
    const row = await evaluateAnswerQualityCase({
      fetchImpl: async () => new Response("<html>not json</html>", { status }),
      baseUrl: "http://127.0.0.1:3000",
      item: CASE,
      attempt: 1,
    });

    expect(row).toMatchObject({
      request_status: requestStatus,
      contract_status: "NOT_EVALUATED",
      error: { code },
    });
  });

  it("uses exit code 1 only when requests succeeded but an answer contract failed", async () => {
    const row = await evaluateAnswerQualityCase({
      fetchImpl: async () => Response.json(successResponse("계약과 다른 답변")),
      baseUrl: "http://127.0.0.1:3000",
      item: CASE,
      attempt: 1,
    });

    expect(row).toMatchObject({ request_status: "ok", contract_status: "FAIL" });
    expect(answerQualityExitCode([row])).toBe(1);
  });
});
