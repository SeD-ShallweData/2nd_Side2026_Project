"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ActionChecklist } from "@/components/common/ActionChecklist";
import { DataFreshnessNotice } from "@/components/common/DataFreshnessNotice";
import { EmptyState, LimitationNotice } from "@/components/common/AsyncStates";
import { FavoriteButton } from "@/components/favorite/FavoriteButton";
import { getFavoriteEligibility } from "@/components/favorite/favoriteAuth";
import { RiskInformationCard } from "@/components/risk/RiskInformationCard";
import type { SessionResponse } from "@/app/api/auth/authApiContract";
import type { Company } from "@/domain/company";
import type { CompanyRiskResult } from "@/domain/risk";
import { getSession } from "@/services/authClient";
import { getFavorites } from "@/services/favoriteClient";

/*
 * 위험 신호는 서버 컴포넌트(app/companies/[companyId]/page.tsx)가 받아 props 로 내린다.
 * 전에는 이 컴포넌트가 마운트 후 /api/companies/{id}/risk 를 직접 불렀다.
 *
 * 브라우저가 그 경로를 부르지 않게 되어, 라우트를 외부에서 차단해도 화면이 산다.
 * risk 가 null 이면 분석 결과가 없거나 조회가 실패한 것이고, 아래에서 EmptyState 를 그린다.
 *
 * 즐겨찾기(session·isFavorite)는 로그인 상태에 따라 달라지므로 클라이언트에 남긴다.
 */
export function CompanyDetail({
  company,
  risk,
  dataMode,
}: {
  company: Company;
  risk: CompanyRiskResult | null;
  dataMode: "mock" | "real";
}) {
  const router = useRouter();
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
        {!risk ? (
          <EmptyState
            title="표시할 위험 정보가 없습니다"
            description="이 사업장은 아직 임금·산업재해 신호 분석 결과가 연결되지 않았습니다. 사업장 정보를 다시 확인하거나 다른 사업장을 검색해 보세요."
          />
        ) : null}
        {risk ? (
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
