"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ActionChecklist } from "@/components/common/ActionChecklist";
import { DataFreshnessNotice } from "@/components/common/DataFreshnessNotice";
import { ErrorState, LimitationNotice, LoadingSkeleton } from "@/components/common/AsyncStates";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ContractReviewPanel } from "@/components/contract/ContractReviewPanel";
import { RiskInformationCard } from "@/components/risk/RiskInformationCard";
import type { Company } from "@/domain/company";
import type { CompanyRiskResult } from "@/domain/risk";
import { readApiResponse } from "@/utils/clientApi";

export function CompanyDetail({ company }: { company: Company }) {
  const [risk, setRisk] = useState<CompanyRiskResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chatPrompt, setChatPrompt] = useState("");
  const chatRef = useRef<HTMLElement>(null);

  async function loadRisk(signal?: AbortSignal) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/companies/${encodeURIComponent(company.company_id)}/risk`, { signal });
      setRisk(await readApiResponse<CompanyRiskResult>(response));
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "사업장 정보를 불러오지 못했습니다.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/companies/${encodeURIComponent(company.company_id)}/risk`, { signal: controller.signal })
      .then((response) => readApiResponse<CompanyRiskResult>(response))
      .then((data) => setRisk(data))
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "사업장 정보를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [company.company_id]);

  function ask(question: string) {
    setChatPrompt(question);
    window.setTimeout(() => chatRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  return (
    <div className="detail-page">
      <section className="detail-hero">
        <div className="shell">
          <div className="detail-breadcrumb">
            <Link href="/companies">사업장 검색</Link>
            <span aria-hidden="true">/</span>
            <span>상세 정보</span>
          </div>
          <div className="detail-company-row">
            <div className="company-avatar company-avatar-large" aria-hidden="true">
              {company.company_name.slice(0, 2)}
            </div>
            <div className="detail-company-copy">
              <span className="demo-pill">데모 사업장</span>
              <h1>{company.company_name}</h1>
              <p>{company.address}</p>
              <div className="detail-tags">
                <span>{company.region}</span>
                <span>{company.industry}</span>
                <span>{company.size_label}</span>
              </div>
            </div>
            <Link href="/companies" className="button button-outline change-company">
              사업장 변경
            </Link>
          </div>
        </div>
      </section>

      <div className="shell detail-content">
        {loading ? <LoadingSkeleton label="임금·산업재해 신호를 불러오고 있습니다." /> : null}
        {!loading && error ? <ErrorState message={error} onRetry={() => void loadRisk()} /> : null}
        {!loading && risk ? (
          <>
            <DataFreshnessNotice
              freshness={risk.freshness}
              dataAsOf={risk.data_as_of}
              validUntil={risk.valid_until}
            />
            <div className="risk-grid">
              <RiskInformationCard
                kind="wage"
                data={risk.wage_risk}
                dataAsOf={risk.data_as_of}
                sources={risk.sources.filter((source) => !source.name.includes("산업재해"))}
                onAsk={ask}
              />
              <RiskInformationCard
                kind="safety"
                data={risk.safety_context}
                dataAsOf={risk.data_as_of}
                sources={risk.sources.filter((source) => source.name.includes("산업재해"))}
                onAsk={ask}
              />
            </div>
            <LimitationNotice>
              <strong>결과를 하나의 점수로 합치지 않습니다.</strong>
              <p>
                임금 정보는 사업장 단위, 산업재해 정보는 지역·업종 단위입니다. 두 결과 모두 입사나 안전 여부를
                확정하지 않습니다.
              </p>
            </LimitationNotice>

            <section ref={chatRef} className="detail-section scroll-target" aria-labelledby="company-chat-title">
              <div className="section-heading section-heading-left">
                <span className="eyebrow">회사 컨텍스트 상담</span>
                <h2 id="company-chat-title">이 결과, 어떻게 확인하면 좋을까요?</h2>
                <p>선택한 사업장의 Mock 결과만 사용해 확인할 질문과 행동을 안내합니다.</p>
              </div>
              <ChatPanel
                key={chatPrompt || "company-chat"}
                companyId={company.company_id}
                companyName={company.company_name}
                suggestedPrompt={chatPrompt}
              />
            </section>

            <div className="detail-section">
              <ActionChecklist />
            </div>

            <section className="detail-section" aria-labelledby="contract-title">
              <div className="section-heading section-heading-left">
                <span className="eyebrow">근로계약서 확인</span>
                <h2 id="contract-title">계약서에서 빠진 기본 항목을 확인하세요</h2>
                <p>현재 Mock Mode에서는 파일 내용을 서버에 저장하거나 실제로 분석하지 않습니다.</p>
              </div>
              <ContractReviewPanel />
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
