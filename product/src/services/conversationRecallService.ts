import type { ChatRequest } from "@/domain/chat";
import type { ChatComparisonResponse, ChatResultProviderId } from "@/domain/chatComparison";
import type { ConversationRecallFact } from "@/domain/conversationRecall";
import { hasCompanyLocationQualifier, mentionedCompanies, recallCompanyLabel, statementCompany, type RecallCompany } from "@/services/conversationCompanyScope";
import { asksNextAction } from "@/services/chatQuestionPurpose";
import { asksUserDocumentStatus, asksWageDocumentUse } from "@/services/chatQuestionPurpose";
import { DOCUMENT_LABELS, DOCUMENT_STATE_LABELS, documentStatusesForRequest } from "@/services/conversationDocumentStatus";

const PAYDAY = /(?:급여일|월급날|(?:급여|월급|임금)\s*지급일)/;
const PROMISE = /(?:지급\s*약속|회사\s*(?:답변|응답)|입금\s*약속)/;
const RECALL = /(?:말한|말했던|말했는지|정정한(?!다)|알려\s*주|기억|회상|다시\s*(?:말|알려|정리)|지금까지|앞서|아까|였나|였죠|였지|정리해)/;
const LEGAL = /(?:법적|법률|신고|진정|신청|청구|문의|어디|어떻게|무엇부터|뭘\s*해야|해야\s*하|할\s*수|가산|계산|위법|투자|주식|추천)/;
const COMPANY_NAME_RECALL = /(?:회사|사업장)\s*(?:이름|명)|어느\s*(?:회사|사업장)|사용한\s*(?:회사|사업장)|연결한\s*(?:회사|사업장)/;
const COMPANY_CONTEXT_RECALL = /(?:앞선|이전|앞서|아까|순서대로|다시|말해|알려)/;
const RESIGNATION = /퇴사일|퇴직일|그만둔\s*날|(?:지난달\s*)?\d{1,2}\s*일에\s*퇴사/;
const WORK_HOURS = /하루\s*\d{1,2}\s*시간|(?:근무|근로)\s*시간/;
const ACCIDENT_LOCATION = /사고\s*장소|다친\s*(?:곳|장소)|(?:어디|어느\s*곳).{0,12}(?:넘어|다쳤)|집\s*계단|(?:일터|작업장).{0,15}(?:넘어|다쳤)/;
const WAGE_BALANCE = /잔액|미지급\s*금액|(?:남은|받은)\s*(?:임금|월급|급여|금액)|나머지|부분\s*입금/;

function needsEvidence(message: string): boolean {
  // Reporting what was said is recall; "어떻게 신고하나" still needs evidence.
  return LEGAL.test(message.replace(/어떻게\s*말했는지/g, "말했는지")) || asksNextAction(message)
    || /카드|공개\s*자료|지표/.test(message);
}

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

function documentAdmissionRecall(request: ChatRequest): { answer: string; found: boolean } | null {
  if (!/계약서/.test(request.message)
    || !/실제\s*말한|말한\s*적|이전\s*답변|앞선\s*답변|추정/.test(request.message)) return null;
  const userStatement = request.recent_messages.filter((item) => item.role === "user")
    .findLast((item) => /계약서/.test(item.content));
  if (!userStatement || !/계약서.{0,25}(?:여부|받았는지|교부.{0,8})(?:.{0,18})(?:말하지\s*않|확인하지\s*않|모르)|계약서\s*교부\s*여부는\s*아직/.test(userStatement.content)) return null;
  const deposit = /(?:월급|급여)\s*입금\s*내역/.test(userStatement.content)
    ? "월급 입금 내역이 있다고 말씀하셨습니다. " : "";
  return { answer: `사용자 진술 기준으로 ${deposit}근로계약서 교부 여부는 아직 말씀하지 않으셨습니다. 이전 답변의 미교부 추정은 사실로 취급하지 않습니다. 계약서를 실제로 받으셨는지 확인해 주세요.`, found: true };
}

