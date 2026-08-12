"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ActionChecklist } from "@/components/common/ActionChecklist";
import { DataFreshnessNotice } from "@/components/common/DataFreshnessNotice";
import { ErrorState, LimitationNotice, LoadingSkeleton } from "@/components/common/AsyncStates";
import { RiskInformationCard } from "@/components/risk/RiskInformationCard";
import type { Company } from "@/domain/company";
import type { CompanyRiskResult } from "@/domain/risk";
import { readApiResponse } from "@/utils/clientApi";

export function CompanyDetail({ company, dataMode }: { company: Company; dataMode: "mock" | "real" }) {
  const router = useRouter();
  const [risk, setRisk] = useState<CompanyRiskResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    const params = new URLSearchParams({ company_id: company.company_id, prompt: question });
    router.push(`/chat?${params.toString()}`);
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
              <span className="demo-pill">{dataMode === "real" ? "DB 연결 사업장" : "데모 사업장"}</span>
              <h1>{company.company_name}</h1>
              <div className="detail-tags">
                <span>{company.region ?? "지역 정보 없음"}</span>
                <span>{company.industry ?? "업종 정보 없음"}</span>
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
              targetMonth={risk.target_month}
            />
            <div className="risk-grid">
              <RiskInformationCard
                kind="wage"
                data={risk.wage_risk}
                dataAsOf={risk.data_as_of}
                sources={risk.sources.filter((source) => source.category === "wage")}
                onAsk={ask}
              />
              <RiskInformationCard
                kind="safety"
                data={risk.safety_context}
                dataAsOf={risk.safety_context.target_end ?? risk.data_as_of}
                sources={risk.sources.filter((source) => source.category === "safety")}
                onAsk={ask}
              />
            </div>
            <LimitationNotice>
              <strong>결과를 하나의 점수로 합치지 않습니다.</strong>
              <p>
                임금 공개 판정과 산업재해 공표 우선순위는 서로 다른 모델 결과입니다. 산업재해 신호는 검증된
                사업장 연결을 거쳤더라도 사고 확률이나 안전 판정이 아니며, 두 결과 모두 입사 여부를 확정하지 않습니다.
              </p>
            </LimitationNotice>

            <div className="detail-section">
              <ActionChecklist />
            </div>

            <section className="detail-section next-action-section" aria-labelledby="next-action-title">
              <div className="section-heading section-heading-left">
                <span className="eyebrow">다음 단계</span>
                <h2 id="next-action-title">상세 기능은 필요한 화면에서 이어가세요</h2>
                <p>사업장 상세는 신호와 체크리스트에 집중하고, 상담과 계약서 검토는 별도 화면에서 진행합니다.</p>
              </div>
              <div className="next-action-grid">
                <Link
                  href={`/chat?${new URLSearchParams({ company_id: company.company_id }).toString()}`}
                  className="next-action-card"
                >
                  <span aria-hidden="true">AI</span>
                  <div>
                    <strong>이 사업장을 기준으로 AI 상담</strong>
                    <p>같은 공식 근거를 사용한 두 모델의 답변과 한계를 비교합니다.</p>
                  </div>
                  <b aria-hidden="true">→</b>
                </Link>
                <Link href="/contracts" className="next-action-card">
                  <span aria-hidden="true">✓</span>
                  <div>
                    <strong>근로계약서 별도 검토</strong>
                    <p>파일을 올려 확인·누락·추가 검토 항목을 구조적으로 살펴봅니다.</p>
                  </div>
                  <b aria-hidden="true">→</b>
                </Link>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
