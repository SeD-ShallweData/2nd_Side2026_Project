import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import type { ChatRequest } from "@/domain/chat";
import { extractRecallFacts, recallAnswer, recallResponse } from "@/services/conversationRecallService";
import { hydrateConversationRequest, persistCompletedChat, updateUserConversation } from "@/services/conversationService";
import { resetMockConversationsForTests } from "@/services/userDataProviders";

const providers = [{ id: "upstage" as const, label: "test", model: "none" }];
const user = { user_id: "00000000-0000-4000-8000-000000000024", email: "aq02@example.invalid", display_name: "synthetic", role: "user" as const };
const companies = [{ company_id: "COMPANY_DEMO_008", company_name: "한빛테크" },
  { company_id: "COMPANY_DEMO_002", company_name: "다온제조" }];
const request = (message: string, recent_messages: ChatRequest["recent_messages"] = []): ChatRequest =>
  ({ message, recent_messages, chat_mode: "wage" });

afterEach(() => { resetMockConversationsForTests(); vi.unstubAllEnvs(); });

describe("answer quality 02: frozen history replay", () => {
  it("S19 uses the corrected day and both requested numbered items", () => {
    const input = request("제가 정정한 급여일은 언제인가요? 1번에 사실, 2번에 확인할 자료를 써 주세요.", [
      { role: "user", content: "가상의 세움물류에서 급여일은 매달 22일이라고 들었습니다." },
      { role: "assistant", content: "급여일 22일을 기준으로 입금 내역을 확인해 보세요." },
      { role: "user", content: "정정합니다. 세움물류의 급여일은 24일입니다." },
    ]);
    const answer = recallResponse(input, providers)?.results[0].answer;
    expect(answer).toMatch(/1\. 사실: .*24일/);
    expect(answer).toMatch(/2\. 확인할 자료:.*입금 내역/);
    expect(answer).not.toContain("22일");
  });
  it("S20 keeps contract delivery unstated despite an assistant guess", () => {
    const input = request("The earlier assistant assumed too much. 한국어로 제가 실제 말한 계약서 상태와 아직 확인할 점을 구분해 주세요.", [
      { role: "user", content: "가상의 늘봄상사에는 월급 입금 내역은 있지만 계약서 교부 여부는 아직 말하지 않았습니다." },
      { role: "assistant", content: "계약서를 받지 못하셨군요." },
    ]);
    const answer = recallResponse(input, providers)?.results[0].answer;
    expect(answer).toContain("교부 여부는 아직 말씀하지 않으셨습니다");
    expect(answer).not.toContain("계약서를 받지 못하셨군요");
  });
});

describe("answer quality 02: corrected user facts", () => {
  it("keeps resignation, work hours, accident location and a bounded partial payment by company", () => {
    const a = companies[0].company_id, b = companies[1].company_id;
    const source = [
      [a, "한빛테크를 그만둔 날은 지난달 12일입니다."],
      [a, "퇴사일을 정정합니다. 한빛테크를 그만둔 날은 지난달 12일이 아니라 19일입니다."],
      [b, "다온제조의 하루 근무시간은 9시간입니다."],
      [b, "정정합니다. 다온제조의 하루 근무시간은 9시간이 아니라 5시간입니다."],
      [b, "사고 장소도 정정합니다. 다온제조 일터가 아니라 퇴근 뒤 집 계단에서 넘어졌습니다."],
      [a, "한빛테크에서 미지급 임금 100만 원 중 70만 원이 오늘 입금됐습니다. 나머지는 아직입니다."],
    ] as const;
    const facts = source.flatMap(([company_id, content], sequence) => extractRecallFacts({
      content, company_id, companies, sequence, source_message_id: `m${sequence}`,
    }));
    const input = request("한빛테크와 다온제조의 정정 내용을 각각 구분해 주세요.");
    input.company_id = b;
    input.conversation_recall = { facts, companies, company_history: [], diagnostics: {
      summary_status: "ready", summary_version: "extractive-v4", summarized_through_sequence: 10,
      stored_message_count: 12, hydrated_recent_count: 2, summary_included: true,
      recall_fact_count: facts.length, legacy_recall_rebuilt: false,
    } };
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ company_id: a, kind: "resignation_date", value: "지난달 19일" }),
      expect.objectContaining({ company_id: b, kind: "work_hours", value: "하루 5시간" }),
      expect.objectContaining({ company_id: b, kind: "accident_location", value: "퇴근 뒤 집 계단" }),
      expect.objectContaining({ company_id: a, kind: "wage_balance", value: "100만 원 중 70만 원 입금, 남은 금액 30만 원" }),
    ]));
    const all = recallAnswer(input)?.answer;
    expect(all).toContain("한빛테크: 퇴사일은 지난달 19일");
    expect(all).toContain("다온제조: 근무시간은 하루 5시간");
    expect(all).toContain("사고 장소는 퇴근 뒤 집 계단");
    expect(all).not.toContain("하루 9시간");
    expect(recallAnswer({ ...input, message: "한빛테크의 미지급 잔액은 얼마인가요?" })?.answer).toContain("남은 금액 30만 원");
    expect(recallAnswer({ ...input, message: "다온제조의 미지급 잔액은 얼마인가요?" })?.found).toBe(false);
  });
  it("does not derive an amount without both operands or from a question", () => {
    expect(extractRecallFacts({ content: "70만 원이 입금됐습니다.", company_id: "A", sequence: 1, source_message_id: "a" })
      .some(fact => fact.kind === "wage_balance")).toBe(false);
    expect(extractRecallFacts({ content: "100만 원 중 70만 원이 입금됐나요?", company_id: "A", sequence: 1, source_message_id: "b" }))
      .toEqual([]);
  });
  it("D2T03-T04 and D2T15-T22 retain each company's corrected fact", () => {
    const ownerCompanies = [{ company_id: "A", company_name: "새봄서비스" },
      { company_id: "B", company_name: "푸른건설" }];
    const sources: Array<[string, string]> = [
      ["A", "새봄서비스에서 일했고 지난달 12일에 퇴사했다고 처음 메모했습니다."],
      ["A", "퇴사일을 정정합니다. 새봄서비스를 그만둔 날은 지난달 12일이 아니라 19일입니다."],
      ["B", "사고 장소도 정정해야 합니다. 푸른건설 일터가 아니라 퇴근 뒤 집 계단에서 넘어졌습니다."],
      ["A", "새봄서비스에서 미지급이라고 했던 마지막 달 임금 100만 원 중 70만 원이 오늘 입금됐습니다. 나머지는 아직입니다."],
    ];
    const facts = sources.flatMap(([company_id, content], sequence) => extractRecallFacts({
      content, company_id, companies: ownerCompanies, sequence, source_message_id: `d2_${sequence}`,
    }));
    const input = request("그럼 이전에 말한 12일을 기준으로 계속 계산하면 안 되겠죠?");
    input.company_id = "A";
    input.conversation_recall = { facts, companies: ownerCompanies, company_history: [], diagnostics: {
      summary_status: "ready", summary_version: "extractive-v4", summarized_through_sequence: 10,
      stored_message_count: 12, hydrated_recent_count: 2, summary_included: true,
      recall_fact_count: facts.length, legacy_recall_rebuilt: false,
    } };
    const date = recallResponse(input, providers)?.results[0].answer;
    expect(date).toContain("지난달 19일");
    expect(date).toContain("이전 12일은 최신 진술의 기준으로 쓰지 않습니다");
    expect(recallAnswer({ ...input, message: "중간 점검입니다. 새봄과 푸른 각각의 정정 내용을 구분해 주세요." })?.answer)
      .toMatch(/새봄서비스: 퇴사일은 지난달 19일[\s\S]*푸른건설: 사고 장소는 퇴근 뒤 집 계단/);
    expect(recallAnswer({ ...input, message: "현재 제가 말한 새봄서비스의 미지급 잔액은 얼마인가요?" })?.answer)
      .toContain("남은 금액 30만 원");
  });
});

