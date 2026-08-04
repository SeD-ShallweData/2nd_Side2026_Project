"use client";

import Link from "next/link";
import { FormEvent, useEffect, useId, useRef, useState } from "react";
import { DataSourceList } from "@/components/common/DataSourceList";
import type { RecentMessage } from "@/domain/chat";
import type {
  ChatComparisonResponse,
  LlmProviderId,
  ProviderComparisonResult,
} from "@/domain/chatComparison";
import { readApiResponse } from "@/utils/clientApi";

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

interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  comparison?: ChatComparisonResponse;
}

function metric(value: number | null, suffix = ""): string {
  return value === null ? "미제공" : `${value.toLocaleString("ko-KR")}${suffix}`;
}

function ProviderAnswerCard({ result }: { result: ProviderComparisonResult }) {
  const statusLabel =
    result.status === "success"
      ? "API 응답"
      : result.status === "guardrail_replaced"
        ? "정책 교체"
        : result.status === "policy_short_circuit"
          ? "긴급정책 즉시 응답"
          : "정책 대체 응답";

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

      <div className="provider-answer-copy">{result.answer}</div>

      <div className="provider-quick-metrics" aria-label={`${result.provider_label} 핵심 성능 지표`}>
        <span><strong>{metric(result.metrics.latency_ms, "ms")}</strong> 응답시간</span>
        <span><strong>{metric(result.metrics.usage.total_tokens)}</strong> 전체 토큰</span>
        <span><strong>{metric(result.metrics.answer_chars)}</strong> 글자</span>
      </div>

      <details className="provider-trace">
        <summary>답변 생성 과정과 상세 지표</summary>
        <dl>
          <div><dt>실행 상태</dt><dd>{statusLabel}</dd></div>
          <div><dt>컨텍스트</dt><dd>{result.trace.context_mode === "company" ? "선택 사업장 연결" : "일반 상담"}</dd></div>
          <div><dt>질의 재작성</dt><dd>{result.trace.query_transform === "none" ? "사용 안 함" : result.trace.query_transform}</dd></div>
          <div><dt>최근 대화</dt><dd>{result.trace.recent_message_count}개 전달</dd></div>
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

      <details className="provider-sources">
        <summary>출처와 답변 한계</summary>
        <DataSourceList sources={result.sources} />
        {result.limitations.length > 0 ? (
          <ul>{result.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
        ) : null}
      </details>
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
  return (
    <div className="comparison-block">
      <div className="comparison-summary">
        <div>
          <span className="comparison-kicker">{comparison.execution_mode === "dual_api" ? "동일 조건 병렬 비교" : "긴급 안전정책 우선"}</span>
          <strong>{comparison.execution_mode === "dual_api" ? "두 모델이 같은 질문·컨텍스트·생성 설정을 사용했습니다." : "긴급 상황은 모델 응답을 기다리지 않고 공통 안전 안내를 즉시 표시합니다."}</strong>
        </div>
        <span>{new Date(comparison.completed_at).toLocaleTimeString("ko-KR")}</span>
      </div>
      <div className="provider-answer-grid">
        {comparison.results.map((result) => <ProviderAnswerCard key={result.provider} result={result} />)}
      </div>
      <div className="comparison-feedback">
        <div>
          <strong>어느 답변이 더 유용했나요?</strong>
          <span>질문과 답변 원문 없이 선택과 성능 지표만 로컬 평가 로그에 저장됩니다.</span>
        </div>
        <div className="feedback-buttons">
          {comparison.results.map((result) => (
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
      </div>
    </div>
  );
}

export function ChatPanel({
  companyId,
  companyName,
  suggestedPrompt,
}: {
  companyId?: string;
  companyName?: string;
  suggestedPrompt?: string;
}) {
  const inputId = useId();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(suggestedPrompt ?? "");
  const [messages, setMessages] = useState<UiMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: companyName
        ? `${companyName}의 공개 컨텍스트를 두 실제 LLM에 동일하게 전달해 비교합니다. 안전·위법 여부나 입사 결정을 대신하지는 않습니다.`
        : "Upstage Solar와 SKT A.X에 같은 노동 상담 질문을 동시에 보내 답변과 성능 지표를 비교합니다.",
    },
  ]);
  const [conversationId, setConversationId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, LlmProviderId | "tie">>({});

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, loading]);

  async function sendMessage(value: string) {
    const message = value.trim();
    if (!message || loading) return;

    const recentMessages: RecentMessage[] = messages
      .filter((item) => !item.comparison)
      .slice(-8)
      .map((item) => ({ role: item.role, content: item.content }));
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", content: message }]);
    setDraft("");
    setError(null);
    setLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          conversation_id: conversationId,
          company_id: companyId,
          chat_mode: "general",
          recent_messages: recentMessages,
        }),
      });
      const data = await readApiResponse<ChatComparisonResponse>(response);
      setConversationId(data.conversation_id);
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "assistant", content: "두 모델 비교 결과", comparison: data },
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "두 모델의 상담 답변을 불러오지 못했습니다.");
    } finally {
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
          result_metrics: comparison.results.map((result) => ({
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

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(draft);
  }

  const questions = companyId ? COMPANY_QUESTIONS : GENERAL_QUESTIONS;

  return (
    <div className="chat-panel comparison-chat-panel">
      <div className="chat-topbar">
        <div><span className="online-dot" aria-hidden="true" /><strong>실제 LLM 동시 비교</strong></div>
        <span>{companyName ? `${companyName} 컨텍스트 연결됨` : "일반 노동 상담"}</span>
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
              {message.role === "assistant" ? <div className="chat-avatar" aria-hidden="true">돈</div> : null}
              <div className={`chat-message chat-message-${message.role}`}><p>{message.content}</p></div>
            </div>
          )
        ))}
        {loading ? (
          <div className="dual-loading" role="status">
            <strong>두 모델에 같은 요청을 동시에 보냈습니다</strong>
            <div>
              <span><i className="provider-dot provider-dot-upstage" />Upstage Solar 응답 대기</span>
              <span><i className="provider-dot provider-dot-skt" />SKT A.X 응답 대기</span>
            </div>
            <small>한쪽이 실패해도 다른 모델의 결과는 유지합니다. 최대 45초까지 기다릴 수 있습니다.</small>
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>

      <div className="question-chips" aria-label="추천 질문">
        {questions.map((question) => (
          <button key={question} type="button" onClick={() => void sendMessage(question)} disabled={loading}>{question}</button>
        ))}
      </div>

      {error ? <p className="chat-error" role="alert">{error}</p> : null}

      <form className="chat-form" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor={inputId}>상담 질문</label>
        <textarea
          id={inputId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={companyId ? `${companyName}에 관해 궁금한 점을 입력하세요` : "노동 관련 질문을 입력하세요"}
          rows={2}
          maxLength={2_000}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendMessage(draft);
            }
          }}
        />
        <button type="submit" className="chat-send" disabled={loading || !draft.trim()} aria-label="질문 보내기"><span aria-hidden="true">↑</span></button>
      </form>
      <p className="dual-api-note">동일 질문을 실제 Upstage Solar·SKT A.X API에 병렬 전송합니다. API 키와 숨은 프롬프트는 브라우저로 전송하지 않습니다.</p>
      {!companyId ? <p className="chat-company-help">특정 회사에 관해 질문하려면 <Link href="/companies">사업장을 먼저 검색해 선택</Link>하세요.</p> : null}
    </div>
  );
}