function documentStatusRecall(request: ChatRequest, allowMixed = false): { answer: string; found: boolean } | null {
  if (!asksUserDocumentStatus(request.message) && !asksWageDocumentUse(request.message)) return null;
  if (!allowMixed && needsEvidence(request.message)) return null;
  const rows = documentStatusesForRequest(request);
  if (!rows.length) return null;
  const names = [
    ...(/계약서/.test(request.message) ? ["contract", "contract_original", "contract_copy"] : []),
    ...(/통장\s*사본/.test(request.message) ? ["bank_copy"] : []),
    ...(/(?:급여|임금)\s*명세서/.test(request.message) ? ["pay_slip"] : []),
  ];
  const relevant = names.length ? rows.filter((row) => names.includes(row.document)) : rows;
  const lines = relevant.map((row) => `${row.company_name}의 ${DOCUMENT_LABELS[row.document]}: ${DOCUMENT_STATE_LABELS[row.state]}`);
  return { answer: `이 상담에서 사용자가 말한 문서 상태입니다. 서류 자체를 확인한 결과는 아닙니다.\n\n${lines.join("\n")}`,
    found: relevant.some((row) => row.state !== "unstated") };
}

/** Only normalized dates/time phrases leave this extractor, never arbitrary raw text. */
export function extractRecallFacts(input: {
  content: string; source_message_id: string; sequence: number; company_id: string | null;
  companies?: RecallCompany[];
}): ConversationRecallFact[] {
  const facts: ConversationRecallFact[] = [];
  const isCorrection = /정정|수정|아니라|아니고|잘못\s*말/.test(input.content);
  let subjectId = input.company_id;
  let unresolvedSubject = false;
  const add = (kind: ConversationRecallFact["kind"], value: string | null, state?: ConversationRecallFact["state"]) => facts.push({
    kind, value, source_message_id: input.source_message_id, sequence: input.sequence,
    company_id: subjectId, is_correction: isCorrection, ...(state ? { state } : {}),
  });
  // Questions, hypotheticals and recall requests are not new assertions.
  for (const sentence of input.content.match(/[^.!?。？\n]+[.!?。？]?/g) ?? []) {
    if (/(?:만약|가정|라면|이라면|인지|인가요|맞나요|맞는지)/.test(sentence)
      || /(?:동료|친구|다른\s*(?:회사|상담|사람)|예시|답변에서는|챗봇|모델|상담사)/.test(sentence)
      || RECALL.test(sentence)
      || (/[?？]$/.test(sentence) && !/(?:이고|이며|입니다|있습니다|했다고|겠다고)/.test(sentence))) continue;
    const scope = statementCompany(sentence, subjectId, input.companies ?? []);
    if (scope.ambiguous) { unresolvedSubject = true; continue; }
    if (mentionedCompanies(sentence, input.companies ?? []).length === 1) unresolvedSubject = false;
    if (unresolvedSubject) continue;
    subjectId = scope.company_id;
    if (PAYDAY.test(sentence)) {
      const tail = sentence.slice(sentence.search(PAYDAY));
      const corrected = tail.split(/아니라|아니고/).at(-1)!;
      const days = [...corrected.matchAll(/(?:매월\s*)?([12]?\d|3[01])\s*일/g)];
      if (/아닙|아니에요|모르|미정|확실하지/.test(corrected)) add("payday", null);
      else if (days.length === 1 && Number(days[0][1]) > 0) add("payday", `${Number(days[0][1])}일`);
      else if (days.length > 1 || isCorrection) add("payday", null);
    }
    if (RESIGNATION.test(sentence)) {
      const corrected = sentence.split(/아니라|아니고/).at(-1)!;
      const day = corrected.match(/(?:지난달\s*)?(?:[12]?\d|3[01])\s*일/);
      if (day && !/[?？]$/.test(sentence)) {
        const month = /지난달/.test(sentence) ? "지난달 " : "";
        add("resignation_date", `${month}${Number(day[0].match(/\d+/)![0])}일`);
      }
    }
    if (WORK_HOURS.test(sentence)) {
      const corrected = sentence.split(/아니라|아니고|잘못\s*말(?:했습니다|했어요)/).at(-1)!;
      const hours = [...corrected.matchAll(/(?:하루\s*)?(\d{1,2})\s*시간/g)];
      const hour = hours.at(-1);
      if (hour && Number(hour[1]) > 0 && Number(hour[1]) <= 24
        && !/잘못\s*말/.test(corrected)) add("work_hours", `하루 ${Number(hour[1])}시간`);
    }
    if (ACCIDENT_LOCATION.test(sentence) && /넘어|다쳤|사고\s*장소/.test(sentence)) {
      const corrected = sentence.split(/아니라|아니고/).at(-1)!;
      const location = corrected.match(/(?:퇴근\s*뒤\s*)?집\s*계단|(?:회사\s*)?(?:일터|작업장|사업장)/);
      if (location) add("accident_location", location[0].replace(/\s+/g, " "));
    }
    const payment = sentence.match(/(\d{1,7})\s*만\s*원?\s*중\s*(\d{1,7})\s*만\s*원?.{0,24}입금/);
    if (payment && /미지급|못\s*받|나머지|잔액/.test(sentence)) {
      const total = Number(payment[1]);
      const paid = Number(payment[2]);
      if (total > 0 && paid <= total) add("wage_balance",
        `${total}만 원 중 ${paid}만 원 입금, 남은 금액 ${total - paid}만 원`);
    }
    if ((/(?:회사|사장|사업주|대표|문자|약속)/.test(sentence) || mentionedCompanies(sentence, input.companies ?? []).length === 1)
      && /(?:지급|입금|주겠|준다고)/.test(sentence)) {
      if (/(?:취소|철회)/.test(sentence)) {
        add("payment_promise", null);
        continue;
      }
      if (/(?:지급|입금)\s*약속.{0,24}(?:하지\s*않|받지\s*못|없|안\s*했|안\s*받)/.test(sentence)
        || /(?:약속|예정).{0,12}(?:없|받지\s*못)/.test(sentence)) {
        add("payment_promise", null, "denied");
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
  const companies = request.conversation_recall?.companies ?? request.conversation_recall?.company_history ?? [];
  const currentFacts = extractRecallFacts({ content: request.message, source_message_id: "current_request",
    sequence: 0, company_id: request.company_id ?? null, companies });
  const facts = request.conversation_recall?.facts ?? request.recent_messages.flatMap((message, index) =>
    message.role === "user" ? extractRecallFacts({ content: message.content,
      source_message_id: `recent_${index}`, sequence: index + 1, company_id: request.company_id ?? null, companies }) : []);
  const oldDay = request.message.match(/(?:이전|앞서).{0,18}?([12]?\d|3[01])\s*일.{0,24}(?:기준|계산)/)?.[1];
  const explicitDateCompanies = mentionedCompanies(request.message, companies);
  const dateCorrections = oldDay ? (["payday", "resignation_date"] as const).flatMap((kind) =>
    [...new Set(facts.map((fact) => fact.company_id))].flatMap((companyId) => {
      const scoped = facts.filter((fact) => fact.company_id === companyId && fact.kind === kind)
        .toSorted((a, b) => a.sequence - b.sequence);
      const latest = scoped.at(-1);
      return latest?.is_correction && latest.value && scoped.slice(0, -1).some((fact) => fact.value?.endsWith(`${Number(oldDay)}일`))
        && (explicitDateCompanies.length
          ? explicitDateCompanies.some(company => company.company_id === companyId)
          : !request.company_id || request.company_id === companyId) ? [kind] : [];
    })) : [];
  const safeDateFollowup = dateCorrections.length === 1;
  const asksCorrection = /(?:정정|수정|바뀐|최신\s*사실)/.test(request.message);
  const asksBalance = WAGE_BALANCE.test(request.message);
  const asksKnownFact = /(?:퇴사일|퇴직일|그만둔\s*날|근무시간|근로시간|사고\s*장소).{0,16}(?:언제|얼마|어디|무엇|몇)/.test(request.message)
    && !/법적|산재\s*여부|신고|진정|신청|청구|계산/.test(request.message);
  if ((!RECALL.test(request.message) && !asksCorrection && !asksBalance && !asksKnownFact && currentFacts.length === 0)
    || (!PAYDAY.test(request.message) && !PROMISE.test(request.message) && !RESIGNATION.test(request.message)
      && !WORK_HOURS.test(request.message) && !ACCIDENT_LOCATION.test(request.message)
      && !WAGE_BALANCE.test(request.message) && !asksCorrection && !asksBalance && !safeDateFollowup && currentFacts.length === 0)
    || (!allowMixed && needsEvidence(request.message) && !safeDateFollowup && !asksKnownFact)) return null;
  let named = mentionedCompanies(request.message, companies);
  // A short name is usable only within this owner-checked conversation and only
  // when it uniquely identifies a different display name. Same-name firms still
  // require their location as in the company routing boundary.
  if (!named.length && /각각|회사별|구분/.test(request.message)) {
    named = companies.filter((company) => company.company_name.length >= 4
      && request.message.includes(company.company_name.slice(0, 2))
      && companies.filter((other) => other.company_name.startsWith(company.company_name.slice(0, 2))).length === 1);
  }
  if ((named.length === 0 && statementCompany(request.message, request.company_id ?? null, companies).ambiguous)
    || named.some((item, index) => named.some((other, otherIndex) => index !== otherIndex && item.company_name === other.company_name))
      && !named.every((item) => hasCompanyLocationQualifier(request.message, item))) {
    return { answer: "이 상담의 회사별 진술과 질문의 회사 대상을 확실하게 연결하지 못했습니다. 회사 이름과 해당 진술을 함께 알려 주세요.", found: false };
  }
  const selected = named.length ? named
    : /(?:두|각|모든)\s*회사|회사별/.test(request.message) ? companies
    : [{ company_id: request.company_id ?? null, company_name: companies.find((item) => item.company_id === request.company_id)?.company_name }];
  const targets = selected.filter((item, index) => selected.findIndex((candidate) => candidate.company_id === item.company_id) === index);
  const explicitKinds = new Set<ConversationRecallFact["kind"]>([
    ...(PAYDAY.test(request.message) ? ["payday" as const] : []),
    ...(PROMISE.test(request.message) ? ["payment_promise" as const] : []),
    ...(RESIGNATION.test(request.message) ? ["resignation_date" as const] : []),
    ...(WORK_HOURS.test(request.message) ? ["work_hours" as const] : []),
    ...(ACCIDENT_LOCATION.test(request.message) ? ["accident_location" as const] : []),
    ...(WAGE_BALANCE.test(request.message) || asksBalance ? ["wage_balance" as const] : []),
    ...dateCorrections,
    ...currentFacts.map((fact) => fact.kind),
  ]);
  const kinds = explicitKinds.size ? [...explicitKinds]
    : asksCorrection ? [...new Set(facts.filter((fact) => fact.is_correction).map((fact) => fact.kind))] : [];
  const generalCorrection = asksCorrection && explicitKinds.size === 0;
  const labels: Record<ConversationRecallFact["kind"], string> = {
    payday: "급여일", payment_promise: "지급 약속", resignation_date: "퇴사일",
    work_hours: "근무시간", accident_location: "사고 장소", wage_balance: "미지급 잔액",
  };
  const answers = targets.map((target) => {
  const applicable = [...facts.toSorted((a, b) => a.sequence - b.sequence), ...currentFacts]
    .filter((fact) => fact.company_id === target.company_id);
  const parts: string[] = [];
  for (const kind of kinds) {
    const fact = applicable.findLast((item) => item.kind === kind);
    if (generalCorrection && !fact?.is_correction) continue;
    if (kind === "payment_promise" && fact?.state === "denied") {
      parts.push("이 회사로부터 지급 약속을 받지 않았다고 말씀하셨습니다. 이후 새 약속이 생겼는지는 확인되지 않았습니다.");
    } else if (kind === "payment_promise" && fact?.value) {
      parts.push(`회사에서는 ${fact.value}에 지급하겠다고 했습니다. 이는 당시의 표현이며 실제 지급 여부나 확정 날짜를 확인한 것은 아닙니다.`);
    } else if (fact?.value) {
      parts.push(`${labels[kind]}${kind === "accident_location" ? "는" : "은"} ${fact.value}입니다${fact.is_correction ? "(정정된 값)" : ""}.`);
    } else {
      parts.push(kind === "payment_promise"
        ? "현재 문맥에서 회사의 지급 약속을 확인하지 못했습니다."
        : `현재 문맥에서 ${labels[kind]} 진술을 확인하지 못했습니다.`);
    }
  }
  const found = kinds.some((kind) => {
    const fact = applicable.findLast((item) => item.kind === kind);
    return Boolean((!generalCorrection || fact?.is_correction) && (fact?.value || fact?.state === "denied"));
  });
  const company = companies.find(item => item.company_id === target.company_id);
  const label = company ? recallCompanyLabel(company, companies) : target.company_name;
  return { answer: `${label ? `${label}: ` : ""}${parts.join(" ")}`, found };
  });
  const found = answers.some((item) => item.found);
  if (answers.length === 1 && /1\s*번/.test(request.message) && /2\s*번/.test(request.message)
    && /자료|기록|증빙/.test(request.message)) {
    const evidence = kinds.includes("wage_balance") ? "실제 입금 내역과 해당 임금의 약정 금액을 대조하세요."
      : kinds.includes("accident_location") ? "사고 당시 위치와 시간을 확인할 수 있는 기록을 대조하세요."
      : kinds.includes("work_hours") ? "출퇴근·근무 기록과 계약 내용을 대조하세요."
      : "근로계약서에 적힌 날짜와 실제 입금 내역을 대조하세요.";
    return { answer: `이 상담에서 말씀하신 내용 기준입니다.\n\n1. 사실: ${answers[0].answer}\n2. 확인할 자료: ${evidence}${found ? "" : " 해당 사실을 다시 알려 주시면 이어서 정리하겠습니다."}`, found };
  }
  return { answer: `이 상담에서 말씀하신 내용 기준입니다.\n\n${answers.map((item, index) => `${answers.length > 1 ? `${index + 1}. ` : ""}${item.answer}`).join("\n")}${safeDateFollowup ? ` 이전 ${Number(oldDay)}일은 최신 진술의 기준으로 쓰지 않습니다. 실제 날짜와 관련 자료를 대조해야 하며, 이 답변만으로 법정 기한의 달력상 날짜를 확정하지 않습니다.` : ""}${found ? "" : " 해당 내용을 다시 알려 주시면 이어서 정리하겠습니다."}`, found };
}

export function recallResponse(request: ChatRequest, providers: Array<{
  id: ChatResultProviderId; label: string; model: string;
}>): ChatComparisonResponse | null {
  const companyRecall = companyContextRecall(request);
  const fact = recallAnswer(request);
  const document = documentStatusRecall(request);
  const combined = fact && document ? { answer:`${fact.answer}\n\n${document.answer}`, found:fact.found || document.found } : fact ?? document;
  const recall = companyRecall ?? documentAdmissionRecall(request) ?? combined;
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
  const mixedRecall = needsEvidence(request.message) ? recallAnswer(request, true) : null;
  const documentRecall = documentStatusRecall(request, true);
  return { ...response, results: response.results.map((result) => {
    if (result.trace.recall_mode) return result;
    // Even a legal-generation replacement keeps the separately sourced recall.
    // Emergency answers always retain priority and are not prefixed.
    const recall = result.answer_type === "emergency_guidance" ? null : mixedRecall;
    const document = result.answer_type === "emergency_guidance" ? null : documentRecall;
    const prefixes = [recall?.answer, document?.answer].filter(Boolean);
    const answer = prefixes.length ? `${prefixes.join("\n\n")}\n\n추가 질문에 대한 안내: ${result.answer}` : result.answer;
    return { ...result, answer, metrics: { ...result.metrics, answer_chars: answer.length },
      trace: { ...result.trace,
        ...(request.conversation_recall ? { memory: request.conversation_recall.diagnostics } : {}),
        ...(recall ? { recall_mode: recall.found ? "user_statement" as const : "missing_user_statement" as const } : {}),
      },
    };
  }) };
}
