import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { hydrateConversationRequest, persistCompletedChat, deleteUserConversation } from "@/services/conversationService";
import { resetMockConversationsForTests, getConversationRepository } from "@/services/userDataProviders";
import { recallAnswer, recallResponse } from "@/services/conversationRecallService";
import type { ChatRequest } from "@/domain/chat";
import { selectUserFacts } from "@/services/conversationSummaryService";

const user = { user_id: "00000000-0000-4000-8000-000000000005", email: "memory05@example.invalid", display_name: "synthetic", role: "user" as const };
const a = "COMPANY_DEMO_008", b = "COMPANY_DEMO_002";
const reply = () => recallResponse({ message: "급여일은 10일입니다.", chat_mode: "wage", recent_messages: [] }, [{ id: "upstage", label: "synthetic", model: "none" }])!;
async function store(statements: Array<[string, string]>) {
  vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
  vi.stubEnv("COMPANY_DATA_MODE", "mock");
  let id = "";
  for (const [index, [company_id, message]] of statements.entries()) {
    id = await persistCompletedChat({ message, company_id, conversation_id: id || undefined, request_id: `selection05_${String(index).padStart(12, "0")}`, chat_mode: "wage", recent_messages: [] }, reply(), user);
  }
  return id;
}
const query = (id: string, message: string, company_id?: string): ChatRequest => ({ conversation_id: id, message, company_id, chat_mode: "wage", recent_messages: [] });
afterEach(() => { resetMockConversationsForTests(); vi.unstubAllEnvs(); });

