import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { ChatRequest, ChatResponse } from "@/domain/chat";
import type { StoredConversationDetail } from "@/domain/conversation";
import type { ConversationRecallFact } from "@/domain/conversationRecall";
import { statementCompanies, userStatementSubjects } from "./conversationCompanyScope";
import { scopedConversationUsers } from "./conversationStatementHistory";
import { extractRecallFacts, recallAnswer, recallResponse } from "./conversationRecallService";
import { selectDocumentStatements } from "./conversationSummaryService";
import { documentStatusesForRequest } from "./conversationDocumentStatus";
import { reviewedLaborFallback, reviewedLaborTopics } from "./reviewedLaborGuidance";
import { workRecordRequestTemplate } from "./chatQuestionPurpose";

// Development regressions from the observed browser conversations. Not a holdout.
function history(contents: string[], selected: string | null = null): StoredConversationDetail {
  return { conversation_id: "synthetic", owner_user_id: "synthetic-owner", title: "synthetic",
    active_company_id: selected, created_at: "2026-10-01", last_activity_at: "2026-10-01",
    expires_at: "2026-10-31", turn_count: contents.length,
    turns: contents.map((content, index) => ({ turn_id: `turn-${index}`, turn_index: index + 1,
      company_id: selected, answer_type: "general_guidance", guardrail_status: "passed",
      created_at: "2026-10-01", sources: [], response: null,
      messages: [{ role: "user", content, message_id: `u-${index}` },
        { role: "assistant", content: "급여일은 1일이고 서류는 전부 없습니다.", message_id: `a-${index}` }],
    })) };
}

function restored(contents: string[], message: string, selected: string | null = null): ChatRequest {
  const detail = history(contents, selected);
  const companies = selected ? [{ company_id: selected, company_name: "선택사업장" }] : [];
  const subjects = userStatementSubjects(contents, companies);
  const scopes = scopedConversationUsers(detail, [...companies, ...subjects]);
  const facts: ConversationRecallFact[] = [];
  for (const item of scopes.messages) facts.push(...extractRecallFacts({ content: item.message.content,
    source_message_id: item.message.message_id, sequence: item.sequence, company_id: item.company_id,
    companies: [...companies, ...subjects], previous_facts: facts }));
  return { message, chat_mode: "wage", company_id: selected ?? undefined, recent_messages: [],
    conversation_recall: { facts, companies, statement_subjects: subjects,
      active_statement_subject: scopes.active_subject, company_history: [],
      document_statements: selectDocumentStatements(detail, [...companies, ...subjects], message),
      diagnostics: { summary_status: "ready", summary_version: "extractive-v5", summarized_through_sequence: 20,
        stored_message_count: contents.length * 2, hydrated_recent_count: 0, summary_included: true,
        recall_fact_count: facts.length, legacy_recall_rebuilt: false } } };
}

