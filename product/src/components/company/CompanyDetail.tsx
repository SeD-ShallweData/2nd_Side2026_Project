"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ActionChecklist } from "@/components/common/ActionChecklist";
import { DataFreshnessNotice } from "@/components/common/DataFreshnessNotice";
import { EmptyState, ErrorState, LimitationNotice, LoadingSkeleton } from "@/components/common/AsyncStates";
import { FavoriteButton } from "@/components/favorite/FavoriteButton";
import { getFavoriteEligibility } from "@/components/favorite/favoriteAuth";
import { describeFavoriteError } from "@/components/favorite/favoriteErrorMessage";
import { RiskInformationCard } from "@/components/risk/RiskInformationCard";
import type { SessionResponse } from "@/app/api/auth/authApiContract";
import type { Company } from "@/domain/company";
import type { CompanyRiskResult } from "@/domain/risk";
import { getSession } from "@/services/authClient";
import { getFavorites } from "@/services/favoriteClient";
import { readApiResponse } from "@/utils/clientApi";
import { publicClientHeaders } from "@/utils/publicClientId";
import { useMessages } from "@/i18n/LocaleProvider";
import { companyMessages } from "@/i18n/messages/company";
import { favoriteMessages } from "@/i18n/messages/favorite";

type FavoriteStatus =
  | { companyId: string; status: "loading" }
  | { companyId: string; status: "error"; message: string }
  | { companyId: string; status: "ready"; isFavorite: boolean };

export function CompanyDetail({ company, dataMode }: { company: Company; dataMode: "mock" | "real" }) {
  const router = useRouter();
  const cm = useMessages(companyMessages);
  const fm = useMessages(favoriteMessages);
  const m = cm.detail;
  const loadFailed = m.loadFailed;
  const [risk, setRisk] = useState<CompanyRiskResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionResponse | "loading">("loading");
  const [favoriteStatus, setFavoriteStatus] = useState<FavoriteStatus>({ companyId: company.company_id, status: "loading" });
  const [favoriteReload, setFavoriteReload] = useState(0);
  const favorite = favoriteStatus.companyId === company.company_id
    ? favoriteStatus
    : { companyId: company.company_id, status: "loading" as const };

  useEffect(() => {
    const refreshAfterRestore = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setFavoriteStatus({ companyId: company.company_id, status: "loading" });
        setFavoriteReload((value) => value + 1);
      }
    };
    window.addEventListener("pageshow", refreshAfterRestore);
    return () => window.removeEventListener("pageshow", refreshAfterRestore);
  }, [company.company_id]);

  // 검색 결과와 마찬가지로 진입 시 즐겨찾기 목록을 한 번 조회해 이 사업장의
  // 선택 상태만 뽑아 쓴다. 로그인하지 않았거나 일반 사용자가 아니면 건너뛴다.
  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();
    async function loadFavorite() {
      try {
        const result = await getSession({ signal: controller.signal });
        if (ignore) return;
        setSession(result);
        const isFavorite = result.authenticated && result.user.role === "user"
          ? (await getFavorites({ signal: controller.signal })).items.some((item) => item.company_id === company.company_id)
          : false;
        if (!ignore) setFavoriteStatus({ companyId: company.company_id, status: "ready", isFavorite });
      } catch (caught) {
        if (ignore || (caught instanceof DOMException && caught.name === "AbortError")) return;
        setFavoriteStatus({ companyId: company.company_id, status: "error", message: describeFavoriteError(caught, fm.errors) });
      }
    }
    void loadFavorite();
    return () => {
      ignore = true;
      controller.abort();
    };
    // 번역 사전은 렌더마다 새 객체일 수 있다. 사업장이 바뀌거나 재시도할 때만 조회한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.company_id, favoriteReload]);

  async function loadRisk(signal?: AbortSignal) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/companies/${encodeURIComponent(company.company_id)}/risk`, {
        signal,
        headers: publicClientHeaders(),
      });
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
    // 회사 조회 한도를 탭 표시값별로 세므로 검색 화면과 같은 표시값을 보낸다(server/publicRateLimit.ts).
    fetch(`/api/companies/${encodeURIComponent(company.company_id)}/risk`, {
      signal: controller.signal,
      headers: publicClientHeaders(),
    })
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
            {favorite.status === "loading" ? <span className="detail-favorite-status" role="status">{fm.view.loading}</span>
              : favorite.status === "error" ? <div className="detail-favorite-status"><p className="field-error" role="alert">{favorite.message}</p><button type="button" className="button button-outline" onClick={() => { setFavoriteStatus({ companyId: company.company_id, status: "loading" }); setFavoriteReload((value) => value + 1); }}>{cm.search.retry}</button></div>
                : <FavoriteButton
                  key={company.company_id}
                  companyId={company.company_id}
                  companyName={company.company_name}
                  initialIsFavorite={favorite.isFavorite}
                  eligibility={getFavoriteEligibility(session)}
                  onChange={(_, nextIsFavorite) => setFavoriteStatus({ companyId: company.company_id, status: "ready", isFavorite: nextIsFavorite })}
                />}
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
