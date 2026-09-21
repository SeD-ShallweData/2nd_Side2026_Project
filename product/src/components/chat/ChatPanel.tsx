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
import { readApiResponse } from "@/utils/clientApi";
import { publicClientHeaders } from "@/utils/publicClientId";
import { publicAnswerText } from "@/services/publicAnswerContext";
import {
  appendGuestConversationTurn,
  clearGuestConversation,
  readGuestConversation,
} from "@/services/guestConversationClient";

const COMPANY_QUESTIONS = [
  "왜 추가 확인이 필요한가요?",
  "입사 전에 무엇을 확인해야 하나요?",
  "임금이 밀리면 어떻게 해야 하나요?",
  "산재 신청은 어떻게 하나요?",
  "이 회사는 안전한가요?",
] as const;

const GENERAL_QUESTIONS = [
  "임금이 밀리면 어떻게 해야 하나요?",
  "산재 신청은 어떻게 하나요?",
  "근로계약서에서 무엇을 확인해야 하나요?",
  "이 회사는 안전한가요?",
] as const;

const GUIDE_GROUPS = [
  {
    title: "입사 전 확인",
    items: [
      ["임금 지급 조건", "입사 전에 임금 지급일과 급여 구성에서 무엇을 확인해야 하나요?"],
      ["계약서 필수 항목", "근로계약서에서 꼭 확인해야 하는 항목을 알려주세요."],
    ],
  },
  {
    title: "문제가 생겼을 때",
    items: [
      ["임금이 밀렸을 때", "임금이 밀렸을 때 어떤 자료부터 준비해야 하나요?"],
      ["해고 통보 확인", "갑자기 나오지 말라는 말을 들었을 때 무엇을 확인해야 하나요?"],
      ["연차 확인", "연차 유급휴가를 사용하지 못했을 때 무엇을 확인해야 하나요?"],
    ],
  },
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
}

function welcomeContent(company: string | undefined, executionMode: ConfiguredChatExecutionMode): string {
  if (company) {
    return executionMode === "dual_api"
      ? `${company}의 공개 컨텍스트와 공식 근거를 Upstage Solar에 전달해 답변합니다. 필요할 때만 SKT A.X 비교를 켤 수 있습니다. 안전·위법 여부나 입사 결정을 대신하지는 않습니다.`
      : `${company}을 선택했습니다. 필요한 경우 허용된 사업장·위험·법령 조회 도구를 사용해 답변합니다.`;
  }
  return executionMode === "dual_api"
    ? "기본적으로 Upstage Solar 하나에 질문을 보내고, 비교를 켠 질문에만 SKT A.X 답변을 함께 표시합니다."
    : "OpenAI Responses가 질문에 필요한 공식 정보 도구만 선택적으로 호출해 노동 상담 답변을 만듭니다.";
}