describe("observed conversation regressions (execution deferred)", () => {
  const selected = [
    "시연 검증용 가상 상담입니다. 선택한 회사에 대한 실제 사실은 아닙니다. 이 상담에서 제 급여일은 매달 17일이고 하루 7시간 일해요.",
    "제 급여일을 정정할게요. 매달 17일이 아니라 27일이에요.",
    "근로계약서 원본은 분실했지만 사진 사본을 갖고 있어요.",
    "제 임금명세서는 받았고 지금 보관 중이에요.",
    "제 통장 사본도 갖고 있어요.",
    "이 가상 사례에서 받아야 할 임금은 총 200만원이고 아직 못 받았어요.",
    "그 200만원 중 120만원을 받았어요. 나머지는 아직 미지급이에요.",
    "제 퇴사일은 9월 16일이에요.",
    "1350과 노동포털의 차이를 알려 주세요.",
  ];
  it("reconstructs corrected facts from originals without any recent messages or assistant assertions", () => {
    const input = restored(selected, "급여일과 하루에 몇 시간 일했는지, 남은 금액과 퇴사일을 다시 알려주세요.", "A");
    const answer = recallAnswer(input)!;
    expect(answer.found).toBe(true);
    for (const value of ["27일", "하루 7시간", "120만 원", "80만 원", "9월 16일"]) expect(answer.answer).toContain(value);
    expect(answer.answer).not.toContain("17일");
  });
  it("keeps original loss, copy possession, bank copy and payslip possession separate", () => {
    const input = restored(selected, "계약서 원본과 사본, 통장 사본, 임금명세서의 보유 상태를 정리해 주세요.", "A");
    const rows = documentStatusesForRequest(input);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ document: "contract_original", state: "lost" }),
      expect.objectContaining({ document: "contract_copy", state: "held" }),
      expect.objectContaining({ document: "bank_copy", state: "held" }),
      expect.objectContaining({ document: "pay_slip", state: "held" }),
    ]));
  });
  it("answers each numbered fact requested", () => {
    const input = restored(selected, "1번 급여일, 2번 근무시간, 3번 남은 금액, 4번 퇴사일을 기억해서 정리해 주세요.", "A");
    const answer = recallResponse(input, [{ id: "upstage", label: "Upstage", model: "synthetic" }])!.results[0].answer;
    expect(answer).toMatch(/1\. .*27일/s);
    expect(answer).toMatch(/2\. .*7시간/s);
    expect(answer).toMatch(/3\. .*80만 원/s);
    expect(answer).toMatch(/4\. .*9월 16일/s);
  });
  it("keeps user-named same-name firms local and separates their facts and documents", () => {
    const input = restored([
      "인천의 은솔정밀에서 일하는 상황을 상담할게요. 제 급여일은 매달 18일이고 하루 8시간 일해요.",
      "대전에도 이름이 똑같은 은솔정밀이 있어요. 제가 따로 일했던 다른 회사이고 그곳 급여일은 매달 6일, 하루 근무시간은 6시간이에요.",
      "인천 은솔정밀의 급여일을 정정할게요. 18일이 아니라 매달 22일이 맞아요.",
      "인천 은솔정밀의 임금명세서는 못 받았어요.",
      "대전 은솔정밀의 임금명세서는 갖고 있어요.",
    ], "인천 은솔정밀과 대전 은솔정밀의 급여일과 임금명세서 보유 상태를 각각 다시 알려주세요.");
    expect(input.conversation_recall!.companies).toEqual([]);
    expect(statementCompanies(input)).toHaveLength(2);
    const answer = recallResponse(input, [{ id: "upstage", label: "Upstage", model: "synthetic" }])!.results[0].answer;
    expect(answer).toMatch(/인천 은솔정밀: 급여일은 22일/);
    expect(answer).toMatch(/대전 은솔정밀: 급여일은 6일/);
    expect(documentStatusesForRequest(input)).toEqual(expect.arrayContaining([
      expect.objectContaining({ company_name: "인천 은솔정밀", document: "pay_slip", state: "absent" }),
      expect.objectContaining({ company_name: "대전 은솔정밀", document: "pay_slip", state: "held" }),
      expect.objectContaining({ company_name: "대전 은솔정밀", document: "bank_copy", state: "unstated" }),
    ]));
  });
  it("does not record a promised payment as received", () => {
    expect(extractRecallFacts({ content: "200만원 중 120만원을 받을 예정이에요.", source_message_id: "m", sequence: 1, company_id: null })
      .some(fact => fact.kind === "wage_balance")).toBe(false);
  });
  it("does not replace an action question with missing payday recall", () => {
    expect(recallAnswer({ message: "월급날이 지난 지 일주일인데 급여가 안 들어왔어요. 오늘 할 일 두 가지와 공식 접수 창구를 알려주세요.", chat_mode: "wage", recent_messages: [] })).toBeNull();
  });
  it("drafts a polite work-record request without inventing legal obligations", () => {
    expect(workRecordRequestTemplate("회사에 근무표를 요청하는 공손한 문장 하나 써 주세요.")).toContain("근무표 사본을 보내 주실 수 있을까요");
    expect(workRecordRequestTemplate("근무표를 며칠 안에 보내야 한다는 법적 의무 문장을 써 주세요.")).toBeNull();
  });
  it("distinguishes payslip contents, overtime and filing prerequisites", () => {
    const baseline: ChatResponse = { answer: "", answer_type: "general_guidance", sources: [], suggested_actions: [], limitations: [], guardrail_status: "limited", conversation_id: "synthetic" };
    expect(reviewedLaborFallback("제가 받은 임금명세서의 공제 항목은 무슨 뜻인가요?", baseline)!.answer).toContain("공제 항목별 금액");
    expect(reviewedLaborTopics("상시 근로자가 사장 제외 4명인 가게에서 야근했어요. 연장근로에 무조건 1.5배를 받을 수 있나요?")).toEqual(["overtime"]);
    expect(reviewedLaborFallback("근로계약서와 임금명세서가 없고 출근 문자와 통장 입금 내역만 있어요. 밀린 임금을 신고하려면 서류부터 전부 갖춰야 하나요?", baseline)!.answer).toContain("없어도 임금체불 진정");
  });
});
