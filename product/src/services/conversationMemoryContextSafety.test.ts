import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { OpenAICompatibleChatClient } from "@/adapters/real/OpenAICompatibleChatClient";
import type { ChatRequest } from "@/domain/chat";
import type { LlmProviderConfig } from "@/server/llmConfig";
import { classifyChatIntent } from "@/services/chatIntentService";
import { rewriteFollowupQuery } from "@/services/queryRewriteService";

const CONFIG: LlmProviderConfig = {
  id: "upstage",
  label: "Upstage",
  apiKey: "test-key",
  apiUrl: "https://up.test/chat",
  model: "test",
};

const REQUEST: ChatRequest = {
  message: "What should I do next?",
  chat_mode: "wage",
  recent_messages: [{ role: "user", content: "My wage was delayed." }],
  conversation_memory: {
    summary_version: "extractive-v1",
    summarized_through_sequence: 10,
    content: "User stated that a wage was delayed.",
  },
};

function client(answer: string, transport: ReturnType<typeof vi.fn>) {
  transport.mockResolvedValue(new Response(JSON.stringify({
    model: "test",
    choices: [{ message: { content: answer }, finish_reason: "stop" }],
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  return new OpenAICompatibleChatClient(transport as unknown as typeof fetch, 1_000);
}

describe("conversation memory safety context", () => {
  it("labels summary text as reference-only when rewriting a follow-up", async () => {
    const transport = vi.fn();
    await rewriteFollowupQuery(REQUEST, [CONFIG], client("rewritten question", transport));
    const body = JSON.parse(transport.mock.calls[0][1].body);
    expect(body.messages[1].content).toContain(REQUEST.conversation_memory?.content);
    expect(body.messages[1].content).toContain("reference only");
  });

  it("labels summary text as reference-only for intent classification", async () => {
    const transport = vi.fn();
    await classifyChatIntent(
      REQUEST,
      [CONFIG],
      client('{"intent":"labor","topic":"other","company_scope":"not_applicable"}', transport),
    );
    const body = JSON.parse(transport.mock.calls[0][1].body);
    const context = JSON.parse(body.messages[1].content).conversation_memory;
    expect(context).toMatchObject({
      summarized_through_sequence: 10,
      content: REQUEST.conversation_memory?.content,
    });
    expect(context.rule).toContain("reference only");
  });
});
