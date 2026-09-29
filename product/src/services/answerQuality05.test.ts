import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { extractRecallFacts, finalizeConversationResponse, recallResponse } from "@/services/conversationRecallService";
import { documentStatusFromStatements } from "@/services/conversationDocumentStatus";
import { mentionedCompanies } from "@/services/conversationCompanyScope";
import { userFactGuardrailHits } from "@/services/userFactAnswerGuardrails";
import { hydrateConversationRequest, persistCompletedChat } from "@/services/conversationService";
import { resetMockConversationsForTests } from "@/services/userDataProviders";
import { reviewedLaborRetrieval } from "@/services/reviewedLaborGuidance";
import { DualLlmChatProvider } from "@/adapters/real/DualLlmChatProvider";
import { OpenAICompatibleChatClient } from "@/adapters/real/OpenAICompatibleChatClient";
import type { ChatRequest } from "@/domain/chat";
import type { ComparisonContext } from "@/domain/chatComparison";

const A = "COMPANY_DEMO_001", B = "COMPANY_DEMO_006";
const companies = [
  { company_id: A, company_name: "OO건설", region: "인천광역시", address: "인천광역시 서구 샘플로 10" },
  { company_id: B, company_name: "OO건설", region: "경기도", address: "경기도 김포시 예시로 21" },
];
const providers = [{ id: "upstage" as const, label: "synthetic", model: "test" }];
const diagnostics = { summary_status: "ready" as const, summary_version: "extractive-v4", summarized_through_sequence: 20,
  stored_message_count: 22, hydrated_recent_count: 2, summary_included: true, recall_fact_count: 4, legacy_recall_rebuilt: false };
const facts = [
  { kind: "payday" as const, value: "23일", company_id: A, sequence: 3, source_message_id: "a", is_correction: true },
  { kind: "payday" as const, value: "8일", company_id: B, sequence: 4, source_message_id: "b", is_correction: false },
  { kind: "wage_balance" as const, value: "100만 원 중 70만 원 입금, 남은 금액 30만 원", company_id: A, sequence: 9, source_message_id: "c", is_correction: false },
];
const documents = [
  { company_id: A, text: "근로계약서 원본은 분실했고 사본만 갖고 있습니다.", sequence: 5, source_message_id: "a5", is_correction: true },
  { company_id: A, text: "통장 사본은 계속 보관 중이며 급여명세서는 없습니다.", sequence: 5, source_message_id: "a6", is_correction: false },
  { company_id: B, text: "급여명세서는 갖고 있습니다.", sequence: 6, source_message_id: "b6", is_correction: false },
];
const request = (message: string): ChatRequest => ({ message, chat_mode: "wage", recent_messages: [], company_id: B,
  conversation_recall: { facts, companies, company_history: [], diagnostics, document_statements: documents } });
afterEach(() => { resetMockConversationsForTests(); vi.unstubAllEnvs(); });

