import Link from "next/link";

export default function NotFoundPage() {
  return (
    <div className="page-section">
      <div className="shell narrow-shell">
        <div className="state-card not-found-card">
          <span className="state-icon" aria-hidden="true">
            ?
          </span>
          <h1>요청한 사업장을 찾을 수 없습니다</h1>
          <p>사업장 검색에서 이름, 지역, 업종을 다시 확인해 주세요.</p>
          <Link href="/companies" className="button button-dark">
            사업장 다시 검색
          </Link>
        </div>
      </div>
    </div>
  );
}
