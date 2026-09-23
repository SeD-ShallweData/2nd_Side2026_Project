import "server-only";

import type { StoredConversationDetail, StoredConversationMessage } from "@/domain/conversation";
import type {
  ConversationStructuredSummary,
  ConversationSummaryItem,
  StoredConversationSummaryState,
} from "@/domain/conversationSummary";
import type { ConversationMemoryContext } from "@/domain/chat";
import { getConversationRepository } from "@/services/userDataProviders";
import { extractRecallFacts } from "@/services/conversationRecallService";

export const SUMMARY_VERSION = "extractive-v2";
const SUMMARY_BATCH_SIZE = 10;
const MAX_ITEMS_PER_FIELD = 6;

export function summaryTargetForMessageCount(messageCount: number): number {
  return Math.floor(messageCount / SUMMARY_BATCH_SIZE) * SUMMARY_BATCH_SIZE;
}

function emptySummary(): ConversationStructuredSummary {
  return {
    user_goals: [], user_stated_facts: [], system_confirmed_facts: [],
    actions_already_given: [], open_questions: [], referenced_company_ids: [], contract_review_summary: null,
  };
}

/* 요약은 원문보다 외부 모델에 더 자주 전달될 수 있어 직접 식별자는 제거한다. */
function redactDirectIdentifiers(value: string): string {
  return value
    .replace(/\b\d{6}-?[1-4]\d{6}\b/g, "[주민등록번호 제거]")
    .replace(/\b01[016789]-?\d{3,4}-?\d{4}\b/g, "[전화번호 제거]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[이메일 제거]")
    .replace(/(?:서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시|경기도|강원특별자치도|충청[남북]도|전라[남북]도|경상[남북]도|제주특별자치도)[가-힣0-9\s-]{0,45}(?:로|길|동)\s*\d{1,4}/g, "[상세주소 제거]")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(
  message: StoredConversationMessage,
  max = 300,
  companyId?: string,
  isCorrection = false,
): ConversationSummaryItem | null {
  const text = redactDirectIdentifiers(message.content);
  if (!text) return null;
  return {
    text: text.length > max ? `${text.slice(0, max - 1)}…` : text,
    source_message_ids: [message.message_id],
    ...(companyId ? { company_id: companyId } : {}),
    ...(isCorrection ? { is_correction: true } : {}),
  };
}

function appendUnique(
  existing: ConversationSummaryItem[],
  additions: ConversationSummaryItem[],
): ConversationSummaryItem[] {
  const merged = [...existing, ...additions].filter((item, index, all) =>
    all.findIndex((candidate) => candidate.text === item.text) === index,
  );
  return merged.slice(-MAX_ITEMS_PER_FIELD);
}

function isOpenQuestion(content: string): boolean {
  return /[?？]$/.test(content.trim()) || /(어떻게|어디|무엇|왜|가능|되나요|인가요|까요)\s*$/.test(content.trim());
}

function isCorrection(content: string): boolean {
  return /(정정|사실은|다시 말하면|아니라|아니고|잘못 말)/.test(content);
}

function buildSummary(
  previous: ConversationStructuredSummary | null,
  newlySummarized: StoredConversationMessage[],
  companies: string[],
  companyByMessageId: Map<string, string | undefined>,
): ConversationStructuredSummary {
  const base = previous ?? emptySummary();
  const userMessages = newlySummarized.filter((message) => message.role === "user");
  const assistantMessages = newlySummarized.filter((message) => message.role === "assistant");
  const userItems = userMessages
    .map((message) => excerpt(message, 300, companyByMessageId.get(message.message_id), isCorrection(message.content)))
    .filter((item): item is ConversationSummaryItem => Boolean(item));
  const assistantItems = assistantMessages
    .map((message) => excerpt(message, 260, companyByMessageId.get(message.message_id)))
    .filter((item): item is ConversationSummaryItem => Boolean(item));
  const facts = userMessages
    .filter((message) => (!isOpenQuestion(message.content) || /(?:입니다|이고|있습니다|못했다|했다고|겠다고)/.test(message.content))
      && /(?:했|됐|있|없|받|근무|입사|퇴사|계약|월급|임금|체불|급여일|지급)/.test(message.content))
    .map((message) => excerpt(message, 300, companyByMessageId.get(message.message_id), isCorrection(message.content)))
    .filter((item): item is ConversationSummaryItem => Boolean(item));
  const questions = userMessages
    .filter((message) => isOpenQuestion(message.content))
    .map((message) => excerpt(message, 300, companyByMessageId.get(message.message_id), isCorrection(message.content)))
    .filter((item): item is ConversationSummaryItem => Boolean(item));

  return {
    user_goals: appendUnique(base.user_goals, userItems),
    user_stated_facts: appendUnique(base.user_stated_facts, facts),
    // assistant의 답변은 원문으로 남아도, DB·도구가 검증한 사실로 승격하지 않는다.
    system_confirmed_facts: base.system_confirmed_facts,
    actions_already_given: appendUnique(base.actions_already_given, assistantItems),
    open_questions: appendUnique(base.open_questions, questions),
    referenced_company_ids: [...new Set([...base.referenced_company_ids, ...companies])].slice(-8),
    contract_review_summary: null,
  };
}

function allMessages(detail: StoredConversationDetail): StoredConversationMessage[] {
  return detail.turns.flatMap((turn) => turn.messages);
}

/** 완료 메시지 10개 경계에서만 원자적으로 누적 요약을 갱신한다. */
export async function maybeUpdateConversationSummary(
  detail: StoredConversationDetail,
): Promise<boolean> {
  const repository = getConversationRepository();
  const messages = allMessages(detail);
  const target = summaryTargetForMessageCount(messages.length);
  if (target < SUMMARY_BATCH_SIZE) return false;
  const leaseToken = await repository.claimSummary(detail.conversation_id, target);
  if (!leaseToken) return false;
  const heartbeat = setInterval(() => {
    void repository.renewSummary(detail.conversation_id, leaseToken).catch(() => undefined);
  }, 30_000);
  heartbeat.unref();

  try {
    // Read the completed checkpoint AFTER claiming; another worker may have
    // advanced it between our initial detail read and this claim.
    const existing = await repository.findSummary(detail.conversation_id);
    const through = existing?.summarized_through_sequence ?? 0;
    const batch = messages.slice(through, target);
    // 완료 turn만 저장하므로 batch는 항상 user/assistant 짝을 보존한다.
    const summarizedTurns = detail.turns
      .filter((turn) => turn.turn_index * 2 <= target);
    const companies = summarizedTurns
      .filter((turn) => turn.company_id)
      .map((turn) => turn.company_id!);
    const companyByMessageId = new Map<string, string | undefined>(
      summarizedTurns.flatMap((turn) => turn.messages.map((message) => [message.message_id, turn.company_id ?? undefined] as const)),
    );
    const summary = buildSummary(
      existing && existing.summarized_through_sequence > 0
        ? existing.summary
        : null,
      batch,
      companies,
      companyByMessageId,
    );
    // Rebuild the bounded structured slots from retained originals, including legacy
    // checkpoints. This retains corrections/provenance without rewriting history.
    summary.recall_facts = summarizedTurns.flatMap((turn) => turn.messages.flatMap((message, index) =>
      message.role === "user" ? extractRecallFacts({
        content: message.content, source_message_id: message.message_id,
        sequence: (turn.turn_index - 1) * 2 + index + 1, company_id: turn.company_id ?? null,
      }) : [])).slice(-64);
    return await repository.completeSummary({
      conversation_id: detail.conversation_id,
      through_sequence: target,
      summary,
      summary_version: SUMMARY_VERSION,
      lease_token: leaseToken,
    });
  } catch {
    await repository.failSummary(detail.conversation_id, target, "SUMMARY_BUILD_FAILED", leaseToken).catch(() => undefined);
    return false;
  } finally {
    clearInterval(heartbeat);
  }
}

function renderItems(label: string, items: ConversationSummaryItem[]): string[] {
  return items.map((item) => `${item.is_correction ? "사용자 정정" : label}: ${item.text} (원문 ID: ${item.source_message_ids.join(",")}${item.company_id ? `, 회사 ID: ${item.company_id}` : ""})`);
}

/* 모델에는 항목의 출처와 "사용자 진술/기존 안내" 성격을 명시해 사실·근거로 오인하지 않게 한다. */
export function toConversationMemoryContext(
  summary: StoredConversationSummaryState | null,
): ConversationMemoryContext | undefined {
  // A pending/failed attempt may still contain a complete earlier checkpoint.
  // It is safe to use that completed prefix; a brand-new failed attempt has
  // sequence zero and is still excluded.
  if (!summary || summary.summarized_through_sequence < SUMMARY_BATCH_SIZE) return undefined;
  const content = [
    "이 메모리는 현재 상담방의 오래된 원문을 압축한 참고 문맥이다.",
    "사용자 진술은 사실 확인 전제나 현재 법률·회사 근거가 아니며, 새 질문의 근거는 다시 확인한다.",
    ...renderItems("사용자 목표", summary.summary.user_goals),
    ...renderItems("사용자 진술", summary.summary.user_stated_facts),
    ...renderItems("기존 안내", summary.summary.actions_already_given),
    ...renderItems("미해결 질문", summary.summary.open_questions),
    ...(summary.summary.recall_facts ?? []).map((fact) =>
      `사용자 진술 회상: ${fact.kind === "payday" ? "급여일" : "지급 약속"}=${fact.state === "denied" ? "받지 않음" : fact.value ?? "미확인/철회"}, 순서=${fact.sequence}${fact.is_correction ? ", 정정" : ""}, 회사=${fact.company_id ?? "미선택"}`),
    "같은 회사·항목은 뒤의 진술/정정이 현재 값이다. 다른 회사 진술을 현재 회사 사실로 옮기지 않는다.",
    summary.summary.referenced_company_ids.length
      ? `과거 선택 회사 ID: ${summary.summary.referenced_company_ids.join(", ")}`
      : "",
  ].filter(Boolean).join("\n");
  return {
    summary_version: summary.summary_version,
    summarized_through_sequence: summary.summarized_through_sequence,
    content,
  };
}
