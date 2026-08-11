"use client";

import Link from "next/link";
import { ChangeEvent, FormEvent, useId, useRef, useState } from "react";
import type { DataMode } from "@/config/dataMode";
import type { ContractItem, ContractReviewResult } from "@/domain/contract";
import { readApiResponse } from "@/utils/clientApi";

const ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg"];
const MAX_SIZE = 10 * 1024 * 1024;

function ReviewSection({
  title,
  items,
  tone,
}: {
  title: string;
  items: ContractItem[];
  tone: "detected" | "missing" | "review";
}) {
  return (
    <section className={`contract-result-section contract-${tone}`}>
      <div className="contract-result-title">
        <span aria-hidden="true">{tone === "detected" ? "✓" : tone === "missing" ? "!" : "?"}</span>
        <h3>{title}</h3>
        <small>{items.length}개</small>
      </div>
      {items.length === 0 ? (
        <p className="muted-text">해당하는 항목이 없습니다.</p>
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

export function ContractReviewPanel({ dataMode }: { dataMode: DataMode }) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ContractReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
      setError("PDF, PNG, JPG 파일만 선택할 수 있습니다.");
      event.target.value = "";
      return;
    }
    if (next.size > MAX_SIZE) {
      setFile(null);
      setError("파일은 10MB 이하만 선택할 수 있습니다.");
      event.target.value = "";
      return;
    }
    setFile(next);
  }

  async function review(useDemo = false) {
    if (!file && !useDemo) {
      setError("검토할 계약서 파일을 먼저 선택해 주세요.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      if (file) form.append("file", file);
      if (useDemo) form.append("scenario_id", "default");
      const response = await fetch("/api/contracts/review", { method: "POST", body: form });
      setResult(await readApiResponse<ContractReviewResult>(response));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "계약서 검토 결과를 불러오지 못했습니다.");
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
            <h3>근로계약서 파일 선택</h3>
            <p>PDF, PNG, JPG · 최대 10MB</p>
          </div>
        </div>
        <label className="button button-outline" htmlFor={inputId}>
          파일 찾아보기
        </label>
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
              <small>{(file.size / 1024).toFixed(1)}KB · 영구 저장하지 않음</small>
            </div>
            <button type="button" onClick={reset} aria-label="선택한 파일 제거">
              ×
            </button>
          </div>
        ) : null}
        <div className="contract-actions">
          <button type="submit" className="button button-dark" disabled={loading || !file}>
            {loading ? "검토 중" : "선택한 파일 검토"}
          </button>
          {dataMode === "mock" ? (
            <button type="button" className="button button-ghost" onClick={() => void review(true)} disabled={loading}>
              파일 없이 데모 결과 보기
            </button>
          ) : null}
        </div>
        <p className="privacy-note">
          <span aria-hidden="true">🔒</span>
          {dataMode === "real"
            ? "업로드된 원문은 내부 문서 분석 API에 전달되며 제품 서버나 Git에 영구 저장하지 않습니다."
            : "업로드된 원문은 제품 서버나 Git에 영구 저장하지 않습니다. 데모 모드에서는 파일 내용도 분석하지 않습니다."}
        </p>
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
            <strong>계약서 검토 결과를 준비하고 있습니다</strong>
            <p>{dataMode === "real" ? "문서 인식과 조항별 규칙 검토를 순서대로 진행합니다." : "명시된 데모 시나리오 결과를 준비합니다."}</p>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="contract-results" aria-live="polite">
          <div className="contract-results-head">
            <div>
              <span className="demo-pill">
                {result.analysis_status === "mocked" ? "MOCK 결과" : result.analysis_status === "partial" ? "부분 분석" : "실제 분석"}
              </span>
              <h2>기본 항목 확인 결과</h2>
            </div>
            <button type="button" className="text-button" onClick={reset}>
              다른 파일 확인
            </button>
          </div>
          <div className="contract-result-grid">
            <ReviewSection title="확인됨" items={result.detected_items} tone="detected" />
            <ReviewSection title="누락 가능" items={result.missing_items} tone="missing" />
            <ReviewSection title="추가 확인" items={result.review_items} tone="review" />
          </div>
          {result.suggested_questions.length > 0 ? (
            <div className="contract-questions">
              <h3>회사에 이렇게 물어보세요</h3>
              <ul>
                {result.suggested_questions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {[...result.warnings, ...result.limitations].length > 0 ? (
            <div className="contract-warning">
              <strong>검토 한계</strong>
              <ul>
                {[...result.warnings, ...result.limitations].map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="contract-followup">
            <div>
              <strong>결과를 이해하기 어려운가요?</strong>
              <p>검토 결과를 법률 확정판정으로 보지 말고, 궁금한 항목을 공식 근거 기반 AI 상담에서 이어서 물어보세요.</p>
            </div>
            <Link href="/chat?mode=contract&amp;prompt=근로계약서+검토+결과에서+확인+필요+항목을+어떻게+질문해야+하나요%3F" className="button button-outline">
              AI 상담으로 이어가기
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
