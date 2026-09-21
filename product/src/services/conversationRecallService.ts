import type { ChatRequest } from "@/domain/chat";
import type { ChatComparisonResponse, ChatResultProviderId } from "@/domain/chatComparison";
import type { ConversationRecallFact } from "@/domain/conversationRecall";

const PAYDAY = /(?:급여일|월급날|(?:급여|월급|임금)\s*지급일)/;
const PROMISE = /(?:지급\s*약속|회사\s*(?:답변|응답)|입금\s*약속)/;
const RECALL = /(?:말한|말했던|정정한(?!다)|알려\s*준|기억|회상|다시\s*(?:말|알려|정리)|지금까지|앞서|아까|였나|였죠|였지|정리해)/;
const LEGAL = /(?:법적|법률|신고|진정|신청|청구|문의|어디|어떻게|무엇부터|뭘\s*해야|해야\s*하|할\s*수|가산|계산|위법|투자|주식|추천)/;
const COMPANY_NAME_RECALL = /(?:회사|사업장)\s*(?:이름|명)|어느\s*(?:회사|사업장)|사용한\s*(?:회사|사업장)|연결한\s*(?:회사|사업장)/;
const COMPANY_CONTEXT_RECALL = /(?:앞선|이전|앞서|아까|순서대로|다시|말해|알려)/;

function companyContextRecall(request: ChatRequest): { answer: string; found: boolean } | null {
  if (!COMPANY_CONTEXT_RECALL.test(request.message) || !COMPANY_NAME_RECALL.test(request.message) || LEGAL.test(request.message)) return null;
  const ordered = (request.conversation_recall?.company_history ?? [])
    .toSorted((a, b) => a.turn_index - b.turn_index)
    .reduce<Array<{ company_id: string; company_name: string; turn_index: number }>>((items, item) => {
      if (items.at(-1)?.company_id !== item.company_id) items.push(item);
      return items;
    }, []);
  const requested = /(?:앞선|이전)\s*두|두\s*(?:답변|회사|사업장)/.test(request.message)
    ? ordered.slice(-2)
    : ordered;
  if (requested.length === 0) {
    return { answer: "저장된 앞선 상담에서 사용한 회사 이름을 확인하지 못했습니다.", found: false };
  }
  return {
    answer: `앞선 저장 상담에서 사용한 회사 이름은 순서대로 다음과 같습니다.\n\n${requested.map((item, index) => `${index + 1}. ${item.company_name}`).join("\n")}`,
    found: true,
  };
}

/** Only normalized dates/time phrases leave this extractor, never arbitrary raw text. */
export function extractRecallFacts(input: {
  content: string; source_message_id: string; sequence: number; company_id: string | null;
}): ConversationRecallFact[] {
  const facts: ConversationRecallFact[] = [];
  const isCorrection = /정정|수정|아니라|아니고|잘못\s*말/.test(input.content);
  const add = (kind: ConversationRecallFact["kind"], value: string | null) => facts.push({
    kind, value, source_message_id: input.source_message_id, sequence: input.sequence,
    company_id: input.company_id, is_correction: isCorrection,
  });
  // Questions, hypotheticals and recall requests are not new assertions.
  for (const sentence of input.content.match(/[^.!?。？\n]+[.!?。？]?/g) ?? []) {
    if (/(?:만약|가정|라면|이라면|인지|인가요|맞나요|맞는지)/.test(sentence)
      || /(?:동료|친구|다른\s*(?:회사|상담|사람)|예시|답변에서는|챗봇|모델|상담사)/.test(sentence)
      || RECALL.test(sentence)
      || (/[?？]$/.test(sentence) && !/(?:이고|이며|입니다|있습니다|했다고|겠다고)/.test(sentence))) continue;
    if (PAYDAY.test(sentence)) {
      const tail = sentence.slice(sentence.search(PAYDAY));
      const corrected = tail.split(/아니라|아니고/).at(-1)!;
      const days = [...corrected.matchAll(/(?:매월\s*)?([12]?\d|3[01])\s*일/g)];
      if (/아닙|아니에요|모르|미정|확실하지/.test(corrected)) add("payday", null);
      else if (days.length === 1 && Number(days[0][1]) > 0) add("payday", `${Number(days[0][1])}일`);
      else if (days.length > 1 || isCorrection) add("payday", null);
    }
    if (/(?:회사|사장|사업주|대표|문자|약속)/.test(sentence)
      && /(?:지급|입금|주겠|준다고)/.test(sentence)) {
      if (/(?:취소|철회|약속.*없|지급하지|안\s*(?:주|준|하))/.test(sentence)) {
        add("payment_promise", null);
        continue;
      }
      if (!/(?:겠|한다고|하기로|약속|예정)/.test(sentence)) continue;
      const corrected = sentence.split(/아니라|아니고/).at(-1)!;
      const when = corrected.match(/다다음\s*주|다음\s*주(?:\s*[월화수목금토일]요일)?|이번\s*주\s*[월화수목금토일]요일|내일|모레|(?:\d{1,2}\s*월\s*)?(?:[12]?\d|3[01])\s*일/);
      if (when) add("payment_promise", when[0].replace(/다음\s*주/, "다음 주"));
    }
  }
  return facts;
}

