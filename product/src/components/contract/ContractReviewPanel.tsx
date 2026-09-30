"use client";

import Link from "next/link";
import { ChangeEvent, FormEvent, useId, useRef, useState } from "react";
import type { DataMode } from "@/config/dataMode";
import { format } from "@/i18n/defineMessages";
import { useLocale, useMessages } from "@/i18n/LocaleProvider";
import { contractMessages } from "@/i18n/messages/contract";
import {
  localizeContractReview,
  type LocalizedContractItem,
  type LocalizedText,
} from "@/i18n/contractVerdict";
import type { ContractItem, ContractReviewResult } from "@/domain/contract";
import {
  CONTRACT_REVIEW_CONTEXT_STORAGE_KEY,
  toContractReviewContext,
  type StoredContractReviewContext,
} from "@/domain/contractReviewContext";
import { readApiResponse } from "@/utils/clientApi";
import { publicClientHeaders } from "@/utils/publicClientId";

const ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg"];

/** 진단 결과 요약만 이 탭에 잠시 둔다. 원본 파일·추출 원문·파일명은 넣지 않는다. */
function rememberReviewForChat(result: ContractReviewResult): boolean {
  const context = toContractReviewContext(result);
  try {
    if (!context) {
      window.sessionStorage.removeItem(CONTRACT_REVIEW_CONTEXT_STORAGE_KEY);
      return false;
    }
    const stored: StoredContractReviewContext = { saved_at: Date.now(), context };
    window.sessionStorage.setItem(CONTRACT_REVIEW_CONTEXT_STORAGE_KEY, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}
const MAX_SIZE = 15 * 1024 * 1024;

/** 상담 입력창에 미리 채울 질문. 공백은 +로 둔다. */
function chatPromptQuery(prompt: string): string {
  return encodeURIComponent(prompt).replace(/%20/g, "+");
}

function ReviewSection({
  title,
  items,
  tone,
}: {
  title: string;
  items: ContractItem[];
  tone: "detected" | "missing" | "review";
}) {
  const m = useMessages(contractMessages).panel;
  return (
    <section className={`contract-result-section contract-${tone}`}>
      <div className="contract-result-title">
        <span aria-hidden="true">{tone === "detected" ? "✓" : tone === "missing" ? "!" : "?"}</span>
        <h3>{title}</h3>
        <small>{format(m.itemCount, { count: items.length })}</small>
      </div>
      {items.length === 0 ? (
        <p className="muted-text">{m.empty}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.code}>
              <strong>{item.label}</strong>
              <p>{item.description}</p>
              {item.legal_basis ? <small>{item.legal_basis}</small> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/*
 * 외국어 화면의 결과 구역. 항목 이름·안내는 고정 사전 문장이고, 숫자가 든 설명은
 * 한국어 원문으로 함께 둔다(회사·지원센터에 그대로 보여 줄 수 있게).
 */
function LocalizedReviewSection({
  title,
  items,
  tone,
  koreanLabel,
}: {
  title: string;
  items: LocalizedContractItem[];
  tone: "detected" | "missing" | "review";
  koreanLabel: string;
}) {
  const m = useMessages(contractMessages).panel;
  return (
    <section className={`contract-result-section contract-${tone}`}>
      <div className="contract-result-title">
        <span aria-hidden="true">{tone === "detected" ? "✓" : tone === "missing" ? "!" : "?"}</span>
        <h3>{title}</h3>
        <small>{format(m.itemCount, { count: items.length })}</small>
      </div>
      {items.length === 0 ? (
        <p className="muted-text">{m.empty}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.code}>
              <strong>{item.label}</strong>
              {item.about ? <p>{item.about}</p> : null}
              <p className="contract-korean-original" lang="ko">
                {item.translated ? <span>{koreanLabel} · {item.korean_label}</span> : null}
                {item.korean_description}
              </p>
              {item.legal_basis ? <small>{item.legal_basis}</small> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LocalizedLine({ line, koreanLabel }: { line: LocalizedText; koreanLabel: string }) {
  return (
    <li>
      {line.text}
      {line.korean ? (
        <span className="contract-korean-original" lang="ko">
          <span>{koreanLabel}</span>
          {line.korean}
        </span>
      ) : null}
    </li>
  );
}

export function ContractReviewPanel({ dataMode }: { dataMode: DataMode }) {
  const m = useMessages(contractMessages).panel;
  const locale = useLocale();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ContractReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [chatLinkReady, setChatLinkReady] = useState(false);

  // 한국어·쉬운 한국어 화면에서는 null 이라 서버의 한국어 결과를 그대로 그린다.
  const localized = result ? localizeContractReview(result, locale) : null;

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0] ?? null;
    setResult(null);
    setError(null);
    if (!next) {
      setFile(null);
      return;
    }
    if (!ALLOWED_TYPES.includes(next.type)) {
      setFile(null);
      setError(m.typeError);
      event.target.value = "";
      return;
    }
    if (next.size > MAX_SIZE) {
      setFile(null);
      setError(m.sizeError);
      event.target.value = "";
      return;
    }
    setFile(next);
  }

  async function review(useDemo = false) {
    if (!file && !useDemo) {
      setError(m.noFile);
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setChatLinkReady(false);
    try {
      const form = new FormData();
      if (file) form.append("file", file);
      if (useDemo) form.append("scenario_id", "default");
      const response = await fetch("/api/contracts/review", {
        method: "POST",
        headers: publicClientHeaders(),
        body: form,
      });
      const reviewed = await readApiResponse<ContractReviewResult>(response);
      setResult(reviewed);
      setChatLinkReady(rememberReviewForChat(reviewed));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : m.reviewFailed);
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void review(false);
  }

  function reset() {
    setFile(null);
    setResult(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="contract-panel">
      <form className="contract-upload" onSubmit={handleSubmit}>
        <div className="upload-copy">
          <span className="upload-icon" aria-hidden="true">
            ↑
          </span>
          <div>
            <h3>{m.uploadTitle}</h3>
            <p>{m.uploadHint}</p>
          </div>
        </div>
        <input
          ref={inputRef}
          id={inputId}
          className="sr-only"
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
          onChange={handleFileChange}
        />
        {file ? (
          <div className="selected-file" role="status">
            <span aria-hidden="true">▤</span>
            <div>
              <strong>{file.name}</strong>
              <small>{format(m.fileMeta, { size: (file.size / 1024).toFixed(1) })}</small>
            </div>
            <button type="button" onClick={reset} aria-label={m.removeFileAria}>
              ×
            </button>
          </div>
        ) : null}
        <div className="contract-actions">
          {/* 고르기와 검토하기는 한 줄에 나란히 선다. 둘 중 하나를 누르면 되는
              자리라 위아래로 쌓으면 순서가 있는 것처럼 읽힌다. */}
          <label className="button button-dark" htmlFor={inputId}>
            {m.browse}
          </label>
          <button type="submit" className="button button-outline" disabled={loading || !file}>
            {loading ? m.reviewing : m.reviewSelected}
          </button>
          {dataMode === "mock" ? (
            <button type="button" className="button button-ghost" onClick={() => void review(true)} disabled={loading}>
              {m.demo}
            </button>
          ) : null}
        </div>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>

      {loading ? (
        <div className="contract-loading" role="status">
          <span className="spinner" aria-hidden="true" />
          <div>
            <strong>{m.loadingTitle}</strong>
            <p>{dataMode === "real" ? m.loadingReal : m.loadingMock}</p>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="contract-results" aria-live="polite">
          <div className="contract-results-head">
            <div>
              <span className="demo-pill">
                {result.analysis_status === "mocked" ? m.statusMocked : result.analysis_status === "partial" ? m.statusPartial : m.statusReal}
              </span>
              <h2>{m.resultsHeading}</h2>
            </div>
            <button type="button" className="text-button" onClick={reset}>
              {m.otherFile}
            </button>
          </div>
          {localized ? (
            <div className="contract-result-grid">
              <LocalizedReviewSection title={m.sectionDetected} items={localized.detected_items} tone="detected" koreanLabel={localized.korean_original_label} />
              <LocalizedReviewSection title={m.sectionMissing} items={localized.missing_items} tone="missing" koreanLabel={localized.korean_original_label} />
              <LocalizedReviewSection title={m.sectionReview} items={localized.review_items} tone="review" koreanLabel={localized.korean_original_label} />
            </div>
          ) : (
            <div className="contract-result-grid">
              <ReviewSection title={m.sectionDetected} items={result.detected_items} tone="detected" />
              <ReviewSection title={m.sectionMissing} items={result.missing_items} tone="missing" />
              <ReviewSection title={m.sectionReview} items={result.review_items} tone="review" />
            </div>
          )}
          {localized && localized.suggested_questions.length > 0 ? (
            <div className="contract-questions">
              <h3>{m.questionsHeading}</h3>
              <ul>
                {localized.suggested_questions.map((line, index) => (
                  <LocalizedLine key={`${index}-${line.text}`} line={line} koreanLabel={localized.korean_original_label} />
                ))}
              </ul>
            </div>
          ) : null}
          {localized && localized.notices.length > 0 ? (
            <div className="contract-warning">
              <strong>{m.limitsHeading}</strong>
              <ul>
                {localized.notices.map((line, index) => (
                  <LocalizedLine key={`${index}-${line.text}`} line={line} koreanLabel={localized.korean_original_label} />
                ))}
              </ul>
            </div>
          ) : null}
          {!localized && result.suggested_questions.length > 0 ? (
            <div className="contract-questions">
              <h3>{m.questionsHeading}</h3>
              <ul>
                {result.suggested_questions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {!localized && [...result.warnings, ...result.limitations].length > 0 ? (
            <div className="contract-warning">
              <strong>{m.limitsHeading}</strong>
              <ul>
                {[...result.warnings, ...result.limitations].map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="contract-followup">
            <div>
              <strong>{m.followupTitle}</strong>
              <p>
                {m.followupBody}
                {chatLinkReady ? m.followupLinked : ""}
              </p>
            </div>
            <Link
              href={chatLinkReady
                ? `/chat?mode=contract&contract_review=1&prompt=${chatPromptQuery(m.chatPromptWithReview)}`
                : `/chat?mode=contract&prompt=${chatPromptQuery(m.chatPromptGeneric)}`}
              className="button button-outline"
            >
              {m.followupCta}
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