describe("bounded owner-scoped memory selection", () => {
  it("recovers retained document facts after26turns without expanding the six-item summary budget", async () => {
    const statements: Array<[string, string]> = [[a, "한빛테크의 근로계약서 종이 원본과 통장 사본을 갖고 있습니다. 급여명세서는 없습니다."]];
    for (let i = 1; i < 26; i++) statements.push([i > 12 ? b : a, `추가 상담 ${i}: 회사 문의 내역을 정리했고 새 지급 답변은 없습니다.`]);
    const id = await store(statements);
    const request = query(id, "한빛테크에서 제가 보유한다고 말한 문서와 없는 서류를 정리하고 임금체불 진정에 어떻게 활용하는지 알려주세요.", b);
    const hydrated = await hydrateConversationRequest(request, user);
    expect(hydrated.conversation_memory?.content).toContain("근로계약서 종이 원본과 통장 사본");
    expect(hydrated.conversation_memory?.content).toContain("급여명세서는 없습니다");
    const summary = (await getConversationRepository().findSummary(id))!;
    expect(summary.summary.user_stated_facts.length).toBeLessThanOrEqual(6);
    expect(summary.summary.system_confirmed_facts).toEqual([]);
    await expect(hydrateConversationRequest(request, { ...user, user_id: "00000000-0000-4000-8000-000000000006" })).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
    await deleteUserConversation(id, user);
    await expect(hydrateConversationRequest(request, user)).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
  });
  it("does not let70repeated B facts evict the latest A correction from64slots", async () => {
    const statements: Array<[string, string]> = [[a, "한빛테크의 급여일은 10일입니다."], [a, "정정합니다. 한빛테크의 급여일은 15일입니다."]];
    for (let i = 0; i < 70; i++) statements.push([b, "다온제조의 급여일은 7일입니다."]);
    const id = await store(statements);
    const hydrated = await hydrateConversationRequest(query(id, "한빛테크와 다온제조의 마지막 정정 급여일을 각각 다시 알려주세요."), user);
    expect(recallAnswer(hydrated)?.answer).toMatch(/한빛테크[^\n]*15일/);
    expect(recallAnswer(hydrated)?.answer).toMatch(/다온제조[^\n]*7일/);
    expect(hydrated.conversation_recall!.facts.length).toBeLessThanOrEqual(64);
  });
  it("keeps document corrections and same-text statements attributed to each company", async () => {
    const statements: Array<[string, string]> = [
      [a, "근로계약서 종이 원본을 갖고 있습니다."],
      [b, "근로계약서 종이 원본을 갖고 있습니다."],
      [a, "정정합니다. 한빛테크의 근로계약서 원본은 분실했고 사본만 갖고 있습니다."],
    ];
    for (let i = 3; i < 15; i++) statements.push([b, `추가 상담 ${i}: 새 회사 답변은 없고 기록을 정리했습니다.`]);
    const id = await store(statements);
    const hydrated = await hydrateConversationRequest(query(id, "한빛테크와 다온제조의 계약서 보유 상태를 구분하고 임금체불 진정 자료로 어떻게 활용하나요?"), user);
    expect(hydrated.conversation_memory?.content).toContain("원본은 분실했고 사본만");
    expect(hydrated.conversation_memory?.content).toContain("근로계약서 종이 원본을 갖고 있습니다");
    expect(hydrated.conversation_memory?.content).toContain("다온제조");
  });
  it("puts only owner user document statements in generation context, preserving an unrelated possession after correction", async () => {
    const id = await store([
      [a, "한빛테크의 근로계약서 원본과 통장 사본을 갖고 있습니다. 급여명세서는 없습니다."],
      [b, "다온제조의 계약서 사본을 갖고 있습니다."],
      [a, "정정합니다. 한빛테크의 근로계약서 원본은 분실했고 사본만 갖고 있습니다."],
      [b, "통장 사본을 갖고 있나요? 보유 상태를 알려주세요."],
    ]);
    const hydrated = await hydrateConversationRequest(query(id,
      "한빛테크와 다온제조의 문서 보유 상태를 임금체불 자료와 함께 알려주세요.", b), user);
    const statements = hydrated.conversation_recall?.document_statements ?? [];
    expect(statements.some(item => item.company_id === a && item.text.includes("통장 사본을 갖고"))).toBe(true);
    expect(statements.some(item => item.company_id === a && item.text.includes("원본은 분실했고 사본만"))).toBe(true);
    expect(statements.some(item => item.company_id === b && item.text.includes("계약서 사본을 갖고"))).toBe(true);
    expect(statements.some(item => item.text.includes("보유 상태를 알려주세요"))).toBe(false);
    expect(statements.filter(item => item.company_id === b).some(item => item.text.includes("통장"))).toBe(false);
    expect(statements.length).toBeLessThanOrEqual(8);
  });
  it("does not turn questions, unknown subjects or another room into selected-company facts", async () => {
    const id = await store([[a, "계약서를 제출했나요? 계약서 보유 상태를 알려주세요."], [b, "급여명세서는 없습니다."],
      [b, "한빛테크의 계약서 사본을 갖고 있습니다."], [b, "새로운업체에서는 계약서를 받았습니다."],
      [b, "연락처 010-1234-5678로 임금 문의했습니다."]]);
    const detail = (await getConversationRepository().findConversation(id))!;
    const selected = selectUserFacts(detail, 10, [{ company_id: a, company_name: "한빛테크" }, { company_id: b, company_name: "다온제조" }]);
    expect(selected.some(item => item.text.includes("제출했나요"))).toBe(false);
    expect(selected.find(item => item.text.includes("급여명세서"))?.company_id).toBe(b);
    expect(selected.find(item => item.text.includes("한빛테크"))?.company_id).toBe(a);
    expect(selected.find(item => item.text.includes("새로운업체"))?.company_id).toBeUndefined();
    expect(JSON.stringify(selected)).not.toContain("010-1234-5678");
    expect(selected.every(item => item.source_message_ids.length === 1)).toBe(true);
    const other = await store([[a, "급여일은 12일입니다."]]);
    expect((await hydrateConversationRequest(query(other, "문서 보유 상태는?"), user)).conversation_memory).toBeUndefined();
  });
});
