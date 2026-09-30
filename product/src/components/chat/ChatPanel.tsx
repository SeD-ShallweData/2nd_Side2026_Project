"use client";

import Image from "next/image";
import Link from "next/link";
import { ChangeEvent, FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { DataSourceList } from "@/components/common/DataSourceList";
import { SafeMarkdown } from "@/components/common/SafeMarkdown";
import type { ChatMode, RecentMessage } from "@/domain/chat";
import type {
  ConversationDetailDto,
  ImportGuestConversationResponse,
  ConversationListResponse,
  ConversationSummaryDto,
} from "@/app/api/conversations/conversationApiContract";
import type {
  ChatComparisonResponse,
  ConfiguredChatExecutionMode,
  LlmProviderId,
  ProviderComparisonResult,
} from "@/domain/chatComparison";
import { executionModeCopy, providerRunStatusLabel } from "@/components/chat/runLabels";
import { format } from "@/i18n/defineMessages";
import { useLocale, useMessages } from "@/i18n/LocaleProvider";
import type { Locale } from "@/i18n/locales";
import { chatMessages, type ChatMessages } from "@/i18n/messages/chat";
import { languageMessages } from "@/i18n/messages/language";
import type { FavoriteCompanyDto } from "@/app/api/users/me/favorites/favoriteApiContract";
import {
  CONTRACT_REVIEW_CONTEXT_STORAGE_KEY,
  CONTRACT_REVIEW_CONTEXT_TTL_MS,
  contractReviewCounts,
  parseContractReviewContext,
  type ContractReviewContext,
} from "@/domain/contractReviewContext";
import { getSession } from "@/services/authClient";
import { getFavorites } from "@/services/favoriteClient";
import { readApiResponse } from "@/utils/clientApi";
import { publicClientHeaders } from "@/utils/publicClientId";
import { publicAnswerText } from "@/services/publicAnswerContext";
import {
  appendGuestConversationTurn,
  clearGuestConversation,
  readGuestConversation,
} from "@/services/guestConversationClient";

// 추천 질문과 가이드 문구는 사전(chatMessages)에 있다. 여기서는 순서만 정한다.
type QuestionKey = keyof ChatMessages["questions"];

const COMPANY_QUESTIONS: readonly QuestionKey[] = ["whyReview", "beforeJoining", "unpaidWage", "injuryClaim", "isSafe"];

const GENERAL_QUESTIONS: readonly QuestionKey[] = ["unpaidWage", "injuryClaim", "contractCheck", "isSafe"];

const GUIDE_GROUPS = [
  { key: "beforeJoining", items: ["wageTerms", "contractItems"] },
  { key: "trouble", items: ["unpaidWage", "dismissal", "annualLeave"] },
] as const;

const CONTRACT_FILE_TYPES = ["application/pdf", "image/png", "image/jpeg"];
const MAX_CONTRACT_FILE_SIZE = 10 * 1024 * 1024;

interface UiMessage {
  id: string;
  requestId?: string;
  role: "user" | "assistant";
  content: string;
  comparison?: ChatComparisonResponse;
  sources?: import("@/domain/risk").SourceReference[];
  companyId?: string | null;
  companyName?: string | null;
  /** 환영 메시지는 화면 언어로 그때그때 그린다. */
  welcome?: { company?: string };
}

function welcomeContent(
  company: string | undefined,
  executionMode: ConfiguredChatExecutionMode,
  m: ChatMessages,
): string {
  if (company) {
    return format(executionMode === "dual_api" ? m.welcome.companyDual : m.welcome.companyTools, { company });
  }
  return executionMode === "dual_api" ? m.welcome.generalDual : m.welcome.generalTools;
}

function welcomeMessage(company: string | undefined): UiMessage {
  return { id: "welcome", role: "assistant", content: "", welcome: { company } };
}

/** 숫자·시간 표기용 BCP 47 태그. 쉬운 한국어도 한국어 표기를 쓴다. */
function intlLocale(locale: Locale): string {
  switch (locale) {
    case "en": return "en-US";
    case "zh": return "zh-CN";
    case "vi": return "vi-VN";
    case "th": return "th-TH";
    default: return "ko-KR";
  }
}

function metric(value: number | null, m: ChatMessages, locale: Locale, suffix = ""): string {
  return value === null ? m.trace.notProvided : `${value.toLocaleString(intlLocale(locale))}${suffix}`;
}

function comparisonHistoryContent(
  comparison: ChatComparisonResponse,
  selection?: LlmProviderId | "tie",
): string {
  const selected = selection && selection !== "tie"
    ? comparison.results.filter((result) => result.provider === selection)
    : comparison.results;
  return selected
    .map((result) => publicAnswerText(result.answer).slice(0, 900))
    .join("\n");
}

function isLegacyProvider(
  result: ProviderComparisonResult,
): result is ProviderComparisonResult & { provider: LlmProviderId } {
  return result.provider === "upstage" || result.provider === "skt";
}

function ProviderAnswerCard({ result }: { result: ProviderComparisonResult }) {
  const m = useMessages(chatMessages);
  const locale = useLocale();
  const t = m.trace;
  const statusLabel = providerRunStatusLabel(result.status, result.trace.guardrail_hits, result.trace.recall_mode, m.run);

  return (
    <article className={`provider-answer provider-answer-${result.provider}`}>
      <header className="provider-answer-head">
        <div>
          <span className={`provider-dot provider-dot-${result.provider}`} aria-hidden="true" />
          <strong>{result.provider_label}</strong>
          <small>{result.model}</small>
        </div>
        <span className={`provider-run-status provider-run-${result.status}`}>{statusLabel}</span>
      </header>

      {result.error ? (
        <div className="provider-error" role="status">
          <strong>{result.error.code}</strong>
          <span>{result.error.message}</span>
        </div>
      ) : null}

      <div className="provider-answer-copy"><SafeMarkdown>{publicAnswerText(result.answer)}</SafeMarkdown></div>

      <section className="provider-evidence" aria-label={format(m.card.evidenceAria, { provider: result.provider_label })}>
        <div>
          <strong>{m.card.officialSources}</strong>
          <DataSourceList sources={result.sources} />
        </div>
        <div>
          <strong>{m.card.limitations}</strong>
          {result.limitations.length > 0 ? (
            <ul>{result.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
          ) : <p className="muted-text">{m.card.noLimitations}</p>}
        </div>
      </section>

      <details className="provider-trace">
        <summary>{t.summary}</summary>
        <dl>
          <div><dt>{t.latency}</dt><dd>{metric(result.metrics.latency_ms, m, locale, "ms")}</dd></div>
          <div><dt>{t.totalTokens}</dt><dd>{metric(result.metrics.usage.total_tokens, m, locale)}</dd></div>
          <div><dt>{t.answerLength}</dt><dd>{metric(result.metrics.answer_chars, m, locale, t.charsSuffix)}</dd></div>
          <div><dt>{t.runStatus}</dt><dd>{statusLabel}</dd></div>
          <div><dt>{t.context}</dt><dd>{result.trace.context_mode === "company" ? t.contextCompany : t.contextGeneral}</dd></div>
          <div><dt>{t.queryRewrite}</dt><dd>{result.trace.query_transform === "none" ? t.notUsed : t.queryRewriteStandalone}</dd></div>
          <div><dt>{t.recentMessages}</dt><dd>{format(t.recentMessagesValue, { count: result.trace.recent_message_count })}</dd></div>
          <div><dt>{t.ragSearch}</dt><dd>{result.trace.rag_status}</dd></div>
          <div><dt>{t.ragReason}</dt><dd>{result.trace.rag_reason ?? t.ragReasonDefault}</dd></div>
          <div><dt>{t.ragTopic}</dt><dd>{result.trace.rag_topic ?? t.ragTopicNone}</dd></div>
          <div><dt>{t.sharedSources}</dt><dd>{format(t.countValue, { count: result.trace.retrieved_document_count })}</dd></div>
          {result.trace.tool_round_count !== undefined ? <div><dt>{t.toolRounds}</dt><dd>{format(t.timesValue, { count: result.trace.tool_round_count })}</dd></div> : null}
          {result.trace.tool_call_count !== undefined ? <div><dt>{t.toolCalls}</dt><dd>{format(t.timesValue, { count: result.trace.tool_call_count })}</dd></div> : null}
          {result.trace.tool_names ? <div><dt>{t.toolNames}</dt><dd>{result.trace.tool_names.join(", ") || t.notUsed}</dd></div> : null}
          <div><dt>{t.policyVersion}</dt><dd>{result.trace.prompt_policy_version}</dd></div>
          <div><dt>{t.guardrail}</dt><dd>{result.trace.guardrail_action}</dd></div>
          <div><dt>{t.guardrailRules}</dt><dd>{result.trace.guardrail_hits.join(", ") || t.guardrailNone}</dd></div>
          <div><dt>{t.finishReason}</dt><dd>{result.metrics.finish_reason || t.notProvided}</dd></div>
          <div><dt>{t.promptTokens}</dt><dd>{metric(result.metrics.usage.prompt_tokens, m, locale)}</dd></div>
          <div><dt>{t.completionTokens}</dt><dd>{metric(result.metrics.usage.completion_tokens, m, locale)}</dd></div>
          <div><dt>{t.cachedTokens}</dt><dd>{metric(result.metrics.usage.cached_tokens, m, locale)}</dd></div>
          <div><dt>{t.reasoningTokens}</dt><dd>{metric(result.metrics.usage.reasoning_tokens, m, locale)}</dd></div>
          <div><dt>{t.firstToken}</dt><dd>{t.firstTokenValue}</dd></div>
          <div><dt>{t.upstreamRequestId}</dt><dd>{result.trace.upstream_request_id || t.notProvided}</dd></div>
        </dl>
        <p className="trace-security-note">{t.securityNote}</p>
      </details>

      {result.suggested_actions.length > 0 ? (
        <div className="provider-actions">
          <strong>{m.card.nextActions}</strong>
          <ul>
            {result.suggested_actions.map((action) => (
              <li key={action.code}>
                <span>{action.priority === "now" ? m.card.priorityNow : action.priority === "next" ? m.card.priorityNext : m.card.priorityOptional}</span>
                <div><strong>{action.label}</strong>{action.description ? <p>{action.description}</p> : null}</div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

    </article>
  );
}

function ComparisonBlock({
  comparison,
  selected,
  onSelect,
}: {
  comparison: ChatComparisonResponse;
  selected?: LlmProviderId | "tie";
  onSelect: (selection: LlmProviderId | "tie") => void;
}) {
  const m = useMessages(chatMessages);
  const locale = useLocale();
  const c = m.comparison;
  const retrieval = comparison.results[0]?.trace;
  const ragToolCalled = retrieval?.tool_names?.includes("retrieve_labor_law") ?? false;
  const ragLabel = !retrieval
    ? c.ragUnknown
    : comparison.execution_mode === "policy_short_circuit" && retrieval.recall_mode
      ? c.ragRecall
    : comparison.execution_mode === "openai_responses" && !ragToolCalled
      ? c.ragToolUnused
    : retrieval.rag_status === "matched"
      ? format(c.ragMatched, { count: retrieval.retrieved_document_count })
      : retrieval.rag_status === "no_match"
        ? retrieval.rag_reason === "out_of_scope" && retrieval.rag_topic
          ? format(c.ragOutOfScope, { topic: retrieval.rag_topic })
          : c.ragNoMatch
        : comparison.execution_mode === "policy_short_circuit"
          ? c.ragEmergency
          : c.ragDisconnected;
  const modeCopy = executionModeCopy(comparison.execution_mode, retrieval?.guardrail_hits, retrieval?.recall_mode, m.run);
  const feedbackResults = comparison.execution_mode === "dual_api"
    ? comparison.results.filter(isLegacyProvider)
    : [];
  const showFeedback = feedbackResults.length >= 2;

  return (
    <div className="comparison-block">
      <div className="comparison-summary">
        <div>
          <span className="comparison-kicker">{modeCopy.kicker}</span>
          <strong>{modeCopy.summary}</strong>
          <span className={`rag-status rag-status-${retrieval?.rag_status ?? "unavailable"}`}>{ragLabel}</span>
        </div>
        <span>{new Date(comparison.completed_at).toLocaleTimeString(intlLocale(locale))}</span>
      </div>
      <div className={`provider-answer-grid${comparison.results.length === 1 ? " provider-answer-grid-single" : ""}`}>
        {comparison.results.map((result) => <ProviderAnswerCard key={result.provider} result={result} />)}
      </div>
      {showFeedback ? <div className="comparison-feedback">
        <div>
          <strong>{c.feedbackQuestion}</strong>
          <span>{c.feedbackNote}</span>
        </div>
        <div className="feedback-buttons">
          {feedbackResults.map((result) => (
            <button
              type="button"
              key={result.provider}
              className={selected === result.provider ? "selected" : ""}
              onClick={() => onSelect(result.provider)}
            >
              {format(c.feedbackPrefer, { provider: result.provider_label })}
            </button>
          ))}
          <button type="button" className={selected === "tie" ? "selected" : ""} onClick={() => onSelect("tie")}>
            {c.feedbackTie}
          </button>
        </div>
        {selected ? <p role="status">{c.feedbackSaved}</p> : null}
      </div> : null}
    </div>
  );
}

export function ChatPanel({
  companyId,
  companyName,
  suggestedPrompt,
  chatMode = "general",
  executionMode = "dual_api",
  contractReviewRequested = false,
}: {
  companyId?: string;
  companyName?: string;
  suggestedPrompt?: string;
  chatMode?: ChatMode;
  executionMode?: ConfiguredChatExecutionMode;
  /** 계약서 진단 화면의 "AI 상담으로 이어가기"로 들어온 경우 true. */
  contractReviewRequested?: boolean;
}) {
  const m = useMessages(chatMessages);
  const lm = useMessages(languageMessages);
  const locale = useLocale();
  const n = m.notice;
  const inputId = useId();
  const voiceInputTipId = useId();
  const voiceReadTipId = useId();
  const contractFileInputId = useId();
  const contractFileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(suggestedPrompt ?? "");
  const [messages, setMessages] = useState<UiMessage[]>([welcomeMessage(companyName)]);
  const [conversationId, setConversationId] = useState<string>();
  const [conversationTitle, setConversationTitle] = useState<string>();
  const [activeCompanyId, setActiveCompanyId] = useState(companyId);
  const [activeCompanyName, setActiveCompanyName] = useState(companyName);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contractFile, setContractFile] = useState<File | null>(null);
  const [feedback, setFeedback] = useState<Record<string, LlmProviderId | "tie">>({});
  const [compare, setCompare] = useState(false);
  const [externalProcessingConsent, setExternalProcessingConsent] = useState(false);
  const [conversationHistory, setConversationHistory] = useState<ConversationSummaryDto[]>([]);
  const [historyAvailable, setHistoryAvailable] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [persistenceNotice, setPersistenceNotice] = useState<string | null>(null);
  const [guestImportAvailable, setGuestImportAvailable] = useState(false);
  const [favoriteCompanies, setFavoriteCompanies] = useState<FavoriteCompanyDto[]>([]);
  const [contractReview, setContractReview] = useState<ContractReviewContext | null>(null);

  const refreshConversationHistory = useCallback(async () => {
    const response = await fetch("/api/conversations?limit=20", { cache: "no-store" });
    if (response.status === 401) {
      setHistoryAvailable(false);
      setConversationHistory([]);
      return;
    }
    if (!response.ok) throw new Error(n.historyLoadFailed);
    const data = await readApiResponse<ConversationListResponse>(response);
    setHistoryAvailable(true);
    setConversationHistory(data.items);
  }, [n.historyLoadFailed]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, loading]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshConversationHistory().catch(() => {
        // 현재 상담 자체는 계속 가능하다. 저장소 장애는 답변 뒤 상태로만 알린다.
        setHistoryAvailable(false);
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshConversationHistory]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setGuestImportAvailable(readGuestConversation() !== null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  // 계약서 진단 결과 요약은 이 탭의 sessionStorage 에서만 읽는다. 오래됐거나 형식이
  // 맞지 않으면 연결하지 않는다. 서버도 같은 검사를 다시 한다.
  useEffect(() => {
    if (chatMode !== "contract" || !contractReviewRequested) return;
    const timer = window.setTimeout(() => {
      try {
        const raw = window.sessionStorage.getItem(CONTRACT_REVIEW_CONTEXT_STORAGE_KEY);
        const stored = raw ? (JSON.parse(raw) as { saved_at?: unknown; context?: unknown }) : null;
        const fresh = typeof stored?.saved_at === "number" && Date.now() - stored.saved_at < CONTRACT_REVIEW_CONTEXT_TTL_MS;
        setContractReview(fresh ? parseContractReviewContext(stored?.context) ?? null : null);
      } catch {
        setContractReview(null);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [chatMode, contractReviewRequested]);

  function detachContractReview() {
    setContractReview(null);
    try {
      window.sessionStorage.removeItem(CONTRACT_REVIEW_CONTEXT_STORAGE_KEY);
    } catch {
      // 저장소를 못 써도 이번 화면에서는 연결이 해제된다.
    }
  }

  // 관심 사업장은 챗봇이 자동으로 읽지 않는다. 일반 사용자에게 목록을 보여 주고,
  // 사용자가 고른 한 곳만 기존 company_id 경로로 상담에 연결한다.
  useEffect(() => {
    const controller = new AbortController();
    getSession({ signal: controller.signal })
      .then((session) => {
        if (!session.authenticated || session.user.role !== "user") return;
        return getFavorites({ signal: controller.signal }).then((favorites) => {
          if (!controller.signal.aborted) setFavoriteCompanies(favorites.items);
        });
      })
      .catch(() => {
        // 관심 사업장 목록은 보조 기능이다. 불러오지 못해도 상담은 그대로 쓴다.
      });
    return () => controller.abort();
  }, []);

  async function sendMessage(value: string, retryRequestId?: string) {
    const message = value.trim();
    if (!message || loading) return;
    if (!externalProcessingConsent) {
      setError(n.consentRequired);
      return;
    }
    const submittedContractFile = contractFile;
    const requestedComparison = executionMode === "dual_api" && compare;
    const requestId = retryRequestId ?? crypto.randomUUID();

    const recentMessages: RecentMessage[] = messages
      .filter((item) => item.id !== "welcome")
      .slice(-8)
      .map((item) => ({
        role: item.role,
        content: item.comparison
          ? comparisonHistoryContent(item.comparison, feedback[item.comparison.comparison_id])
          : item.content,
      }));
    setMessages((current) => [...current, {
      id: crypto.randomUUID(), requestId, role: "user", content: message, companyId: activeCompanyId ?? null, companyName: activeCompanyName ?? null,
    }]);
    setDraft("");
    setError(null);
    setLoading(true);

    try {
      const requestInit: RequestInit = { method: "POST", headers: publicClientHeaders() };
      if (
        executionMode === "openai_responses" &&
        chatMode === "contract" &&
        submittedContractFile
      ) {
        const form = new FormData();
        form.append("file", submittedContractFile, submittedContractFile.name);
        form.append("message", message);
        form.append("request_id", requestId);
        form.append("chat_mode", chatMode);
        form.append("ui_locale", locale);
        form.append("recent_messages", JSON.stringify(recentMessages));
        form.append("external_processing_consent", "true");
        if (conversationId) form.append("conversation_id", conversationId);
        if (activeCompanyId) form.append("company_id", activeCompanyId);
        requestInit.body = form;
      } else {
        requestInit.headers = { ...publicClientHeaders(), "Content-Type": "application/json" };
        requestInit.body = JSON.stringify({
          message,
          request_id: requestId,
          conversation_id: conversationId,
          company_id: activeCompanyId,
          compare: requestedComparison,
          external_processing_consent: true,
          external_compare_consent: requestedComparison,
          chat_mode: chatMode,
          ui_locale: locale,
          recent_messages: recentMessages,
          ...(chatMode === "contract" && contractReview ? { contract_review: contractReview } : {}),
        });
      }
      const response = await fetch("/api/chat", requestInit);
      const data = await readApiResponse<ChatComparisonResponse>(response);
      if (data.conversation_persistence !== "guest") setConversationId(data.conversation_id);
      if (data.conversation_persistence === "saved") {
        setPersistenceNotice(n.saved);
        void refreshConversationHistory().catch(() => setHistoryAvailable(false));
      } else if (data.conversation_persistence === "unavailable") {
        setHistoryAvailable(false);
        setError(n.storageUnavailable);
        setPersistenceNotice(n.saveFailedRetry);
      } else if (data.conversation_persistence === "guest") {
        appendGuestConversationTurn(message, activeCompanyId ?? null, data);
        setGuestImportAvailable(true);
        setPersistenceNotice(n.guestTemporary);
      }
      const completedContractReview = data.results.some(
        (result) =>
          result.status === "success" &&
          result.trace.tool_names?.includes("review_contract"),
      );
      if (completedContractReview && submittedContractFile) {
        setContractFile((current) =>
          current === submittedContractFile ? null : current,
        );
        if (contractFileInputRef.current?.files?.[0] === submittedContractFile) {
          contractFileInputRef.current.value = "";
        }
      }
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "assistant", content: "상담 결과", comparison: data },
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : n.answerLoadFailed);
    } finally {
      if (requestedComparison) setCompare(false);
      setLoading(false);
    }
  }

  async function saveFeedback(comparison: ChatComparisonResponse, selection: LlmProviderId | "tie") {
    setFeedback((current) => ({ ...current, [comparison.comparison_id]: selection }));
    try {
      const response = await fetch("/api/chat/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          comparison_id: comparison.comparison_id,
          selection,
          result_metrics: comparison.results.filter(isLegacyProvider).map((result) => ({
            provider: result.provider,
            model: result.model,
            status: result.status,
            latency_ms: result.metrics.latency_ms,
            total_tokens: result.metrics.usage.total_tokens,
            guardrail_action: result.trace.guardrail_action,
          })),
        }),
      });
      if (!response.ok) throw new Error("feedback save failed");
    } catch {
      setError(n.feedbackLogFailed);
    }
  }

  async function restoreConversation(nextConversationId: string) {
    if (loading || nextConversationId === conversationId) return;
    setHistoryLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(nextConversationId)}`, {
        cache: "no-store",
      });
      const detail = await readApiResponse<ConversationDetailDto>(response);
      setConversationId(detail.conversation_id);
      setConversationTitle(detail.title);
      setActiveCompanyId(detail.active_company_id ?? undefined);
      const restoredCompanyName = detail.active_company_id === companyId
        ? companyName
        : detail.active_company_name ?? undefined;
      setActiveCompanyName(restoredCompanyName);
      setMessages([
        welcomeMessage(restoredCompanyName),
        ...detail.turns.flatMap((turn) => turn.messages.map((message) => message.role === "assistant" && turn.response
          ? { id: `${turn.turn_id}-assistant`, role: "assistant" as const, content: "상담 결과", comparison: turn.response }
          : {
              id: `${turn.turn_id}-${message.role}`,
              role: message.role,
              content: message.content,
              companyId: turn.company_id,
              companyName: turn.company_name,
              ...(message.role === "assistant" ? { sources: turn.sources } : {}),
            })),
      ]);
      setPersistenceNotice(n.restored);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : n.historyLoadFailed);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function deleteConversation(conversation: ConversationSummaryDto) {
    if (loading) return;
    setHistoryLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversation.conversation_id)}`, {
        method: "DELETE",
      });
      await readApiResponse(response);
      if (conversation.conversation_id === conversationId) {
        setConversationId(undefined);
        setConversationTitle(undefined);
        setActiveCompanyId(companyId);
        setActiveCompanyName(companyName);
        setMessages((current) => current.slice(0, 1));
      }
      await refreshConversationHistory();
      setPersistenceNotice(n.deleted);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : n.historyDeleteFailed);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function updateConversationMetadata(patch: { title?: string; active_company_id?: string | null }) {
    if (!conversationId || loading) return;
    setHistoryLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const updated = await readApiResponse<ConversationSummaryDto>(response);
      setConversationTitle(updated.title);
      setActiveCompanyId(updated.active_company_id ?? undefined);
      setActiveCompanyName(updated.active_company_id === companyId ? companyName : undefined);
      setMessages((current) => current.map((message) => message.id === "welcome"
        ? welcomeMessage(updated.active_company_id === companyId ? companyName : updated.active_company_id ?? undefined)
        : message));
      await refreshConversationHistory();
      setPersistenceNotice(patch.title !== undefined ? n.titleUpdated : updated.active_company_id ? n.companyChanged : n.companyCleared);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : n.metadataUpdateFailed);
    } finally {
      setHistoryLoading(false);
    }
  }

  function editConversationTitle() {
    if (!conversationId) return;
    const title = window.prompt(n.titlePrompt, conversationTitle ?? "");
    if (title !== null && title.trim()) void updateConversationMetadata({ title });
  }

  async function importCurrentGuestConversation() {
    const guest = readGuestConversation();
    if (!guest || loading) return;
    setHistoryLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/conversations/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(guest),
      });
      const imported = await readApiResponse<ImportGuestConversationResponse>(response);
      clearGuestConversation();
      setGuestImportAvailable(false);
      await refreshConversationHistory();
      await restoreConversation(imported.conversation_id);
      setPersistenceNotice(imported.reused ? n.guestReimported : n.guestImported);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : n.guestImportFailed);
    } finally {
      setHistoryLoading(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(draft);
  }

  function handleContractFile(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0] ?? null;
    setError(null);
    if (!next) {
      setContractFile(null);
      return;
    }
    if (!CONTRACT_FILE_TYPES.includes(next.type)) {
      setContractFile(null);
      setError(n.fileTypeInvalid);
      event.target.value = "";
      return;
    }
    if (next.size > MAX_CONTRACT_FILE_SIZE) {
      setContractFile(null);
      setError(n.fileTooLarge);
      event.target.value = "";
      return;
    }
    setContractFile(next);
  }

  const questions = (activeCompanyId ? COMPANY_QUESTIONS : GENERAL_QUESTIONS).map((key) => m.questions[key]);
  const activeCompanyLabel = activeCompanyName ?? (activeCompanyId ? m.topbar.selectedCompanyFallback : undefined);
  const reviewCounts = contractReview ? contractReviewCounts(contractReview) : null;

  return (
    <div className="chat-experience-layout">
      <div className="chat-panel comparison-chat-panel">
      <div className="chat-topbar">
        <div><span className="online-dot" aria-hidden="true" /><strong>{executionMode === "dual_api" ? compare ? m.topbar.dualCompare : m.topbar.dualSingle : m.topbar.tools}</strong></div>
        <span>{activeCompanyLabel ? format(m.topbar.companyConnected, { company: activeCompanyLabel }) : chatMode === "contract" ? contractReview ? m.topbar.contractLinked : m.topbar.contractFollowup : m.topbar.general}</span>
      </div>

      <div className="chat-body comparison-chat-body" aria-live="polite" aria-busy={loading}>
        {messages.map((message) => (
          message.comparison ? (
            <ComparisonBlock
              key={message.id}
              comparison={message.comparison}
              selected={feedback[message.comparison.comparison_id]}
              onSelect={(selection) => void saveFeedback(message.comparison!, selection)}
            />
          ) : (
            <div className={`chat-row chat-row-${message.role}`} key={message.id}>
              {message.role === "assistant" ? <Image className="chat-avatar" src="/brand/donworry-avatar.png" alt="" width={192} height={192} /> : null}
              {message.role === "user" ? (
                <div className="user-message-wrap">
                  <button type="button" className="message-retry" onClick={() => void sendMessage(message.content, message.requestId)} disabled={loading} aria-label={format(m.thread.retryAria, { question: message.content })}>
                    <span aria-hidden="true">↻</span> {m.thread.retry}
                  </button>
                  <div className="chat-message chat-message-user"><p>{message.content}</p></div>
                  {message.companyId ? <small className="turn-company-label">{format(m.thread.turnCompany, { company: message.companyName ?? m.thread.turnCompanyFallback })}</small> : null}
                </div>
              ) : <div className="chat-message chat-message-assistant"><p>{message.welcome ? welcomeContent(message.welcome.company, executionMode, m) : message.content}</p>{message.sources?.length ? <DataSourceList sources={message.sources} /> : null}</div>}
            </div>
          )
        ))}
        {loading ? executionMode === "dual_api" && compare ? (
          <div className="dual-loading" role="status">
            <strong>{m.loading.dualCompareTitle}</strong>
            <div>
              <span><i className="provider-dot provider-dot-upstage" />{m.loading.upstageWaiting}</span>
              <span><i className="provider-dot provider-dot-skt" />{m.loading.sktWaiting}</span>
            </div>
            <small>{m.loading.dualCompareNote}</small>
          </div>
        ) : executionMode === "dual_api" ? (
          <div className="dual-loading" role="status">
            <strong>{m.loading.dualSingleTitle}</strong>
            <div>
              <span><i className="provider-dot provider-dot-upstage" />{m.loading.upstageWaiting}</span>
            </div>
            <small>{m.loading.dualSingleNote}</small>
          </div>
        ) : (
          <div className="dual-loading" role="status">
            <strong>{m.loading.toolsTitle}</strong>
            <div>
              <span><i className="provider-dot provider-dot-openai" />{m.loading.openaiWaiting}</span>
            </div>
            <small>{m.loading.toolsNote}</small>
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>

      <div className="question-chips" aria-label={m.chipsAria}>
        {questions.map((question) => (
          <button key={question} type="button" onClick={() => void sendMessage(question)} disabled={loading}>{question}</button>
        ))}
      </div>

      {historyAvailable ? (
        <section className="chat-history" aria-label={m.history.title}>
          <div><strong>{m.history.title}</strong><small>{m.history.retention}</small></div>
          {conversationHistory.length ? <ul>
            {conversationHistory.map((conversation) => <li key={conversation.conversation_id}>
              <button type="button" disabled={historyLoading || loading} onClick={() => void restoreConversation(conversation.conversation_id)}>
                {conversation.title}
              </button>
              <button type="button" disabled={historyLoading || loading} onClick={() => void deleteConversation(conversation)} aria-label={format(m.history.deleteAria, { title: conversation.title })}>{m.history.delete}</button>
            </li>)}
          </ul> : <p className="muted-text">{m.history.empty}</p>}
          {conversationId ? <div className="conversation-controls">
            <button type="button" disabled={historyLoading || loading} onClick={editConversationTitle}>{m.history.editTitle}</button>
            {companyId && companyId !== activeCompanyId ? <button type="button" disabled={historyLoading || loading} onClick={() => void updateConversationMetadata({ active_company_id: companyId })}>{m.history.useCurrentCompany}</button> : null}
            {activeCompanyId ? <button type="button" disabled={historyLoading || loading} onClick={() => void updateConversationMetadata({ active_company_id: null })}>{m.history.detachCompany}</button> : null}
          </div> : null}
        </section>
      ) : null}

      {historyAvailable && guestImportAvailable ? <section className="guest-import-consent" aria-label={m.guestImport.aria}>
        <strong>{m.guestImport.title}</strong>
        <p>{m.guestImport.body}</p>
        <div>
          <button type="button" disabled={historyLoading || loading} onClick={() => void importCurrentGuestConversation()}>{m.guestImport.accept}</button>
          <button type="button" disabled={historyLoading || loading} onClick={() => { clearGuestConversation(); setGuestImportAvailable(false); setPersistenceNotice(n.guestDeleted); }}>{m.guestImport.discard}</button>
        </div>
      </section> : null}

      {executionMode === "dual_api" ? (
        <label className="chat-compare-toggle">
          <input
            type="checkbox"
            checked={compare}
            onChange={(event) => setCompare(event.target.checked)}
            disabled={loading}
          />
          <span>
            <strong>{m.compareToggle.title}</strong>
            <small>{m.compareToggle.note}</small>
          </span>
        </label>
      ) : null}

      <label className="chat-compare-toggle">
        <input
          type="checkbox"
          checked={externalProcessingConsent}
          onChange={(event) => setExternalProcessingConsent(event.target.checked)}
          disabled={loading}
        />
        <span>
          <strong>{m.consent.title}</strong>
          <small>{format(m.consent.body, { contractExtra: contractReview ? m.consent.contractExtra : "" })}</small>
        </span>
      </label>

      {contractReview && reviewCounts ? (
        <section className="chat-contract-review-link" aria-label={m.contractLink.aria}>
          <div>
            <strong>{m.contractLink.title}</strong>
            <span>
              {format(m.contractLink.counts, { detected: reviewCounts.detected, missing: reviewCounts.missing, review: reviewCounts.review })}
            </span>
            <small>{m.contractLink.note}</small>
          </div>
          <button type="button" disabled={loading} onClick={detachContractReview}>{m.contractLink.detach}</button>
        </section>
      ) : null}

      {error ? <p className="chat-error" role="alert">{error}</p> : null}
      {persistenceNotice ? <p className="chat-persistence-status" role="status">{persistenceNotice}</p> : null}

      <form className="chat-form" onSubmit={handleSubmit}>
        {executionMode === "openai_responses" && chatMode === "contract" ? (
          <div className="chat-contract-upload">
            <label className="button button-outline" htmlFor={contractFileInputId}>
              {m.upload.attach}
            </label>
            <input
              ref={contractFileInputRef}
              id={contractFileInputId}
              className="sr-only"
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
              onChange={handleContractFile}
              disabled={loading}
            />
            <span>{contractFile ? format(m.upload.selected, { file: contractFile.name }) : m.upload.hint}</span>
          </div>
        ) : null}
        <label className="sr-only" htmlFor={inputId}>{m.input.label}</label>
        <textarea
          id={inputId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={activeCompanyId ? format(m.input.placeholderCompany, { company: activeCompanyLabel ?? m.topbar.selectedCompanyFallback }) : m.input.placeholderGeneral}
          rows={2}
          maxLength={2_000}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendMessage(draft);
            }
          }}
        />
        {/* 음성 입력·읽어 주기는 아직 준비 중이다. 비활성 표시만 두고 누르면 아무 일도 하지 않는다. */}
        <span className="voice-pending">
          <button
            type="button"
            className="voice-pending-button"
            aria-disabled="true"
            aria-describedby={voiceInputTipId}
            onClick={(event) => event.preventDefault()}
          >
            {lm.voiceInput}
          </button>
          <span className="voice-pending-tip" role="tooltip" id={voiceInputTipId}>
            {lm.voicePending} · {lm.voicePendingReason}
          </span>
        </span>
        <span className="voice-pending">
          <button
            type="button"
            className="voice-pending-button"
            aria-disabled="true"
            aria-describedby={voiceReadTipId}
            onClick={(event) => event.preventDefault()}
          >
            {lm.voiceRead}
          </button>
          <span className="voice-pending-tip" role="tooltip" id={voiceReadTipId}>
            {lm.voicePending} · {lm.voicePendingReason}
          </span>
        </span>
        <button type="submit" className="chat-send" disabled={loading || !draft.trim() || !externalProcessingConsent} aria-label={m.input.sendAria}><span aria-hidden="true">↑</span></button>
      </form>
      {!activeCompanyId ? (
        <p className="chat-company-help">
          {m.companyHelp.before}<Link href="/companies">{m.companyHelp.link}</Link>{m.companyHelp.after}
        </p>
      ) : null}
      {favoriteCompanies.some((company) => company.company_id !== activeCompanyId) ? (
        <nav className="chat-favorite-companies" aria-label={m.favoritesLabel}>
          <span>{m.favoritesLabel}</span>
          {favoriteCompanies
            .filter((company) => company.company_id !== activeCompanyId)
            .slice(0, 6)
            .map((company) => (
              <Link
                key={company.company_id}
                href={`/chat?company_id=${encodeURIComponent(company.company_id)}`}
                title={[company.region, company.industry].filter(Boolean).join(" · ") || undefined}
              >
                {company.company_name}
              </Link>
            ))}
        </nav>
      ) : null}
      </div>
      <aside className="question-guide" aria-label={m.guide.aria}>
        <div className="guide-title">
          <Image
            className="guide-avatar"
            src="/brand/donworry-avatar.png"
            alt=""
            width={192}
            height={192}
          />
          <div><strong>{m.guide.title}</strong><small>{m.guide.subtitle}</small></div>
        </div>
        {activeCompanyLabel ? (
          <div className="guide-context"><strong>{activeCompanyLabel}</strong><span>{m.guide.contextNote}</span></div>
        ) : null}
        {GUIDE_GROUPS.map((group) => {
          const groupCopy = m.guide[group.key] as ChatMessages["guide"][typeof group.key] & Record<string, { label: string; prompt: string }>;
          return (
            <div className="guide-group" key={group.key}>
              <strong>{groupCopy.title}</strong>
              {group.items.map((itemKey) => {
                const item = groupCopy[itemKey];
                return <button type="button" key={itemKey} disabled={loading} onClick={() => void sendMessage(item.prompt)}>{item.label}</button>;
              })}
            </div>
          );
        })}
        <p className="guide-scope-note">{m.guide.scopeNote1}<br />{m.guide.scopeNote2}</p>
      </aside>
    </div>
  );
}
