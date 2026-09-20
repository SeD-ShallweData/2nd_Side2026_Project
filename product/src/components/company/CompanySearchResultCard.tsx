import { FavoriteButton } from "@/components/favorite/FavoriteButton";
import type { FavoriteEligibility } from "@/components/favorite/favoriteAuth";
import type { CompanySearchResult } from "@/domain/company";

const MATCH_LABEL = {
  exact: "정확히 일치",
  normalized: "표기 정규화 일치",
  partial: "일부 일치",
  alias: "다른 표기 일치",
} as const;

export function CompanySearchResultCard({
  company,
  onSelect,
  query = "",
  isFavorite,
  favoriteEligibility,
  onFavoriteChange,
}: {
  company: CompanySearchResult;
  onSelect: (companyId: string) => void;
  /** 이름으로 찾은 것이 아니면 비어 있다. 일치 표시를 붙일지 정하는 데 쓴다. */
  query?: string;
  isFavorite: boolean;
  favoriteEligibility: FavoriteEligibility;
  onFavoriteChange: (companyId: string, isFavorite: boolean) => void;
}) {
  return (
    <article className="company-result-card">
      <div className="company-result-main">
        <div className="company-avatar" aria-hidden="true">
          {company.company_name.slice(0, 2)}
        </div>
        <div>
          <div className="company-title-row">
            <h3>{company.company_name}</h3>
            {/* 지역만 골라 찾은 결과에는 이름 일치 여부가 없다. 검색어가 있을 때만 붙인다. */}
            {query ? <span className="match-label">{MATCH_LABEL[company.match_type]}</span> : null}
          </div>
          <dl className="company-meta-list">
            <div>
              <dt>지역</dt>
              <dd>{company.region ?? "정보 없음"}</dd>
            </div>
            <div>
              <dt>업종</dt>
              <dd>{company.industry ?? "정보 없음"}</dd>
            </div>
          </dl>
        </div>
      </div>
      <div className="company-result-actions">
        <button
          type="button"
          className="button button-dark"
          onClick={() => onSelect(company.company_id)}
          aria-label={`${company.company_name}, ${company.region ?? "지역 정보 없음"}, ${company.industry ?? "업종 정보 없음"} 선택`}
        >
          이 사업장 선택
        </button>
        <FavoriteButton
          companyId={company.company_id}
          companyName={company.company_name}
          initialIsFavorite={isFavorite}
          eligibility={favoriteEligibility}
          onChange={onFavoriteChange}
        />
      </div>
    </article>
  );
}