describe("actual AQ05 failures: owner facts and response assembly", () => {
  it("keeps a working-hours and document clause under the selected known company", () => {
    const result = extractRecallFacts({ content: "김포 OO건설은 급여일이 매달 8일입니다. 하루 9시간 일하며 급여명세서는 갖고 있습니다.",
      company_id: B, companies, sequence: 1, source_message_id: "b" });
    expect(result).toContainEqual(expect.objectContaining({ company_id: B, kind: "work_hours", value: "하루 9시간" }));
    const unknown = extractRecallFacts({ content: "새로운업체에서는 하루 7시간 근무합니다.", company_id: B, companies, sequence: 1, source_message_id: "u" });
    expect(unknown).toEqual([]);
  });
  it("distinguishes two location-only references and labels same-name facts", () => {
    const input = request("1. 인천 2. 김포 순서로 최신 급여일을 각각 다시 알려주세요.");
    expect(mentionedCompanies(input.message, companies).map(c => c.company_id)).toEqual([A,B]);
    const answer = recallResponse(input, providers)!.results[0].answer;
    expect(answer).toMatch(/1\. .*인천.*23일/);
    expect(answer).toMatch(/2\. .*김포.*8일/);
  });
  it("keeps explicitly retained bank copy and distinguishes unstated B documents", () => {
    const rows = documentStatusFromStatements(documents, [A,B]);
    expect(rows).toContainEqual(expect.objectContaining({ company_id:A, document:"bank_copy", state:"held" }));
    expect(rows).toContainEqual(expect.objectContaining({ company_id:B, document:"bank_copy", state:"unstated" }));
  });
  it("detects same-name document transfer in actual L17 bullet format", () => {
    const input = request("1. 인천 2. 김포 OO건설의 서류 상태를 구분하고 임금체불 진정 자료로 어떻게 쓰나요?");
    const raw = "인천 OO건설\n- 보유 서류: 근로계약서 사본, 통장 사본, 급여명세서 없음\n\n김포 OO건설\n- 보유 서류: 근로계약서 사본, 통장 사본, 급여명세서 없음";
    expect(userFactGuardrailHits(raw,input)).toContain("USER_DOCUMENT_STATE_CONTRADICTION");
  });
  it("separates original loss from copy possession in the actual L09 sentence", () => {
    const input = request("인천 OO건설에서 제가 가진 서류와 없는 서류를 구분해 주세요.");
    expect(userFactGuardrailHits("인천 OO건설의 근로계약서 원본은 분실했고 사본만 보유하고 있습니다. 통장 사본은 보관 중이며 급여명세서는 없습니다.",input)).toEqual([]);
    expect(userFactGuardrailHits("김포 OO건설\n- 부재 서류: 근로계약서 원본·사본, 통장 사본",request("김포 OO건설의 서류 상태를 알려주세요."))).toContain("USER_DOCUMENT_STATE_CONTRADICTION");
  });
  it("answers paid and remaining amounts and avoids repeating a document prefix", () => {
    expect(recallResponse(request("인천 OO건설에서 제가 받은 금액과 아직 못 받은 잔액은 각각 얼마인가요?"),providers)?.results[0].answer)
      .toContain("70만 원 입금, 남은 금액 30만 원");
    const input = request("1번 인천의 최신 급여일과 남은 금액, 2번 제가 보유한 서류와 추가로 확인할 자료를 알려주세요.");
    const response = finalizeConversationResponse(input, recallResponse(input,providers)!);
    expect(response.results[0].answer).toContain("23일");
    expect(response.results[0].answer).toContain("30만 원");
    expect(response.results[0].answer.match(/통장 사본/g)).toHaveLength(1);
  });
  it("does not short-circuit a card plus fact request as document-only recall", () => {
    expect(recallResponse(request("인천과 김포 OO건설의 임금 카드 차이와 제가 말한 급여일·서류 상태를 각각 정리해 주세요."),providers)).toBeNull();
  });
  it("uses owner-checked stored document clauses after a summary boundary", async () => {
    vi.stubEnv("CONVERSATION_DATA_MODE", "mock"); vi.stubEnv("COMPANY_DATA_MODE", "mock");
    const owner = { user_id:"00000000-0000-4000-8000-000000000055",email:"aq05@example.invalid",display_name:"synthetic",role:"user" as const };
    let id: string | undefined;
    const statements = ["김포 OO건설은 급여일이 매달 8일입니다. 하루 9시간 일하며 급여명세서는 갖고 있습니다.",
      "김포 OO건설의 근무시간은 하루 5시간으로 정정합니다.","통장 사본은 보관 중입니다.","급여일은 매달 8일입니다.","급여일은 매달 8일입니다.","급여일은 매달 8일입니다."];
    for (const message of statements) {
      const input: ChatRequest = { message,company_id:B,conversation_id:id,request_id:crypto.randomUUID(),chat_mode:"wage",recent_messages:[] };
      id = await persistCompletedChat(input,recallResponse(request("급여일은 8일입니다."),providers)!,owner);
    }
    const hydrated = await hydrateConversationRequest({message:"김포 OO건설의 서류 상태를 알려주세요.",conversation_id:id,chat_mode:"wage",recent_messages:[]},owner);
    expect(hydrated.conversation_recall?.diagnostics.summarized_through_sequence).toBeGreaterThanOrEqual(10);
    const answer = recallResponse(hydrated,providers)!.results[0].answer;
    expect(answer).toMatch(/급여명세서: 보유한다고/);
    expect(answer).toMatch(/통장 사본: 보유한다고/);
  });
});

