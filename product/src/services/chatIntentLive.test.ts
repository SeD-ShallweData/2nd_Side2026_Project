import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { classifyChatIntent } from "@/services/chatIntentService";
import { getLlmProviderConfigs } from "@/server/llmConfig";
import type { RecentMessage } from "@/domain/chat";
import corpus from "../../eval/chat-intent-cases.json";

type EvalCase = { id: string; question: string; expected: string[]; recent_messages?: RecentMessage[] };
// Opt-in only: consumes real provider quota and sends only the synthetic corpus.
describe.skipIf(process.env.RUN_CHAT_INTENT_LIVE !== "1")("실제 모델 의도 분류 평가", () => {
  for (const selected of [false, true]) {
    it.each(corpus as EvalCase[])(`$id / company_selected=${selected}`, async (item) => {
      const configs = getLlmProviderConfigs().filter((config) => config.id === "upstage");
      expect(configs.some((config) => Boolean(config.apiKey)), "Upstage credential required").toBe(true);
      const result = await classifyChatIntent({
        message: item.question, company_id: selected ? "SYNTHETIC_EVAL" : undefined,
        chat_mode: "general", recent_messages: item.recent_messages ?? [],
      }, configs);
      expect(result.status, item.id).toBe("classified");
      expect(item.expected, `${item.id}: got ${result.intent}`).toContain(result.intent);
    }, 12_000);
  }
});
