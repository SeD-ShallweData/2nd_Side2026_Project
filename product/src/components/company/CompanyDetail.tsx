"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ActionChecklist } from "@/components/common/ActionChecklist";
import { DataFreshnessNotice } from "@/components/common/DataFreshnessNotice";
import { EmptyState, ErrorState, LimitationNotice, LoadingSkeleton } from "@/components/common/AsyncStates";
import { FavoriteButton } from "@/components/favorite/FavoriteButton";
import { getFavoriteEligibility } from "@/components/favorite/favoriteAuth";
import { RiskInformationCard } from "@/components/risk/RiskInformationCard";
import type { SessionResponse } from "@/app/api/auth/authApiContract";
import type { Company } from "@/domain/company";
import type { CompanyRiskResult } from "@/domain/risk";
import { getSession } from "@/services/authClient";
import { getFavorites } from "@/services/favoriteClient";
import { readApiResponse } from "@/utils/clientApi";
import { useMessages } from "@/i18n/LocaleProvider";
import { companyMessages } from "@/i18n/messages/company";

export function CompanyDetail({ company, dataMode }: { company: Company; dataMode: "mock" | "real" }) {
  const router = useRouter();
  const cm = useMessages(companyMessages);
  const m = cm.detail;
  const loadFailed = m.loadFailed;
  const [risk, setRisk] = useState<CompanyRiskResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionResponse | "loading">("loading");
  const [isFavorite, setIsFavorite] = useState(false);

  // 검색 결과와 마찬가지로 진입 시 즐겨찾기 목록을 한 번 조회해 이 사업장의
  // 선택 상태만 뽑아 쓴다. 로그인하지 않았거나 일반 사용자가 아니면 건너뛴다.
  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();
    getSession({ signal: controller.signal })
      .then((result) => {
        if (ignore) return;
        setSession(result);
        if (result.authenticated && result.user.role === "user") {
          return getFavorites({ signal: controller.signal }).then((favorites) => {
            if (!ignore) {
              setIsFavorite(favorites.items.some((item) => item.company_id === company.company_id));
            }
          });
        }
        return undefined;
      })
      .catch((caught: unknown) => {
        if (ignore || (caught instanceof DOMException && caught.name === "AbortError")) return;
        setSession({ authenticated: false, user: null, expires_at: null });
      });
    return () => {
      ignore = true;
      controller.abort();
    };
  }, [company.company_id]);

  async function loadRisk(signal?: AbortSignal) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/companies/${encodeURIComponent(company.company_id)}/risk`, { signal });
      setRisk(await readApiResponse<CompanyRiskResult>(response));
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : loadFailed);
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
        setError(caught instanceof Error ? caught.message : loadFailed);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // 문구 사전은 렌더마다 새 객체일 수 있어 의존성에 넣지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            <Link href="/companies">{m.breadcrumbSearch}</Link>
            <span aria-hidden="true">/</span>
            <span>{m.breadcrumbDetail}</span>
          </div>
          <div className="detail-company-row">
            <div className="company-avatar company-avatar-large" aria-hidden="true">
              {company.company_name.slice(0, 2)}
            </div>
            <div className="detail-company-copy">
              <span className="demo-pill">{dataMode === "real" ? m.pillReal : m.pillDemo}</span>
              <h1>{company.company_name}</h1>
              <div className="detail-tags">
                <span>{company.region ?? cm.card.noRegion}</span>
                <span>{company.industry ?? cm.card.noIndustry}</span>
              </div>
            </div>
            <Link href="/companies" className="button button-outline change-company">
              {m.change}
            </Link>
            <FavoriteButton
              companyId={company.company_id}
              companyName={company.company_name}
              initialIsFavorite={isFavorite}
              eligibility={getFavoriteEligibility(session)}
              onChange={(_, nextIsFavorite) => setIsFavorite(nextIsFavorite)}
            />
          </div>
        </div>
      </section>

      <div className="shell detail-content">
        {loading ? <LoadingSkeleton label={m.loading} /> : null}
        {!loading && error ? <ErrorState message={error} onRetry={() => void loadRisk()} /> : null}
        {!loading && !error && !risk ? (
          <EmptyState
            title={m.emptyTitle}
            description={m.emptyDescription}
          />
        ) : null}
        {!loading && risk ? (
          <>
            <DataFreshnessNotice
              dataAsOf={risk.data_as_of}
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
              <strong>{m.limitTitle}</strong>
              <p>{m.limitBody}</p>
            </LimitationNotice>

            <div className="detail-section">
              <ActionChecklist />
            </div>

            <section className="detail-section next-action-section" aria-labelledby="next-action-title">
              <div className="section-heading section-heading-left">
                <span className="eyebrow">{m.nextEyebrow}</span>
                <h2 id="next-action-title">{m.nextTitle}</h2>
                <p>{m.nextBody}</p>
              </div>
              <div className="next-action-grid">
                <Link
                  href={`/chat?${new URLSearchParams({ company_id: company.company_id }).toString()}`}
                  className="next-action-card"
                >
                  <span aria-hidden="true">AI</span>
                  <div>
                    <strong>{m.chatTitle}</strong>
                    <p>{m.chatBody}</p>
                  </div>
                  <b aria-hidden="true">→</b>
                </Link>
                <Link href="/contracts" className="next-action-card">
                  <span aria-hidden="true">✓</span>
                  <div>
                    <strong>{m.contractTitle}</strong>
                    <p>{m.contractBody}</p>
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