function metric(value: number | null, suffix = ""): string {
  return value === null ? "미제공" : `${value.toLocaleString("ko-KR")}${suffix}`;
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
  const statusLabel = providerRunStatusLabel(result.status, result.trace.guardrail_hits, result.trace.recall_mode);

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

      <section className="provider-evidence" aria-label={`${result.provider_label} 답변 근거와 한계`}>
        <div>
          <strong>공식 근거</strong>
          <DataSourceList sources={result.sources} />
        </div>
        <div>
          <strong>답변 한계</strong>
          {result.limitations.length > 0 ? (
            <ul>{result.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
          ) : <p className="muted-text">별도로 표시된 한계가 없습니다.</p>}
        </div>
      </section>

      <details className="provider-trace">
        <summary>응답 상세 · 속도, 토큰, 생성 과정</summary>
        <dl>
          <div><dt>전체 응답시간</dt><dd>{metric(result.metrics.latency_ms, "ms")}</dd></div>
          <div><dt>전체 토큰</dt><dd>{metric(result.metrics.usage.total_tokens)}</dd></div>
          <div><dt>답변 길이</dt><dd>{metric(result.metrics.answer_chars, "자")}</dd></div>
          <div><dt>실행 상태</dt><dd>{statusLabel}</dd></div>
          <div><dt>컨텍스트</dt><dd>{result.trace.context_mode === "company" ? "선택 사업장 연결" : "일반 상담"}</dd></div>
          <div><dt>질의 재작성</dt><dd>{result.trace.query_transform === "none" ? "사용 안 함" : "후속 질문 독립형 재작성"}</dd></div>
          <div><dt>최근 대화</dt><dd>{result.trace.recent_message_count}개 전달</dd></div>
          <div><dt>공식 근거 검색</dt><dd>{result.trace.rag_status}</dd></div>
          <div><dt>검색 판단</dt><dd>{result.trace.rag_reason ?? "근거 연결"}</dd></div>
          <div><dt>범위 밖 주제</dt><dd>{result.trace.rag_topic ?? "해당 없음"}</dd></div>
          <div><dt>공유 근거</dt><dd>{result.trace.retrieved_document_count}개</dd></div>
          {result.trace.tool_round_count !== undefined ? <div><dt>도구 라운드</dt><dd>{result.trace.tool_round_count}회</dd></div> : null}
          {result.trace.tool_call_count !== undefined ? <div><dt>도구 호출</dt><dd>{result.trace.tool_call_count}회</dd></div> : null}
          {result.trace.tool_names ? <div><dt>사용 도구</dt><dd>{result.trace.tool_names.join(", ") || "사용 안 함"}</dd></div> : null}
          <div><dt>정책 버전</dt><dd>{result.trace.prompt_policy_version}</dd></div>
          <div><dt>가드레일</dt><dd>{result.trace.guardrail_action}</dd></div>
          <div><dt>가드레일 규칙</dt><dd>{result.trace.guardrail_hits.join(", ") || "탐지 없음"}</dd></div>
          <div><dt>종료 사유</dt><dd>{result.metrics.finish_reason || "미제공"}</dd></div>
          <div><dt>입력 토큰</dt><dd>{metric(result.metrics.usage.prompt_tokens)}</dd></div>
          <div><dt>출력 토큰</dt><dd>{metric(result.metrics.usage.completion_tokens)}</dd></div>
          <div><dt>캐시 토큰</dt><dd>{metric(result.metrics.usage.cached_tokens)}</dd></div>
          <div><dt>추론 토큰</dt><dd>{metric(result.metrics.usage.reasoning_tokens)}</dd></div>
          <div><dt>첫 토큰 시간</dt><dd>비스트리밍 호출로 미측정</dd></div>
          <div><dt>요청 추적 ID</dt><dd>{result.trace.upstream_request_id || "미제공"}</dd></div>
        </dl>
        <p className="trace-security-note">API 키와 숨은 시스템 프롬프트는 보안을 위해 표시하지 않습니다.</p>
      </details>

      {result.suggested_actions.length > 0 ? (
        <div className="provider-actions">
          <strong>다음 행동</strong>
          <ul>
            {result.suggested_actions.map((action) => (
              <li key={action.code}>
                <span>{action.priority === "now" ? "지금" : action.priority === "next" ? "다음" : "선택"}</span>
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
  const retrieval = comparison.results[0]?.trace;
  const ragToolCalled = retrieval?.tool_names?.includes("retrieve_labor_law") ?? false;
  const ragLabel = !retrieval
    ? "공식 근거 상태 미확인"
    : comparison.execution_mode === "policy_short_circuit" && retrieval.recall_mode
      ? "사용자 진술 기반 · 법령 검색 미사용"
    : comparison.execution_mode === "openai_responses" && !ragToolCalled
      ? "이번 답변에서 공식 법령 검색 미사용"
    : retrieval.rag_status === "matched"
      ? `공식 근거 ${retrieval.retrieved_document_count}개 연결`
      : retrieval.rag_status === "no_match"
        ? retrieval.rag_reason === "out_of_scope" && retrieval.rag_topic
          ? `현재 수록 범위 밖 · ${retrieval.rag_topic}`
          : "직접 관련 공식 근거 없음"
        : comparison.execution_mode === "policy_short_circuit"
          ? "긴급 안내 우선"
          : "공식 근거 검색 연결 안 됨";
  const modeCopy = executionModeCopy(comparison.execution_mode, retrieval?.guardrail_hits, retrieval?.recall_mode);
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
        <span>{new Date(comparison.completed_at).toLocaleTimeString("ko-KR")}</span>
      </div>
      <div className={`provider-answer-grid${comparison.results.length === 1 ? " provider-answer-grid-single" : ""}`}>
        {comparison.results.map((result) => <ProviderAnswerCard key={result.provider} result={result} />)}
      </div>
      {showFeedback ? <div className="comparison-feedback">
        <div>
          <strong>어느 답변이 더 유용했나요?</strong>
          <span>질문과 답변 원문 없이 선택과 성능 지표만 로컬 평가 로그에 저장됩니다.</span>
        </div>
        <div className="feedback-buttons">
          {feedbackResults.map((result) => (
            <button
              type="button"
              key={result.provider}
              className={selected === result.provider ? "selected" : ""}
              onClick={() => onSelect(result.provider)}
            >
              {result.provider_label}가 더 유용
            </button>
          ))}
          <button type="button" className={selected === "tie" ? "selected" : ""} onClick={() => onSelect("tie")}>
            비슷함
          </button>
        </div>
        {selected ? <p role="status">평가가 저장되었습니다.</p> : null}
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
}: {
  companyId?: string;
  companyName?: string;
  suggestedPrompt?: string;
  chatMode?: ChatMode;
  executionMode?: ConfiguredChatExecutionMode;
}) {
  const inputId = useId();
  const contractFileInputId = useId();
  const contractFileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(suggestedPrompt ?? "");
  const [messages, setMessages] = useState<UiMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: welcomeContent(companyName, executionMode),
    },
  ]);
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

  const refreshConversationHistory = useCallback(async () => {
    const response = await fetch("/api/conversations?limit=20", { cache: "no-store" });
    if (response.status === 401) {
      setHistoryAvailable(false);
      setConversationHistory([]);
      return;
    }
    if (!response.ok) throw new Error("대화 기록을 불러오지 못했습니다.");
    const data = await readApiResponse<ConversationListResponse>(response);
    setHistoryAvailable(true);
    setConversationHistory(data.items);
  }, []);

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

  async function sendMessage(value: string, retryRequestId?: string) {
    const message = value.trim();
    if (!message || loading) return;
    if (!externalProcessingConsent) {
      setError("외부 AI 전송 안내를 확인하고 이번 질문 전송에 동의해 주세요.");
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
          recent_messages: recentMessages,
        });
      }
      const response = await fetch("/api/chat", requestInit);
      const data = await readApiResponse<ChatComparisonResponse>(response);
      if (data.conversation_persistence !== "guest") setConversationId(data.conversation_id);
      if (data.conversation_persistence === "saved") {
        setPersistenceNotice("상담과 표시된 답변이 저장되었습니다.");
        void refreshConversationHistory().catch(() => setHistoryAvailable(false));
      } else if (data.conversation_persistence === "unavailable") {
        setHistoryAvailable(false);
        setError("답변은 표시했지만 대화 기록 저장소에 연결하지 못했습니다.");
        setPersistenceNotice("저장에 실패했습니다. 같은 질문의 재전송 버튼으로 저장을 다시 시도할 수 있습니다.");
      } else if (data.conversation_persistence === "guest") {
        appendGuestConversationTurn(message, activeCompanyId ?? null, data);
        setGuestImportAvailable(true);
        setPersistenceNotice("이 익명 상담은 현재 탭에만 임시 보관됩니다.");
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
      setError(caught instanceof Error ? caught.message : "상담 답변을 불러오지 못했습니다.");
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
      setError("비교 평가는 화면에 반영됐지만 로그 저장에는 실패했습니다.");
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
        { id: "welcome", role: "assistant", content: welcomeContent(
          restoredCompanyName,
          executionMode,
        ) },
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
      setPersistenceNotice("저장된 상담을 복원했습니다. 현재 사업장 문맥도 함께 적용되었습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "대화 기록을 불러오지 못했습니다.");
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
      setPersistenceNotice("저장된 상담을 삭제했습니다. 늦게 끝난 응답도 다시 저장되지 않습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "대화 기록을 삭제하지 못했습니다.");
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
        ? { ...message, content: welcomeContent(updated.active_company_id === companyId ? companyName : updated.active_company_id ?? undefined, executionMode) }
        : message));
      await refreshConversationHistory();
      setPersistenceNotice(patch.title !== undefined ? "상담 제목을 수정했습니다." : updated.active_company_id ? "사업장 문맥을 변경했습니다." : "사업장 문맥을 해제했습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "상담 정보를 수정하지 못했습니다.");
    } finally {
      setHistoryLoading(false);
    }
  }

  function editConversationTitle() {
    if (!conversationId) return;
    const title = window.prompt("새 상담 제목을 입력해 주세요.", conversationTitle ?? "");
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
      setPersistenceNotice(imported.reused ? "이미 가져온 익명 상담을 복원했습니다." : "동의한 현재 익명 상담 하나를 계정으로 가져왔습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "익명 상담을 가져오지 못했습니다.");
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
      setError("계약서는 PDF, PNG, JPG 파일만 선택할 수 있습니다.");
      event.target.value = "";
      return;
    }
    if (next.size > MAX_CONTRACT_FILE_SIZE) {
      setContractFile(null);
      setError("계약서 파일은 10MB 이하여야 합니다.");
      event.target.value = "";
      return;
    }
    setContractFile(next);
  }

  const questions = activeCompanyId ? COMPANY_QUESTIONS : GENERAL_QUESTIONS;
  const activeCompanyLabel = activeCompanyName ?? (activeCompanyId ? "선택 사업장" : undefined);

  return (
    <div className="chat-experience-layout">
      <div className="chat-panel comparison-chat-panel">
      <div className="chat-topbar">
        <div><span className="online-dot" aria-hidden="true" /><strong>{executionMode === "dual_api" ? compare ? "Upstage·SKT 답변 비교" : "Upstage Solar 단일 상담" : "OpenAI 도구 연결 상담"}</strong></div>
        <span>{activeCompanyLabel ? `${activeCompanyLabel} 컨텍스트 연결됨` : chatMode === "contract" ? "계약서 후속 상담" : "일반 노동 상담"}</span>
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
                  <button type="button" className="message-retry" onClick={() => void sendMessage(message.content, message.requestId)} disabled={loading} aria-label={`질문 다시 보내기: ${message.content}`}>
                    <span aria-hidden="true">↻</span> 재전송
                  </button>
                  <div className="chat-message chat-message-user"><p>{message.content}</p></div>
                  {message.companyId ? <small className="turn-company-label">당시 사업장: {message.companyName ?? "연결된 사업장"}</small> : null}
                </div>
              ) : <div className="chat-message chat-message-assistant"><p>{message.content}</p>{message.sources?.length ? <DataSourceList sources={message.sources} /> : null}</div>}
            </div>
          )
        ))}
        {loading ? executionMode === "dual_api" && compare ? (
          <div className="dual-loading" role="status">
            <strong>두 모델에 같은 요청을 동시에 보냈습니다</strong>
            <div>
              <span><i className="provider-dot provider-dot-upstage" />Upstage Solar 응답 대기</span>
              <span><i className="provider-dot provider-dot-skt" />SKT A.X 응답 대기</span>
            </div>
            <small>한쪽이 실패해도 다른 모델의 결과는 유지합니다. 최대 45초까지 기다릴 수 있습니다.</small>
          </div>
        ) : executionMode === "dual_api" ? (
          <div className="dual-loading" role="status">
            <strong>Upstage Solar에 공식 근거와 함께 질문을 보냈습니다</strong>
            <div>
              <span><i className="provider-dot provider-dot-upstage" />Upstage Solar 응답 대기</span>
            </div>
            <small>기본 단일 모델 호출이며, SKT A.X는 비교를 켠 질문에서만 호출합니다.</small>
          </div>
        ) : (
          <div className="dual-loading" role="status">
            <strong>질문을 분석하고 필요한 공식 정보 도구를 확인하고 있습니다</strong>
            <div>
              <span><i className="provider-dot provider-dot-openai" />OpenAI Responses 응답 대기</span>
            </div>
            <small>도구가 필요하면 허용된 검색·위험·법령 조회만 실행합니다. 여러 단계면 응답에 시간이 걸릴 수 있습니다.</small>
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>

      <div className="question-chips" aria-label="추천 질문">
        {questions.map((question) => (
          <button key={question} type="button" onClick={() => void sendMessage(question)} disabled={loading}>{question}</button>
        ))}
      </div>

      {historyAvailable ? (
        <section className="chat-history" aria-label="저장된 대화">
          <div><strong>저장된 대화</strong><small>마지막 활동 후 30일이 지나면 원문과 표시 근거가 삭제됩니다.</small></div>
          {conversationHistory.length ? <ul>
            {conversationHistory.map((conversation) => <li key={conversation.conversation_id}>
              <button type="button" disabled={historyLoading || loading} onClick={() => void restoreConversation(conversation.conversation_id)}>
                {conversation.title}
              </button>
              <button type="button" disabled={historyLoading || loading} onClick={() => void deleteConversation(conversation)} aria-label={`${conversation.title} 삭제`}>삭제</button>
            </li>)}
          </ul> : <p className="muted-text">아직 저장된 대화가 없습니다.</p>}
          {conversationId ? <div className="conversation-controls">
            <button type="button" disabled={historyLoading || loading} onClick={editConversationTitle}>제목 수정</button>
            {companyId && companyId !== activeCompanyId ? <button type="button" disabled={historyLoading || loading} onClick={() => void updateConversationMetadata({ active_company_id: companyId })}>현재 화면 사업장으로 변경</button> : null}
            {activeCompanyId ? <button type="button" disabled={historyLoading || loading} onClick={() => void updateConversationMetadata({ active_company_id: null })}>사업장 연결 해제</button> : null}
          </div> : null}
        </section>
      ) : null}

      {historyAvailable && guestImportAvailable ? <section className="guest-import-consent" aria-label="익명 상담 가져오기">
        <strong>로그인 전에 진행한 현재 익명 상담이 있습니다.</strong>
        <p>동의하면 이 상담 하나만 계정의 30일 대화 기록으로 가져옵니다.</p>
        <div>
          <button type="button" disabled={historyLoading || loading} onClick={() => void importCurrentGuestConversation()}>동의하고 가져오기</button>
          <button type="button" disabled={historyLoading || loading} onClick={() => { clearGuestConversation(); setGuestImportAvailable(false); setPersistenceNotice("익명 상담 임시 기록을 삭제했습니다."); }}>가져오지 않고 삭제</button>
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
            <strong>SKT A.X 답변도 함께 비교</strong>
            <small>선택 시 다음 질문에 두 모델의 답변을 함께 제공합니다.</small>
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
          <strong>이번 질문의 외부 AI 전송에 동의</strong>
          <small>질문, 최근 대화 최대 10개, 30일 요약, 선택한 회사 공개 정보와 현재 공식 근거가 전송됩니다. 동의는 저장하지 않으며 체크를 해제하면 다음 전송을 막습니다.</small>
        </span>
      </label>

      {error ? <p className="chat-error" role="alert">{error}</p> : null}
      {persistenceNotice ? <p className="chat-persistence-status" role="status">{persistenceNotice}</p> : null}

      <form className="chat-form" onSubmit={handleSubmit}>
        {executionMode === "openai_responses" && chatMode === "contract" ? (
          <div className="chat-contract-upload">
            <label className="button button-outline" htmlFor={contractFileInputId}>
              상담에 계약서 첨부
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
            <span>{contractFile ? `${contractFile.name} · 전송 후 선택 해제` : "선택 사항 · 최대 10MB"}</span>
          </div>
        ) : null}
        <label className="sr-only" htmlFor={inputId}>상담 질문</label>
        <textarea
          id={inputId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={activeCompanyId ? `${activeCompanyLabel ?? "선택 사업장"}에 관해 궁금한 점을 입력하세요` : "노동 관련 질문을 입력하세요"}
          rows={2}
          maxLength={2_000}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendMessage(draft);
            }
          }}
        />
        <button type="submit" className="chat-send" disabled={loading || !draft.trim() || !externalProcessingConsent} aria-label="질문 보내기"><span aria-hidden="true">↑</span></button>
      </form>
      {!activeCompanyId ? (
        <p className="chat-company-help">
          특정 회사에 관해 질문하려면 <Link href="/companies">사업장을 먼저 검색해 선택</Link>하세요.
        </p>
      ) : null}
      </div>
      <aside className="question-guide" aria-label="AI 질문 가이드">
        <div className="guide-title">
          <Image
            className="guide-avatar"
            src="/brand/donworry-avatar.png"
            alt=""
            width={192}
            height={192}
          />
          <div><strong>AI 질문 가이드</strong><small>무엇부터 물을지 막막하다면</small></div>
        </div>
        {activeCompanyLabel ? (
          <div className="guide-context"><strong>{activeCompanyLabel}</strong><span>사업장 공개 컨텍스트 연결</span></div>
        ) : null}
        {GUIDE_GROUPS.map((group) => (
          <div className="guide-group" key={group.title}>
            <strong>{group.title}</strong>
            {group.items.map(([label, prompt]) => (
              <button type="button" key={label} disabled={loading} onClick={() => void sendMessage(prompt)}>{label}</button>
            ))}
          </div>
        ))}
        <p className="guide-scope-note">현재 공식 근거 검색 범위에 맞춘 질문입니다.<br />수록 범위 밖 주제는 해당 이유와 공식 확인 창구를 안내합니다.</p>
      </aside>
    </div>
  );
}