describe("answer quality 02: actually accumulated mock conversation", () => {
  it("recalls corrected facts after topic and company switches, summary checkpoints and clear", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock");
    vi.stubEnv("COMPANY_DATA_MODE", "mock");
    const a = "COMPANY_DEMO_008", b = "COMPANY_DEMO_002";
    const turns: Array<[string, string]> = [
      [a, "한빛테크의 급여일은 매달 22일입니다. 한빛테크를 그만둔 날은 지난달 12일입니다."],
      [a, "정정합니다. 한빛테크의 급여일은 24일입니다. 한빛테크를 그만둔 날은 지난달 12일이 아니라 19일입니다."],
      [b, "다온제조의 하루 근무시간은 9시간입니다."],
      [b, "정정합니다. 다온제조의 하루 근무시간은 9시간이 아니라 5시간입니다."],
      [b, "다온제조 일터가 아니라 퇴근 뒤 집 계단에서 넘어졌습니다."],
      [a, "한빛테크에서 미지급 임금 100만 원 중 70만 원이 입금됐습니다. 나머지는 아직입니다."],
    ];
    for (let i = 6; i < 26; i++) turns.push([i % 2 ? a : b, `상담 주제 전환 ${i}: 면접 질문을 정리합니다.`]);
    let id = "";
    for (const [index, [company_id, message]] of turns.entries()) {
      id = await persistCompletedChat({ message, company_id, conversation_id: id || undefined,
        request_id: `aq02_${String(index).padStart(20, "0")}`, chat_mode: "wage", recent_messages: [] },
      recallResponse(request("급여일은 10일입니다."), providers)!, user);
    }
    const check = async (company_id?: string) => hydrateConversationRequest({ conversation_id: id, company_id,
      message: "한빛테크의 미지급 잔액은 얼마인가요?", chat_mode: "wage", recent_messages: [] }, user);
    const bSelected = await check(b);
    expect(bSelected.conversation_recall?.diagnostics.summarized_through_sequence).toBe(50);
    expect(recallAnswer(bSelected)?.answer).toContain("남은 금액 30만 원");
    expect(recallAnswer({ ...bSelected, message: "다온제조의 근무시간과 사고 장소를 정리해 주세요." })?.answer)
      .toMatch(/하루 5시간.*집 계단/);
    await updateUserConversation(id, { active_company_id: null }, user);
    const cleared = await check();
    expect(recallAnswer(cleared)?.answer).toContain("남은 금액 30만 원");
    expect(recallAnswer({ ...cleared, message: "이 회사의 미지급 잔액은 얼마인가요?" })?.found).toBe(false);
    await expect(hydrateConversationRequest({ conversation_id: id,
      message: "한빛테크의 미지급 잔액은 얼마인가요?", chat_mode: "wage", recent_messages: [] },
    { ...user, user_id: "00000000-0000-4000-8000-000000000025" })).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
  });
});