async function generated(message: string, raw: string, extra: Partial<ComparisonContext> = {}) {
  const rag = reviewedLaborRetrieval(message) ?? {query:message,status:"no_match" as const,documents:[],reason:"company_context_only",threshold:null};
  const context: ComparisonContext = { request:request(message), questionIntent:"labor",ragRetrieval:rag,
    policyBaseline:{answer:"기본 안내",answer_type:"general_guidance",sources:rag.documents.map(d=>d.source),suggested_actions:[],limitations:[],guardrail_status:"limited",conversation_id:"synthetic"},...extra };
  const fetcher = vi.fn(async () => new Response(JSON.stringify({model:"test",choices:[{message:{content:raw},finish_reason:"stop"}]})));
  const provider = new DualLlmChatProvider([{...providers[0],apiKey:"synthetic",apiUrl:"https://test.invalid"}],new OpenAICompatibleChatClient(fetcher));
  return (await provider.compare(context)).results[0];
}
describe("actual AQ05 failures: question-specific evidence and guard recovery", () => {
  it("selects payslip evidence and corrects the actual Article43 misattribution", async () => {
    const message = "월급이 들어왔는데 급여명세서를 받지 못했습니다. 지급 내용 확인을 위해 어떤 자료를 요청하고 남길까요?";
    expect(reviewedLaborRetrieval(message)?.documents.some(d=>d.content.includes("제48조"))).toBe(true);
    const result = await generated(message,"회사가 급여명세서를 발급하지 않는 것은 근로기준법 제43조 위반입니다. 미지급액을 기록하세요.");
    expect(result.status).toBe("guardrail_replaced");
    expect(result.answer).toMatch(/명세서.*요청/);
    expect(result.answer).toContain("계산방법");
    expect(result.answer).not.toContain("제43조");
  });
  it("retains document-use actions after correcting an invented document state", async () => {
    const result = await generated("인천 OO건설에서 제가 가진 서류를 임금체불 진정에 어떻게 활용하나요?", "인천 OO건설의 통장 사본은 없습니다.");
    expect(result.trace.guardrail_hits).toContain("USER_DOCUMENT_STATE_CONTRADICTION");
    expect(result.answer).toContain("거래내역으로 별도 확인");
    expect(result.answer).toContain("노동포털");
    expect(result.answer).not.toContain("어떤 점을 확인");
  });
  it("retains the reviewed payslip source when raw cites its supported Article48", async () => {
    const result = await generated("급여명세서를 못 받았습니다. 어떤 항목을 요청하나요?", "근로기준법 제48조에 따른 임금명세서의 구성항목·계산방법·공제내역을 회사에 요청하고 입금 기록과 대조하세요.");
    expect(result.trace.guardrail_hits).toEqual([]);
    expect(result.sources.some(source => source.document_id === "reviewed-20260929:payslip")).toBe(true);
  });
  it("keeps an interview question when raw contains an unrelated legal citation", async () => {
    const result = await generated("인천 현장의 안전교육과 보호구 지급을 면접에서 묻는다면 질문을 어떻게 만들까요?",
      "안전교육과 보호구 지급은 어떻게 되나요? (고용노동부 노동포털 「체불임금 해결 방법」)");
    expect(result.trace.guardrail_hits).toContain("UNVERIFIED_LAW_CITATION");
    expect(result.answer).toContain("?");
    expect(result.answer).toContain("보호구");
    expect(result.sources).toEqual([]);
  });
  it("keeps both requested actions and locations for any guarded split answer", async () => {
    const message = "인천 OO건설 임금 문제의 다음 행동과 김포 OO건설 발목 문제의 우선 행동을 나눠 근거 범위를 표시해 주세요.";
    const result = await generated(message,"인천 OO건설 임금 기록을 확인하세요. 김포 OO건설 발목은 진료를 받으세요. 사용자 진술 기준입니다. (고용노동부 노동포털 「산업재해 신청 안내」)");
    expect(result.trace.guardrail_hits).toContain("UNVERIFIED_LAW_CITATION");
    expect(result.answer).toMatch(/1\. 인천 OO건설 임금/);
    expect(result.answer).toMatch(/2\. 김포 OO건설 발목/);
  });
});
