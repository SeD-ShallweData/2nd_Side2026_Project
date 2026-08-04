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
}: {
  company: CompanySearchResult;
  onSelect: (companyId: string) => void;
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
            <span className="match-label">{MATCH_LABEL[company.match_type]}</span>
          </div>
          <p className="company-address">{company.address}</p>
          <dl className="company-meta-list">
            <div>
              <dt>지역</dt>
              <dd>{company.region}</dd>
            </div>
            <div>
              <dt>업종</dt>
              <dd>{company.industry}</dd>
            </div>
            <div>
              <dt>규모</dt>
              <dd>{company.size_label}</dd>
            </div>
          </dl>
        </div>
      </div>
      <button
        type="button"
        className="button button-dark"
        onClick={() => onSelect(company.company_id)}
        aria-label={`${company.company_name}, ${company.address} 선택`}
      >
        이 사업장 선택
      </button>
    </article>
  );
}
