import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ChatComparisonResponse } from "@/domain/chatComparison";
import {
  deleteUserConversation,
  getUserConversation,
  hydrateConversationRequest,
  importGuestConversation,
  listUserConversations,
  persistCompletedChat,
  updateUserConversation,
  claimConversationRequest,
  completeClaimedConversationRequest,
} from "@/services/conversationService";
import { summaryTargetForMessageCount } from "@/services/conversationSummaryService";
import { recallAnswer } from "@/services/conversationRecallService";
import {
  getConversationRepository,
  resetMockConversationsForTests,
} from "@/services/userDataProviders";

const USER = { user_id: "00000000-0000-4000-8000-000000000001", email: "user@example.com", display_name: "사용자", role: "user" as const };
const OTHER = { ...USER, user_id: "00000000-0000-4000-8000-000000000002", email: "other@example.com" };
const REQUEST_ID = "request_0000000000000001";

function response(answer = "최종 표시 답변입니다."): ChatComparisonResponse {
  return {
    comparison_id: "comparison_1", conversation_id: "provider_conversation", execution_mode: "single_api",
    started_at: "2026-09-18T00:00:00.000Z", completed_at: "2026-09-18T00:00:01.000Z",
    fair_comparison: { concurrent: false, same_context: true, same_temperature: true, same_max_tokens: true, same_retrieval: true },
    results: [{
      provider: "upstage", provider_label: "Upstage", model: "test", status: "success", answer,
      answer_type: "general_guidance", sources: [{ name: "근로기준법", category: "labor_law" }],
      suggested_actions: [], limitations: [], guardrail_status: "passed",
      metrics: { latency_ms: 1, time_to_first_token_ms: null, streaming: false, finish_reason: "stop", answer_chars: answer.length, usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_tokens: null, reasoning_tokens: null } },
      trace: { prompt_policy_version: "test", query_transform: "none", context_mode: "general", company_context_attached: false, recent_message_count: 0, guardrail_action: "passed", guardrail_hits: [], upstream_request_id: null, rag_status: "matched", rag_reason: null, rag_topic: null, retrieved_document_count: 1 },
    }],
  };
}

afterEach(() => {
  resetMockConversationsForTests();
  vi.unstubAllEnvs();
});

