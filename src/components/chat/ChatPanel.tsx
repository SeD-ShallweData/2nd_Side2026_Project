"use client";

import Link from "next/link";
import { FormEvent, useEffect, useId, useRef, useState } from "react";
import { DataSourceList } from "@/components/common/DataSourceList";
import type { ChatResponse, RecentMessage } from "@/domain/chat";
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
  response?: ChatResponse;
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(suggestedPrompt ?? "");
  const [messages, setMessages] = useState<UiMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: companyName
        ? `${companyName}의 Mock 신호를 바탕으로 확인할 항목을 설명해 드릴게요. 안전·위법 여부나 입사 결정을 대신하지는 않습니다.`
        : "임금체불, 근로계약, 산업재해와 관련해 궁금한 상황을 알려주세요. 특정 회사 질문은 사업장을 먼저 선택해야 정확히 답할 수 있습니다.",
    },
  ]);
  const [conversationId, setConversationId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, loading]);

  async function sendMessage(value: string) {
    const message = value.trim();
    if (!message || loading) return;

    const recentMessages: RecentMessage[] = messages.slice(-8).map((item) => ({
      role: item.role,
      content: item.content,
    }));
    const userMessage: UiMessage = { id: crypto.randomUUID(), role: "user", content: message };
    setMessages((current) => [...current, userMessage]);
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
          chat_mode: companyId ? "general" : "general",
          recent_messages: recentMessages,
        }),
      });
      const data = await readApiResponse<ChatResponse>(response);
      setConversationId(data.conversation_id);
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: data.answer,
          response: data,
        },
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "상담 답변을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(draft);
  }

  const questions = companyId ? COMPANY_QUESTIONS : GENERAL_QUESTIONS;

  return (
    <div className="chat-panel">
      <div className="chat-topbar">
        <div>
          <span className="online-dot" aria-hidden="true" />
          <strong>돈워리 Mock 상담</strong>
        </div>
        <span>{companyName ? `${companyName} 컨텍스트 연결됨` : "일반 노동 상담"}</span>
      </div>

      <div className="chat-body" aria-live="polite" aria-busy={loading}>
        {messages.map((message) => (
          <div className={`chat-row chat-row-${message.role}`} key={message.id}>
            {message.role === "assistant" ? (
              <div className="chat-avatar" aria-hidden="true">
                돈
              </div>
            ) : null}
            <div className={`chat-message chat-message-${message.role}`}>
              <p>{message.content}</p>
              {message.response ? (
                <div className="chat-meta">
                  <div className="chat-status-row">
                    <span>답변 유형: {message.response.answer_type}</span>
                    <span>가드레일: {message.response.guardrail_status}</span>
                  </div>
                  {message.response.suggested_actions.length > 0 ? (
                    <div>
                      <strong>다음 행동</strong>
                      <ul className="suggested-action-list">
                        {message.response.suggested_actions.map((action) => (
                          <li key={action.code}>
                            <span>{action.priority === "now" ? "지금" : action.priority === "next" ? "다음" : "선택"}</span>
                            <div>
                              <strong>{action.label}</strong>
                              {action.description ? <p>{action.description}</p> : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {message.response.sources.length > 0 ? (
                    <details className="chat-sources">
                      <summary>답변 출처</summary>
                      <DataSourceList sources={message.response.sources} />
                    </details>
                  ) : null}
                  {message.response.limitations.length > 0 ? (
                    <ul className="chat-limitations">
                      {message.response.limitations.map((limitation) => (
                        <li key={limitation}>{limitation}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ))}
        {loading ? (
          <div className="chat-row chat-row-assistant" role="status">
            <div className="chat-avatar" aria-hidden="true">
              돈
            </div>
            <div className="chat-message chat-message-assistant typing-indicator">
              <span />
              <span />
              <span />
              <small>Mock 답변을 만들고 있어요</small>
            </div>
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>

      <div className="question-chips" aria-label="추천 질문">
        {questions.map((question) => (
          <button key={question} type="button" onClick={() => void sendMessage(question)} disabled={loading}>
            {question}
          </button>
        ))}
      </div>

      {error ? (
        <p className="chat-error" role="alert">
          {error}
        </p>
      ) : null}

      <form className="chat-form" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor={inputId}>
          상담 질문
        </label>
        <textarea
          id={inputId}
          ref={inputRef}
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
        <button type="submit" className="chat-send" disabled={loading || !draft.trim()} aria-label="질문 보내기">
          <span aria-hidden="true">↑</span>
        </button>
      </form>
      {!companyId ? (
        <p className="chat-company-help">
          특정 회사에 관해 질문하려면 <Link href="/companies">사업장을 먼저 검색해 선택</Link>하세요.
        </p>
      ) : null}
    </div>
  );
}
