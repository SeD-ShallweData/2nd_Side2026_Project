/**
 * 정책 분기 하네스.
 *
 * `policyRouting.cases.ts`의 골든셋을 실제 요청 경로(parseChatRequest →
 * sendChatMessage → PolicyChatProvider)에 태워 채점합니다.
 *
 * LLM·DB·RAG를 호출하지 않으므로 결과가 흔들리지 않고, 공용 API 키도 쓰지
 * 않습니다. 프롬프트나 분기 키워드를 고칠 때마다 `npm test`로 돌리면 됩니다.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { ChatResponse } from "@/domain/chat";
import { parseChatRequest, sendChatMessage } from "@/services/chatService";
import {
  FORBIDDEN_IN_ANY_ANSWER,
  FORBIDDEN_INTERNAL_FIELDS,
  KNOWN_ROUTING_GAPS,
  POLICY_BRANCHES,
  POLICY_ERROR_CASES,
  POLICY_ROUTING_CASES,
  type PolicyRoutingCase,
} from "@/services/policyRouting.cases";

beforeEach(() => {
  process.env.APP_DATA_MODE = "mock";
  process.env.MOCK_DELAY_MS = "0";
});

async function run(testCase: PolicyRoutingCase): Promise<ChatResponse> {
  return sendChatMessage(
    parseChatRequest({
      message: testCase.question,
      chat_mode: testCase.chat_mode ?? "general",
      company_id: testCase.company_id,
      recent_messages: testCase.recent_messages ?? [],
    }),
  );
}

function assertCase(testCase: PolicyRoutingCase, response: ChatResponse): void {
  expect(response.answer_type, `${testCase.id}: answer_type`).toBe(testCase.expect_answer_type);
  expect(response.guardrail_status, `${testCase.id}: guardrail_status`).toBe(testCase.expect_guardrail);

  if (testCase.expect_sources === "none") {
    expect(response.sources, `${testCase.id}: 근거가 없으면 출처를 만들지 않는다`).toEqual([]);
  } else {
    expect(response.sources.length, `${testCase.id}: 출처가 있어야 한다`).toBeGreaterThan(0);
  }

  for (const code of testCase.expect_actions ?? []) {
    expect(
      response.suggested_actions.map((action) => action.code),
      `${testCase.id}: 다음 행동 ${code}`,
    ).toContain(code);
  }
  for (const phrase of testCase.expect_contains ?? []) {
    expect(response.answer, `${testCase.id}: "${phrase}" 포함`).toContain(phrase);
  }
  for (const phrase of testCase.forbid_contains ?? []) {
    expect(response.answer, `${testCase.id}: "${phrase}" 미포함`).not.toContain(phrase);
  }

  // 모든 분기가 공통으로 지켜야 하는 것.
  expect(response.limitations.length, `${testCase.id}: 한계를 비워두지 않는다`).toBeGreaterThan(0);
  expect(response.conversation_id, `${testCase.id}: conversation_id`).toBeTruthy();
}

describe("정책 분기 골든셋", () => {
  it.each(POLICY_ROUTING_CASES.map((testCase) => [testCase.id, testCase] as const))(
    "%s",
    async (_id, testCase) => {
      assertCase(testCase, await run(testCase));
    },
  );
});

describe("정책 분기 커버리지", () => {
  it("모든 분기에 케이스가 하나 이상 있다", () => {
    const covered = new Set(POLICY_ROUTING_CASES.map((testCase) => testCase.branch));
    const missing = POLICY_BRANCHES.filter((branch) => !covered.has(branch));
    expect(missing, `케이스가 없는 분기: ${missing.join(", ")}`).toEqual([]);
  });

  it("케이스 id가 중복되지 않는다", () => {
    const all = [...POLICY_ROUTING_CASES, ...KNOWN_ROUTING_GAPS].map((testCase) => testCase.id);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("전 분기 공통 금지 표현", () => {
  it("어떤 분기의 정책 답변에도 단정 표현이 없다", async () => {
    const answers = await Promise.all(
      [...POLICY_ROUTING_CASES, ...KNOWN_ROUTING_GAPS].map(async (testCase) => ({
        id: testCase.id,
        answer: (await run(testCase)).answer,
      })),
    );

    for (const { id, answer } of answers) {
      for (const phrase of FORBIDDEN_IN_ANY_ANSWER) {
        expect(answer, `${id}에 단정 표현 "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  it("정책 응답 전체에 내부 모델 필드가 실리지 않는다", async () => {
    const responses = await Promise.all(
      [...POLICY_ROUTING_CASES, ...KNOWN_ROUTING_GAPS].map((testCase) => run(testCase)),
    );
    const serialized = JSON.stringify(responses);

    for (const field of FORBIDDEN_INTERNAL_FIELDS) {
      expect(serialized, `내부 필드 "${field}" 노출`).not.toContain(field);
    }
  });

  it("임금·산업재해 중 하나라도 자료가 없으면 guardrail을 limited로 낮춘다", async () => {
    for (const companyId of ["UNKNOWN_001", "UNKNOWN_WAGE_001", "UNKNOWN_SAFETY_001"]) {
      const response = await sendChatMessage(
        parseChatRequest({
          message: "이 결과를 좀 더 풀어서 설명해 주세요",
          chat_mode: "general",
          company_id: companyId,
          recent_messages: [],
        }),
      );
      expect(response.guardrail_status, `${companyId}: guardrail_status`).toBe("limited");
    }
  });

  it("두 신호가 모두 자료 부족인 사업장에는 출처를 만들지 않는다", async () => {
    const response = await sendChatMessage(
      parseChatRequest({
        message: "이 결과를 좀 더 풀어서 설명해 주세요",
        chat_mode: "general",
        company_id: "UNKNOWN_001",
        recent_messages: [],
      }),
    );
    expect(response.sources).toEqual([]);
  });
});

describe("정책 오류 응답", () => {
  it.each(POLICY_ERROR_CASES.map((testCase) => [testCase.id, testCase] as const))(
    "%s",
    async (_id, testCase) => {
      await expect(
        sendChatMessage(
          parseChatRequest({
            message: testCase.question,
            chat_mode: "general",
            company_id: testCase.company_id,
            recent_messages: [],
          }),
        ),
      ).rejects.toMatchObject({ code: testCase.expect_code, status: testCase.expect_status });
    },
  );
});

describe("개선 후보로 표시한 현재 동작", () => {
  // 정답이 아니라 현재 동작 기록이다. 분기 순서를 바꾸면 여기가 먼저 깨진다.
  it.each(KNOWN_ROUTING_GAPS.map((testCase) => [testCase.id, testCase] as const))(
    "%s",
    async (_id, testCase) => {
      assertCase(testCase, await run(testCase));
    },
  );
});
