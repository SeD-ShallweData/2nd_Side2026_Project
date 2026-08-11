"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { DataSourceList } from "@/components/common/DataSourceList";
import type {
  InspectorChatResponse,
  InspectorCompanyDetail,
  InspectorRecentMessage,
} from "@/domain/inspector";
import { readApiResponse } from "@/utils/clientApi";

const SUGGESTED_QUESTIONS = [
  "이 사업장이 위험큐에 포함된 이유를 현장 확인 항목으로 정리해줘.",
  "현장 방문 전에 준비할 자료와 확인 순서를 알려줘.",
  "모델 원점수를 확률로 해석하면 안 되는 이유를 설명해줘.",
] as const;

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  comparison?: InspectorChatResponse;
}

export function InspectorChatPanel({ companyId }: { companyId?: string }) {
  const [detail, setDetail] = useState<InspectorCompanyDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingCompany, setLoadingCompany] = useState(Boolean(companyId));
  const [loading, setLoading] = useState(false);
  const [externalContextConsent, setExternalContextConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/inspector/companies/${encodeURIComponent(companyId!)}`, { cache: "no-store" });
        const data = await readApiResponse<InspectorCompanyDetail>(response);
        if (!cancelled) {
          setDetail(data);
          setMessages([{ id: "welcome", role: "assistant", content: `${data.company.company_name}의 내부 위험 데이터가 연결됐습니다. 두 모델은 같은 DB 컨텍스트와 같은 공식 검색 근거를 사용합니다.` }]);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "사업장 컨텍스트를 불러오지 못했습니다.");
      } finally {
        if (!cancelled) setLoadingCompany(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [companyId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, loading]);

  async function sendMessage(value: string) {
    const message = value.trim();
    if (!message || !detail || loading || !externalContextConsent) return;
    const recentMessages: InspectorRecentMessage[] = messages.slice(-6).map((item) => ({
      role: item.role,
      content: item.comparison
        ? item.comparison.results.map((result) => `${result.provider_label}: ${result.answer}`).join("\n").slice(0, 2_000)
        : item.content,
    }));
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", content: message }]);
    setDraft("");
    setError(null);
    setLoading(true);
    try {
      const response = await fetch("/api/inspector/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_id: detail.company.company_id,
          message,
          recent_messages: recentMessages,
          confirm_external_context: true,
        }),
      });
      const data = await readApiResponse<InspectorChatResponse>(response);
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: "두 모델 점검 보조 결과", comparison: data }]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI 점검 보조 답변을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(draft);
  }

  if (!companyId) {
    return (
      <div className="inspector-chat-empty">
        <span aria-hidden="true">⌕</span>
        <h2>분석할 사업장을 먼저 선택해 주세요.</h2>
        <p>감독관 대시보드에서 사업장을 조회한 뒤 ‘AI 점검 보조 열기’를 누르면 실제 내부 데이터가 연결됩니다.</p>
        <Link href="/inspector" className="button button-dark">사업장 대시보드로 이동</Link>
      </div>
    );
  }

  if (loadingCompany) return <div className="inspector-chat-empty"><span className="spinner" /><h2>사업장 컨텍스트를 연결하고 있습니다.</h2></div>;

  return (
    <div className="inspector-chat-layout">
      <aside className="inspector-chat-context">
        {detail ? (
          <>
            <span className="eyebrow">Connected workplace</span>
            <h2>{detail.company.company_name}</h2>
            <p>{[detail.company.region, detail.company.industry].filter(Boolean).join(" · ") || "지역·업종 정보 없음"}</p>
            <dl>
              <div><dt>모델 원점수</dt><dd>{detail.wage_risk.model_score === null ? "채점 불가" : detail.wage_risk.model_score.toFixed(4)}</dd></div>
              <div><dt>상대 위험등급</dt><dd>{detail.wage_risk.risk_tier ?? "미분류"}</dd></div>
              <div><dt>위험큐</dt><dd>{detail.wage_risk.rank === null ? "상위 3,000 밖" : `${detail.wage_risk.rank}위 · ${detail.wage_risk.queue_priority}`}</dd></div>
              <div><dt>기준월</dt><dd>{detail.batch.data_as_of ?? "미확정"}</dd></div>
              <div><dt>예측 대상월</dt><dd>{detail.batch.target_month ?? "미확정"}</dd></div>
            </dl>
            <div className="inspector-context-reasons">
              <strong>저장된 모델 기여 사유</strong>
              {detail.wage_risk.reasons.length > 0 ? <ul>{detail.wage_risk.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : <p>제공된 사유 없음</p>}
            </div>
            <p className="inspector-context-warning">원점수는 발생 확률이 아니며 AI 답변은 처분 판단을 대신하지 않습니다.</p>
            <Link href="/inspector" className="text-link">다른 사업장 선택</Link>
          </>
        ) : null}
      </aside>

      <section className="inspector-chat-panel">
        <div className="inspector-chat-topbar">
          <div><span className="online-dot" /><strong>감독관 AI 점검 보조</strong></div>
          <span>동일 조건 · 두 모델 병렬 비교</span>
        </div>
        <div className="inspector-chat-body" aria-live="polite" aria-busy={loading}>
          {messages.map((message) => message.comparison ? (
            <div className="inspector-comparison" key={message.id}>
              <header>
                <div><strong>두 모델의 점검 보조 결과</strong><span>같은 DB 컨텍스트 · 같은 RAG 근거</span></div>
                <span className={`rag-status rag-status-${message.comparison.rag_status}`}>{message.comparison.rag_status === "matched" ? `공식 근거 ${message.comparison.sources.length}개` : message.comparison.rag_status === "no_match" ? "직접 근거 없음" : "RAG 연결 안 됨"}</span>
              </header>
              <div className="inspector-answer-grid">
                {message.comparison.results.map((result) => (
                  <article key={result.provider} className={`inspector-answer inspector-answer-${result.provider}`}>
                    <div className="inspector-answer-head">
                      <div><span className={`provider-dot provider-dot-${result.provider}`} /><strong>{result.provider_label}</strong><small>{result.model}</small></div>
                      <span>{result.status === "success" ? "API 응답" : result.status === "guardrail_replaced" ? "정책 교체" : "DB 요약 대체"}</span>
                    </div>
                    {result.error ? <p className="inspector-answer-error">{result.error.message}</p> : null}
                    <div className="inspector-answer-copy">{result.answer}</div>
                    <div className="inspector-answer-limit"><strong>해석 한계</strong><ul>{result.limitations.map((item) => <li key={item}>{item}</li>)}</ul></div>
                    <details><summary>응답 상세</summary><dl><div><dt>응답 시간</dt><dd>{result.metrics.latency_ms.toLocaleString("ko-KR")}ms</dd></div><div><dt>전체 토큰</dt><dd>{result.metrics.usage.total_tokens?.toLocaleString("ko-KR") ?? "미제공"}</dd></div></dl></details>
                  </article>
                ))}
              </div>
              {message.comparison.sources.length > 0 ? <div className="inspector-chat-sources"><strong>공유된 공식 근거</strong><DataSourceList sources={message.comparison.sources} /></div> : null}
            </div>
          ) : (
            <div className={`inspector-chat-row inspector-chat-row-${message.role}`} key={message.id}>
              {message.role === "assistant" ? <span aria-hidden="true">DW</span> : null}
              <p>{message.content}</p>
            </div>
          ))}
          {loading ? <div className="inspector-chat-loading"><span className="spinner" /><div><strong>두 모델이 내부 자료를 검토하고 있습니다.</strong><small>공식 근거는 한 번만 검색해 동일하게 전달합니다.</small></div></div> : null}
          <div ref={bottomRef} />
        </div>
        <div className="inspector-question-chips">
          {SUGGESTED_QUESTIONS.map((question) => <button type="button" key={question} onClick={() => void sendMessage(question)} disabled={loading || !detail || !externalContextConsent}>{question}</button>)}
        </div>
        {error ? <p className="inspector-chat-error" role="alert">{error}</p> : null}
        <label className="inspector-external-consent">
          <input
            type="checkbox"
            checked={externalContextConsent}
            onChange={(event) => setExternalContextConsent(event.target.checked)}
          />
          <span>
            <strong>외부 AI 분석자료 전송 확인</strong>
            사업장명·지역·업종·모델 원점수·상대등급·큐 순위·저장된 SHAP 사유가 Upstage와 SKT에 전달됩니다.
            마스킹 사업자번호와 내부 식별키는 전달하지 않습니다.
          </span>
        </label>
        <form className="inspector-chat-form" onSubmit={handleSubmit}>
          <label className="sr-only" htmlFor="inspector-chat-input">점검 보조 질문</label>
          <textarea id="inspector-chat-input" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="현장 확인 항목이나 적용 법령을 질문하세요" rows={2} maxLength={2_000} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(draft); } }} />
          <button type="submit" disabled={loading || !draft.trim() || !detail || !externalContextConsent} aria-label="질문 보내기">↑</button>
        </form>
      </section>
    </div>
  );
}
