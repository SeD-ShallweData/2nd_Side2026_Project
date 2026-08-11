import "server-only";

import { OpenAICompatibleChatClient } from "@/adapters/real/OpenAICompatibleChatClient";
import type { ChatRequest } from "@/domain/chat";
import { getLlmProviderConfigs, getLlmTimeoutMs, type LlmProviderConfig } from "@/server/llmConfig";

import { loadPrompt } from "@/server/promptLoader";

export interface QueryRewriteResult {
  query: string;
  changed: boolean;
}

function buildRewriteInput(request: ChatRequest): string {
  const history = request.recent_messages
    .slice(-6)
    .map((message) => `- ${message.role === "user" ? "사용자" : "어시스턴트"}: ${message.content.slice(0, 600)}`)
    .join("\n");
  return `이력:\n${history}\n\n질문: ${request.message}\n출력:`;
}

export async function rewriteFollowupQuery(
  request: ChatRequest,
  configs: LlmProviderConfig[] = getLlmProviderConfigs(),
  client = new OpenAICompatibleChatClient(fetch, Math.min(getLlmTimeoutMs(), 15_000)),
): Promise<QueryRewriteResult> {
  if (request.recent_messages.length === 0) return { query: request.message, changed: false };
  const config = configs.find((candidate) => Boolean(candidate.apiKey));
  if (!config) return { query: request.message, changed: false };

  try {
    const completion = await client.complete(
      config,
      [
        { role: "system", content: loadPrompt("rewrite/system") },
        { role: "user", content: buildRewriteInput(request) },
      ],
      { temperature: 0, maxTokens: 120 },
    );
    const rewritten = completion.answer.trim().replace(/^['"]|['"]$/g, "").split("\n")[0].trim();
    const tooLong = rewritten.length > request.message.length * 6 + 120 || rewritten.length > 2_000;
    if (!rewritten || tooLong) return { query: request.message, changed: false };
    return { query: rewritten, changed: rewritten !== request.message };
  } catch {
    return { query: request.message, changed: false };
  }
}