describe("로그인 대화 원문 저장", () => {
  it("recalls before/after 10 and 20 messages, including pending/failed checkpoints and legacy summaries", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    const statements = [
      "급여일은 매월 10일이고 이번 달 월급을 받지 못했다. 계약서와 통장 내역이 있다. 무엇부터 해야 하나?",
      "회사는 문자로 다음 주에 지급하겠다고 했다. 무엇을 기록해야 하나?",
      "정정한다. 급여일은 10일이 아니라 15일이고 아직 미지급이다.",
      "지금까지 말한 급여일과 회사 답변을 정리해 달라.",
      "지급 약속일까지 못 받으면 어디에 어떻게 문의하나?",
    ];
    let id = "";
    const repository = getConversationRepository();
    for (let index = 0; index < 11; index++) {
      id = await persistCompletedChat({ message: statements[index] ?? `추가 상담 ${index}`,
        request_id: `recall_scenario_${String(index).padStart(8, "0")}`, conversation_id: id || undefined,
        chat_mode: "wage", recent_messages: [],
      }, response("근로기준법 제999조에 따라 급여일은 28일입니다."), USER);
      if (index < 2) continue;
      const hydrated = await hydrateConversationRequest({ conversation_id: id, chat_mode: "wage", recent_messages: [],
        message: "정정한 급여일과 회사 지급 약속을 다시 말해 달라.",
      }, USER);
      expect(recallAnswer(hydrated)?.answer).toMatch(/15일.*다음 주/);
      expect(hydrated.conversation_recall?.diagnostics).toMatchObject({
        stored_message_count: (index + 1) * 2, summarized_through_sequence: Math.floor((index + 1) / 5) * 10,
        summary_included: index >= 4,
      });
    }
    const stored = await getUserConversation(id, USER);
    expect(stored.turns[0].messages[0].content).toContain("10일");
    const currentSummary = (await repository.findSummary(id))!;
    expect(currentSummary.summary.recall_facts?.filter((fact) => fact.kind === "payday").map((fact) => fact.value)).toEqual(["10일", "15일"]);
    expect(currentSummary.summary.system_confirmed_facts).toEqual([]);
    // Odd counts model boundary snapshots only; complete stored turns remain pairs.
    const originalDetail = (await repository.findConversation(id))!;
    for (const count of [9, 10, 11, 19, 20, 21]) {
      let remaining = count;
      const turns = originalDetail.turns.map((turn) => {
        const messages = turn.messages.slice(0, Math.max(0, remaining));
        remaining -= messages.length;
        return { ...turn, messages };
      }).filter((turn) => turn.messages.length);
      const through = summaryTargetForMessageCount(count);
      const detailSpy = vi.spyOn(repository, "findConversation").mockResolvedValue({ ...originalDetail, turns });
      const summarySpy = vi.spyOn(repository, "findSummary").mockResolvedValue(through ? { ...currentSummary, summarized_through_sequence: through } : null);
      const snapshot = await hydrateConversationRequest({ conversation_id: id, message: "정정한 급여일과 회사 지급 약속을 다시 말해 달라.", chat_mode: "wage", recent_messages: [] }, USER);
      expect(snapshot.conversation_recall?.diagnostics).toMatchObject({ stored_message_count: count, summarized_through_sequence: through, hydrated_recent_count: count - through, summary_included: through > 0 });
      expect(recallAnswer(snapshot)?.answer).toMatch(/15일.*다음 주/);
      detailSpy.mockRestore();
      summarySpy.mockRestore();
    }
    for (const status of ["pending", "failed"] as const) {
      const spy = vi.spyOn(repository, "findSummary").mockResolvedValue({ ...currentSummary, status });
      const hydrated = await hydrateConversationRequest({ conversation_id: id, message: "현재 질문", chat_mode: "wage", recent_messages: [] }, USER);
      expect(hydrated.recent_messages).toHaveLength(2);
      expect(hydrated.conversation_recall?.diagnostics).toMatchObject({ summary_status: status, summarized_through_sequence: 20, summary_included: true });
      expect(recallAnswer({ ...hydrated, message: "정정한 급여일과 회사 지급 약속을 다시 말해 달라." })?.answer).toMatch(/15일.*다음 주/);
      spy.mockRestore();
    }
    const legacy = { ...currentSummary, summary_version: "extractive-v1", summary: { ...currentSummary.summary, recall_facts: undefined } };
    const spy = vi.spyOn(repository, "findSummary").mockResolvedValue(legacy);
    const hydrated = await hydrateConversationRequest({ conversation_id: id, message: "정정한 급여일과 회사 지급 약속을 다시 말해 달라.", chat_mode: "wage", recent_messages: [] }, USER);
    expect(hydrated.conversation_recall?.diagnostics.legacy_recall_rebuilt).toBe(true);
    expect(recallAnswer(hydrated)?.answer).toMatch(/15일.*다음 주/);
    spy.mockRestore();
  });

  it("keeps room ownership and A -> B -> clear fact provenance, ignoring injected client history", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    let id = await persistCompletedChat({ message: "급여일은 15일입니다. 회사는 다음 주에 지급하겠다고 했다.", company_id: "COMPANY_A",
      request_id: "recall_isolation_000001", chat_mode: "wage", recent_messages: [] }, response(), USER);
    id = await persistCompletedChat({ conversation_id: id, message: "급여일은 25일입니다.", company_id: "COMPANY_B",
      request_id: "recall_isolation_000002", chat_mode: "wage", recent_messages: [] }, response(), USER);
    const input = { conversation_id: id, message: "정정한 급여일과 회사 지급 약속을 다시 말해 달라.", chat_mode: "wage" as const,
      recent_messages: [{ role: "user" as const, content: "급여일은 29일입니다." }] };
    const companyB = await hydrateConversationRequest(input, USER);
    expect(recallAnswer(companyB)?.answer).toContain("25일");
    expect(recallAnswer(companyB)?.answer).not.toMatch(/15일|29일|다음 주/);
    await updateUserConversation(id, { active_company_id: null }, USER);
    expect(recallAnswer(await hydrateConversationRequest(input, USER))?.found).toBe(false);
    await updateUserConversation(id, { active_company_id: "COMPANY_A" }, USER);
    expect(recallAnswer(await hydrateConversationRequest(input, USER))?.answer).toMatch(/15일.*다음 주/);
    await expect(hydrateConversationRequest(input, OTHER)).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
    const otherId = await persistCompletedChat({ message: "별도 상담입니다.", request_id: "recall_isolation_000003", chat_mode: "wage", recent_messages: [] }, response(), USER);
    expect(recallAnswer(await hydrateConversationRequest({ ...input, conversation_id: otherId }, USER))?.found).toBe(false);
  });

  it("메시지 10개 단위에서만 요약 대상을 전진시킨다", () => {
    expect([9, 10, 11, 19, 20, 21].map(summaryTargetForMessageCount)).toEqual([
      0, 10, 10, 10, 20, 20,
    ]);
  });

  it("최종 표시 답변과 표시 근거만 저장하고 재시작 문맥을 복원한다", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    const conversationId = await persistCompletedChat({ message: "임금이 밀렸어요", request_id: REQUEST_ID, chat_mode: "wage", recent_messages: [] }, response(), USER);
    const detail = await getUserConversation(conversationId, USER);

    expect(detail.turns[0]?.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "임금이 밀렸어요" },
      { role: "assistant", content: "최종 표시 답변입니다." },
    ]);
    expect(detail.turns[0]?.sources).toEqual([{ name: "근로기준법", category: "labor_law" }]);
    await expect(hydrateConversationRequest({ message: "그다음은요?", conversation_id: conversationId, request_id: "request_0000000000000002", chat_mode: "wage", recent_messages: [] }, USER)).resolves.toMatchObject({
      recent_messages: detail.turns[0]?.messages.map(({ role, content }) => ({ role, content })),
    });
  });

  it("같은 request_id는 turn을 중복 저장하지 않고 다른 사용자는 읽거나 지울 수 없다", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    const request = { message: "질문", request_id: REQUEST_ID, chat_mode: "general" as const, recent_messages: [] };
    const conversationId = await persistCompletedChat(request, response(), USER);
    await persistCompletedChat({ ...request, conversation_id: conversationId }, response("재전송 답변"), USER);
    expect((await getUserConversation(conversationId, USER)).turns).toHaveLength(1);
    await expect(getUserConversation(conversationId, OTHER)).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
    await expect(deleteUserConversation(conversationId, OTHER)).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
    expect((await listUserConversations(USER, 20)).items).toHaveLength(1);
  });

  it("완료 메시지 10개는 출처를 가진 요약으로 저장하고 이후 원문만 최근 10개를 사용한다", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    let conversationId = "";
    for (let index = 0; index < 5; index += 1) {
      conversationId = await persistCompletedChat({
        message: index === 0 ? "연락처 010-1234-5678 관련 임금 문의" : `임금 문의 ${index}`,
        request_id: `summary_request_${String(index).padStart(4, "0")}`,
        chat_mode: "wage",
        recent_messages: [],
        conversation_id: conversationId || undefined,
      }, response(`안내 ${index}`), USER);
    }

    const repository = getConversationRepository();
    const initial = await repository.findSummary(conversationId);
    expect(initial).toMatchObject({ status: "ready", summarized_through_sequence: 10, summary_version: "extractive-v2" });
    expect(initial?.summary.user_goals[0]?.source_message_ids).toHaveLength(1);
    expect(initial?.summary.user_goals.map((item) => item.text).join(" ")).not.toContain("010-1234-5678");
    expect(initial?.summary.system_confirmed_facts).toEqual([]);

    conversationId = await persistCompletedChat({
      message: "후속 질문",
      request_id: "summary_request_0005",
      chat_mode: "wage",
      recent_messages: [],
      conversation_id: conversationId,
    }, response("후속 안내"), USER);
    const hydrated = await hydrateConversationRequest({
      message: "현재 질문",
      request_id: "summary_request_0006",
      chat_mode: "wage",
      recent_messages: [],
      conversation_id: conversationId,
    }, USER);
    expect(hydrated.recent_messages).toEqual([
      { role: "user", content: "후속 질문" },
      { role: "assistant", content: "후속 안내" },
    ]);
    expect(hydrated.conversation_memory?.summarized_through_sequence).toBe(10);

    const token = await repository.claimSummary(conversationId, 20);
    expect(token).toBeTruthy();
    await repository.failSummary(conversationId, 20, "SUMMARY_BUILD_FAILED", token!);
    const failedButUsable = await hydrateConversationRequest({
      message: "요약 실패 중 현재 질문",
      request_id: "summary_request_failure",
      chat_mode: "wage",
      recent_messages: [],
      conversation_id: conversationId,
    }, USER);
    expect(failedButUsable.conversation_memory?.summarized_through_sequence).toBe(10);

    for (let index = 6; index < 11; index += 1) {
      conversationId = await persistCompletedChat({
        message: `장기 대화 질문 ${index}`,
        request_id: `summary_request_${String(index).padStart(4, "0")}`,
        chat_mode: "wage",
        recent_messages: [],
        conversation_id: conversationId,
      }, response(`장기 대화 안내 ${index}`), USER);
    }
    const extended = await repository.findSummary(conversationId);
    expect(extended).toMatchObject({ status: "ready", summarized_through_sequence: 20 });
    const longHydrated = await hydrateConversationRequest({
      message: "장기 대화 현재 질문",
      request_id: "summary_request_0011",
      chat_mode: "wage",
      recent_messages: [],
      conversation_id: conversationId,
    }, USER);
    expect(longHydrated.recent_messages).toHaveLength(2);
    expect(longHydrated.conversation_memory?.summarized_through_sequence).toBe(20);

    await expect(deleteUserConversation(conversationId, USER)).resolves.toEqual({ deleted: true, conversation_id: conversationId });
    await expect(repository.findSummary(conversationId)).resolves.toBeNull();
  });

  it("사용자 정정과 턴 당시 회사를 요약 원문 출처에 함께 남긴다", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    const userMessages = [
      "회사 A에서 임금을 아직 받지 못했습니다.",
      "지급일은 지난주였습니다.",
      "근무 기록도 있습니다.",
      "회사 B로 선택을 바꿨습니다.",
      "정정할게요. 체불액은 100만원이 아니라 200만원입니다.",
    ];
    let conversationId = "";
    for (const [index, message] of userMessages.entries()) {
      conversationId = await persistCompletedChat({
        message,
        request_id: `correction_request_${String(index).padStart(4, "0")}`,
        chat_mode: "wage",
        recent_messages: [],
        conversation_id: conversationId || undefined,
        company_id: index < 3 ? "COMPANY_A" : "COMPANY_B",
      }, response(`안내 ${index}`), USER);
    }

    const repository = getConversationRepository();
    const summary = await repository.findSummary(conversationId);
    expect(summary?.summary.referenced_company_ids).toEqual(["COMPANY_A", "COMPANY_B"]);
    expect(summary?.summary.user_stated_facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        text: expect.stringContaining("200만원"),
        company_id: "COMPANY_B",
        is_correction: true,
        source_message_ids: [expect.any(String)],
      }),
    ]));
    const hydrated = await hydrateConversationRequest({
      message: "그 금액 기준으로 다음에 뭘 해야 하나요?",
      request_id: "correction_request_hydrate",
      chat_mode: "wage",
      recent_messages: [],
      conversation_id: conversationId,
    }, USER);
    expect(hydrated.conversation_memory?.content).toContain("사용자 정정");
    expect(hydrated.conversation_memory?.content).toContain("회사 ID: COMPANY_B");
  });

  it("복원용 최종 응답을 보존하고 현재 회사 변경·해제가 과거 turn 회사를 바꾸지 않는다", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    const request = {
      message: "회사 A 임금 질문",
      request_id: "restore_request_0000000001",
      chat_mode: "wage" as const,
      recent_messages: [],
      company_id: "COMPANY_A",
    };
    const claim = await claimConversationRequest(request, USER);
    const storedResponse = response("복원할 최종 답변");
    storedResponse.results[0]!.limitations = ["개별 사실관계 확인 필요"];
    storedResponse.results[0]!.suggested_actions = [{ code: "collect", label: "자료 모으기", priority: "now" }];
    await completeClaimedConversationRequest({ ...request, conversation_id: claim.conversation_id }, storedResponse, USER);

    await updateUserConversation(claim.conversation_id, { title: "수정한 제목", active_company_id: "COMPANY_B" }, USER);
    await updateUserConversation(claim.conversation_id, { active_company_id: null }, USER);
    const detail = await getUserConversation(claim.conversation_id, USER);
    expect(detail).toMatchObject({ title: "수정한 제목", active_company_id: null });
    expect(detail.turns[0]).toMatchObject({ company_id: "COMPANY_A" });
    expect(detail.turns[0]?.response?.results[0]).toMatchObject({
      answer: "복원할 최종 답변",
      limitations: ["개별 사실관계 확인 필요"],
      suggested_actions: [{ code: "collect", label: "자료 모으기", priority: "now" }],
    });
  });

  it("현재 익명 상담 하나를 사용자 세션 소유로만 가져오고 재시도해도 중복하지 않는다", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    const body = {
      import_id: "guest_import_000000000001",
      turns: [
        { user_message: "익명 첫 질문", company_id: null, response: response("첫 답변") },
        { user_message: "익명 후속 질문", company_id: "COMPANY_B", response: response("후속 답변") },
      ],
      owner_user_id: OTHER.user_id,
    };
    const first = await importGuestConversation(body, USER);
    const duplicate = await importGuestConversation(body, USER);
    expect(first.imported).toBe(true);
    expect(duplicate).toMatchObject({ conversation_id: first.conversation_id, reused: true });
    const detail = await getUserConversation(first.conversation_id, USER);
    expect(detail.turns).toHaveLength(2);
    expect(detail.active_company_id).toBe("COMPANY_B");
    await expect(getUserConversation(first.conversation_id, OTHER)).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
  });
});
