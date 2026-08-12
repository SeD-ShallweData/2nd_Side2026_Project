/**
 * 대량 코퍼스로 정책 분기의 표현 커버리지를 검사한다.
 *
 * 케이스마다 테스트를 만들지 않고 한 번에 돌려 어긋난 것만 모아 보고한다.
 * 수백 건이 개별 항목으로 나열되면 무엇이 문제인지 되레 안 보이기 때문이다.
 *
 * LLM·DB·RAG 를 호출하지 않는다. 몇 번을 돌려도 팀 작업에 영향이 없다.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { AnswerType, GuardrailStatus } from "@/domain/chat";
import { parseChatRequest, sendChatMessage } from "@/services/chatService";
import type { PolicyBranch } from "@/services/policyRouting.cases";
import {
  CORPUS_KNOWN_MISMATCH,
  POLICY_ROUTING_CORPUS,
  type CorpusEntry,
  type Persona,
} from "@/services/policyRouting.corpus";

/** 분기가 내놓아야 하는 결과. 분기마다 답변 문구는 달라도 형태는 같다. */
const EXPECTED: Record<string, { answer_type: AnswerType; guardrail: GuardrailStatus }> = {
  emergency: { answer_type: "emergency_guidance", guardrail: "escalated" },
  no_company_context_keyword: { answer_type: "clarification", guardrail: "limited" },
  no_company_out_of_scope: { answer_type: "insufficient_evidence", guardrail: "limited" },
  no_company_fallback: { answer_type: "clarification", guardrail: "passed" },
};

const TOPIC_RESULT = { answer_type: "general_guidance" as const, guardrail: "passed" as const };

function expectedFor(branch: PolicyBranch) {
  return EXPECTED[branch] ?? TOPIC_RESULT;
}

interface Mismatch {
  entry: CorpusEntry;
  actual: string;
  expected: string;
}

beforeEach(() => {
  process.env.APP_DATA_MODE = "mock";
  process.env.MOCK_DELAY_MS = "0";
});

describe("정책 분기 표현 커버리지", () => {
  it(`코퍼스 ${POLICY_ROUTING_CORPUS.length}건이 의도한 주제로 분류된다`, async () => {
    const mismatches: Mismatch[] = [];
    const byPersona = new Map<Persona, { total: number; miss: number }>();

    for (const entry of POLICY_ROUTING_CORPUS) {
      const response = await sendChatMessage(
        parseChatRequest({ message: entry.question, chat_mode: "general", recent_messages: [] }),
      );
      const want = expectedFor(entry.branch);
      const actual = `${response.answer_type}/${response.guardrail_status}`;
      const expected = `${want.answer_type}/${want.guardrail}`;

      const stat = byPersona.get(entry.persona) ?? { total: 0, miss: 0 };
      stat.total += 1;
      if (actual !== expected) {
        stat.miss += 1;
        if (!(entry.question in CORPUS_KNOWN_MISMATCH)) {
          mismatches.push({ entry, actual, expected });
        }
      }
      byPersona.set(entry.persona, stat);
    }

    console.log("\n화자별 분류 결과:");
    for (const [persona, stat] of byPersona) {
      const rate = ((stat.total - stat.miss) / stat.total) * 100;
      console.log(`  ${persona.padEnd(8)} ${stat.total - stat.miss}/${stat.total} (${rate.toFixed(0)}%)`);
    }

    if (mismatches.length > 0) {
      console.log(`\n의도와 어긋난 ${mismatches.length}건:`);
      for (const { entry, actual, expected } of mismatches) {
        console.log(`  [${entry.branch}] ${entry.question}`);
        console.log(`      기대 ${expected} / 실제 ${actual}`);
      }
    }

    expect(
      mismatches.map((m) => `${m.entry.question} → ${m.actual} (기대 ${m.expected})`),
      "의도한 주제로 분류되지 않은 질문",
    ).toEqual([]);
  }, 120_000);

  it("코퍼스 id가 중복되지 않는다", () => {
    const ids = POLICY_ROUTING_CORPUS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("모든 화자가 코퍼스에 등장한다", () => {
    const personas = new Set(POLICY_ROUTING_CORPUS.map((entry) => entry.persona));
    expect(personas.size).toBeGreaterThanOrEqual(5);
  });
});
