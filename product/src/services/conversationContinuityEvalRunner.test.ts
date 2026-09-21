import { describe, expect, it, vi } from "vitest";

import {
  requireLocalEvaluationUrl,
  runContinuityEvaluationCase,
  type ContinuityEvaluationCase,
} from "@/services/conversationContinuityEvalRunner";

const ITEM: ContinuityEvaluationCase = {
  id: "AQ-CONT-test",
  split: "development",
  evidence: "synthetic_from_confirmed_manual_failure",
  steps: [
    { message: "급여일은 10일", chat_mode: "wage", human_review: [] },
    {
      message: "정정한 급여일은 15일",
      chat_mode: "wage",
      contract: { required_all: ["15일"] },
      human_review: [],
    },
  ],
};

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000099";
const SECRET = "super-secret-session-token";

function loginResponse() {
  return Response.json(
    { authenticated: true },
    { headers: { "set-cookie": `donworry_session=${SECRET}; Path=/; HttpOnly; SameSite=Lax` } },
  );
}

function chatResponse(answer: string) {
  return Response.json({
    conversation_id: CONVERSATION_ID,
    conversation_persistence: "saved",
    results: [{
      answer,
      answer_type: "general_guidance",
      guardrail_status: "passed",
      sources: [],
      suggested_actions: [],
    }],
  });
}

function detailResponse(turns: Array<{ question: string; answer: string }>) {
  return Response.json({
    source: "database",
    conversation_id: CONVERSATION_ID,
    turns: turns.map((turn) => ({
      messages: [
        { role: "user", content: turn.question },
        { role: "assistant", content: turn.answer },
      ],
    })),
  });
}

describe("authenticated conversation continuity evaluator", () => {
  it("rejects non-local targets before credentials are sent", () => {
    expect(() => requireLocalEvaluationUrl("https://example.com"))
      .toThrowError(expect.objectContaining({ code: "LOCAL_ENVIRONMENT_REQUIRED" }));
  });

  it("chains the server conversation id, restores each turn, and never returns the session secret", async () => {
    const restored: Array<{ question: string; answer: string }> = [];
    const chatBodies: Array<Record<string, unknown>> = [];
    let loginCount = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/auth/login")) {
        loginCount += 1;
        return loginResponse();
      }
      if (url.endsWith("/api/chat")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        chatBodies.push(body);
        const answer = body.message === "정정한 급여일은 15일" ? "정정된 급여일은 15일입니다." : "확인했습니다.";
        restored.push({ question: String(body.message), answer });
        return chatResponse(answer);
      }
      if (url.includes("/api/conversations/")) return detailResponse(restored);
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await runContinuityEvaluationCase({
      fetchImpl,
      baseUrl: "http://127.0.0.1:3000",
      email: "local@example.test",
      password: "local-test-password",
      item: ITEM,
    });

    expect(loginCount).toBe(2);
    expect(chatBodies[0]).not.toHaveProperty("conversation_id");
    expect(chatBodies[1]).toMatchObject({ conversation_id: CONVERSATION_ID });
    expect(result).toMatchObject({
      storage_source: "database",
      relogin_restore_verified: true,
      conversation_id: CONVERSATION_ID,
      rows: [
        { restored_turn_count: 1 },
        { restored_turn_count: 2, contract_status: "PASS" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
