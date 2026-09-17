import "server-only";

import { OpenAICompatibleChatClient } from "@/adapters/real/OpenAICompatibleChatClient";
import type { ChatRequest } from "@/domain/chat";
import { getLlmProviderConfigs, getLlmTimeoutMs, type LlmProviderConfig } from "@/server/llmConfig";

import { loadPrompt } from "@/server/promptLoader";

export interface QueryRewriteResult {
  query: string;
  changed: boolean;
}

const ELLIPTICAL_FOLLOWUP_MARKERS = [
  "그럼", "그러면", "그다음", "그 다음", "어디에", "어떻게", "문의", "신고", "그것", "이거",
];

function contextualFallbackQuery(request: ChatRequest): QueryRewriteResult {
  const lastUserMessage = [...request.recent_messages]
    .reverse()
    .find((message) => message.role === "user")?.content.trim();
  const isElliptical = request.message.length <= 80
    && ELLIPTICAL_FOLLOWUP_MARKERS.some((marker) => request.message.includes(marker));
  if (!lastUserMessage || !isElliptical) return { query: request.message, changed: false };

  // assistant의 과거 안내는 사용자 사실이 아니므로 검색 질의에 섞지 않는다.
  const query = `${lastUserMessage.slice(0, 600)} ${request.message}`.trim();
  return { query, changed: query !== request.message };
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
  const fallback = contextualFallbackQuery(request);
  const config = configs.find((candidate) => Boolean(candidate.apiKey));
  if (!config) return fallback;

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
    if (!rewritten || tooLong || rewritten === request.message) return fallback;
    return { query: rewritten, changed: true };
  } catch {
    return fallback;
  }
}
