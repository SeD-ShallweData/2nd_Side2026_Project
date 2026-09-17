import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { classifyChatIntent } from "@/services/chatIntentService";
import { getLlmProviderConfigs } from "@/server/llmConfig";
import type { RecentMessage } from "@/domain/chat";
import corpus from "../../eval/chat-intent-cases.json";

type EvalCase = {
  id: string;
  question: string;
  expected: string[];
  expected_when_selected?: string[];
  expected_when_unselected?: string[];
  selected_states?: boolean[];
  expected_topic?: string;
  resolved_query?: string;
  recent_messages?: RecentMessage[];
};
const requestedIds = new Set(
  (process.env.CHAT_INTENT_EVAL_CASE_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const selectedCorpus = requestedIds.size > 0
  ? (corpus as EvalCase[]).filter((item) => requestedIds.has(item.id))
  : corpus as EvalCase[];
// Opt-in only: consumes real provider quota and sends only the synthetic corpus.
describe.skipIf(process.env.RUN_CHAT_INTENT_LIVE !== "1")("실제 모델 의도 분류 평가", () => {
  for (const selected of [false, true]) {
    it.each(selectedCorpus.filter((item) => item.selected_states?.includes(selected) ?? true))(`$id / company_selected=${selected}`, async (item) => {
      const provider = process.env.CHAT_INTENT_EVAL_PROVIDER || "upstage";
      expect(["upstage", "skt"], "Unknown evaluation provider").toContain(provider);
      const configs = getLlmProviderConfigs().filter((config) => config.id === provider);
      expect(configs.some((config) => Boolean(config.apiKey)), `${provider} credential required`).toBe(true);
      const result = await classifyChatIntent({
        message: item.question, company_id: selected ? "SYNTHETIC_EVAL" : undefined,
        chat_mode: "general", resolved_query: item.resolved_query, recent_messages: item.recent_messages ?? [],
      }, configs);
      expect(result.status, item.id).toBe("classified");
      const expected = selected
        ? item.expected_when_selected ?? item.expected
        : item.expected_when_unselected ?? item.expected;
      expect(expected, `${item.id}: got ${result.intent}`).toContain(result.intent);
      if (item.expected_topic) expect(result.topic, item.id).toBe(item.expected_topic);
    }, 12_000);
  }
});