export function recallAnswer(request: ChatRequest, allowMixed = false): { answer: string; found: boolean } | null {
  // A correction is a new user assertion, not a request to repeat the old value.
  // Normalize only supported facts; do not mutate stored history or trust model text.
  const currentFacts = extractRecallFacts({ content: request.message, source_message_id: "current_request",
    sequence: 0, company_id: request.company_id ?? null });
  const correcting = currentFacts.some((fact) => fact.is_correction);
  if ((!RECALL.test(request.message) && !correcting) || (!PAYDAY.test(request.message) && !PROMISE.test(request.message))
    || (!allowMixed && LEGAL.test(request.message))) return null;
  const facts = request.conversation_recall?.facts ?? request.recent_messages.flatMap((message, index) =>
    message.role === "user" ? extractRecallFacts({ content: message.content,
      source_message_id: `recent_${index}`, sequence: index + 1, company_id: request.company_id ?? null }) : []);
  const applicable = [...facts.filter((fact) => fact.company_id === (request.company_id ?? null))
    .toSorted((a, b) => a.sequence - b.sequence), ...currentFacts];
  const payday = applicable.findLast((fact) => fact.kind === "payday");
  const promise = applicable.findLast((fact) => fact.kind === "payment_promise");
  const parts: string[] = [];
  if (PAYDAY.test(request.message)) parts.push(payday?.value
    ? `급여일은 ${payday.value}입니다${payday.is_correction ? "(정정된 값)" : ""}.`
    : "현재 문맥에서 급여일 진술을 확인하지 못했습니다.");
  if (PROMISE.test(request.message)) parts.push(promise?.value
    ? `회사에서는 ${promise.value}에 지급하겠다고 했습니다. 이는 당시의 표현이며 실제 지급 여부나 확정 날짜를 확인한 것은 아닙니다.`
    : "현재 문맥에서 회사의 지급 약속을 확인하지 못했습니다.");
  const found = Boolean((PAYDAY.test(request.message) && payday?.value) || (PROMISE.test(request.message) && promise?.value));
  return { answer: `이 상담에서 말씀하신 내용 기준입니다. ${parts.join(" ")}${found ? "" : " 해당 내용을 다시 알려 주시면 이어서 정리하겠습니다."}`, found };
}

export function recallResponse(request: ChatRequest, providers: Array<{
  id: ChatResultProviderId; label: string; model: string;
}>): ChatComparisonResponse | null {
  const companyRecall = companyContextRecall(request);
  const recall = companyRecall ?? recallAnswer(request);
  if (!recall) return null;
  const now = new Date().toISOString();
  return {
    comparison_id: `cmp_${crypto.randomUUID()}`, conversation_id: request.conversation_id ?? `guest_${crypto.randomUUID()}`,
    execution_mode: "policy_short_circuit", started_at: now, completed_at: now,
    fair_comparison: { concurrent: false, same_context: true, same_temperature: false, same_max_tokens: false, same_retrieval: true },
    results: providers.map((provider) => ({
      provider: provider.id, provider_label: provider.label, model: provider.model,
      status: "policy_short_circuit", answer: recall.answer, answer_type: "general_guidance",
      sources: [], suggested_actions: [], limitations: [companyRecall
        ? "저장된 상담 턴의 공개 회사 표시명을 회상한 것이며 현재 회사 상태나 법률 사실을 검증한 답변은 아닙니다."
        : "사용자 진술을 회상한 것이며 회사·법률 사실을 검증한 답변은 아닙니다."],
      guardrail_status: recall.found ? "passed" : "limited",
      metrics: { latency_ms: 0, time_to_first_token_ms: null, streaming: false, finish_reason: null,
        answer_chars: recall.answer.length, usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_tokens: null, reasoning_tokens: null } },
      trace: { prompt_policy_version: "conversation-recall-v1", query_transform: "none", context_mode: request.company_id ? "company" : "general",
        company_context_attached: false, recent_message_count: request.recent_messages.length,
        guardrail_action: "short_circuit", guardrail_hits: [], upstream_request_id: null,
        rag_status: "no_match", rag_reason: "conversation_recall_no_retrieval", rag_topic: null, retrieved_document_count: 0,
        recall_mode: companyRecall && recall.found ? "conversation_context"
          : recall.found ? "user_statement" : "missing_user_statement",
        ...(request.conversation_recall ? { memory: request.conversation_recall.diagnostics } : {}),
      },
    })),
  };
}

export function finalizeConversationResponse(request: ChatRequest, response: ChatComparisonResponse): ChatComparisonResponse {
  const mixedRecall = LEGAL.test(request.message) ? recallAnswer(request, true) : null;
  return { ...response, results: response.results.map((result) => {
    // Even a legal-generation replacement keeps the separately sourced recall.
    // Emergency answers always retain priority and are not prefixed.
    const recall = result.answer_type === "emergency_guidance" ? null : mixedRecall;
    const answer = recall ? `${recall.answer}\n\n추가 질문에 대한 안내: ${result.answer}` : result.answer;
    return { ...result, answer, metrics: { ...result.metrics, answer_chars: answer.length },
      trace: { ...result.trace,
        ...(request.conversation_recall ? { memory: request.conversation_recall.diagnostics } : {}),
        ...(recall ? { recall_mode: recall.found ? "user_statement" as const : "missing_user_statement" as const } : {}),
      },
    };
  }) };
}
