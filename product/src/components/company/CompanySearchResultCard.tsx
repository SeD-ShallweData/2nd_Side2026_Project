import { FavoriteButton } from "@/components/favorite/FavoriteButton";
import type { FavoriteEligibility } from "@/components/favorite/favoriteAuth";
import type { CompanySearchResult } from "@/domain/company";
import { format } from "@/i18n/defineMessages";
import { useMessages } from "@/i18n/LocaleProvider";
import { companyMessages } from "@/i18n/messages/company";

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
  const m = useMessages(companyMessages).card;
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
            {query ? <span className="match-label">{m.match[company.match_type]}</span> : null}
          </div>
          <dl className="company-meta-list">
            <div>
              <dt>{m.region}</dt>
              <dd>{company.region ?? m.noInfo}</dd>
            </div>
            <div>
              <dt>{m.industry}</dt>
              <dd>{company.industry ?? m.noInfo}</dd>
            </div>
          </dl>
        </div>
      </div>
      <div className="company-result-actions">
        <button
          type="button"
          className="button button-dark"
          onClick={() => onSelect(company.company_id)}
          aria-label={format(m.selectAria, {
            name: company.company_name,
            region: company.region ?? m.noRegion,
            industry: company.industry ?? m.noIndustry,
          })}
        >
          {m.select}
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
