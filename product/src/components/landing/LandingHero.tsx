import Link from "next/link";

export function LandingHero() {
  return (
    <section className="refresh-hero" aria-labelledby="home-title">
      <div className="shell refresh-hero-grid">
        <div className="refresh-hero-copy">
          <span className="eyebrow">구직자와 근로자를 위한 AI 노동 정보</span>
          <h1 id="home-title">
            <span>일하기 전에도, 일하는 중에도</span>
            <mark>미리 대비하는 <span className="refresh-brand-word">Co끼리</span></mark>
          </h1>
          <p>사업장의 공개 정보부터 계약서, 노동 상담까지. 막막했던 확인을 한곳에서 시작하세요.</p>
          <div className="refresh-button-row">
            <Link href="/companies" className="button button-dark button-large">무료로 위험카드 보기 <span aria-hidden="true">→</span></Link>
            <Link href="/chat" className="button button-light button-large">AI 상담 먼저 해보기</Link>
          </div>
          <dl className="refresh-hero-facts">
            <div><dt>위험 정보</dt><dd>두 카드로 분리</dd></div>
            <div><dt>공식 근거</dt><dd>출처와 기준일 표시</dd></div>
            <div><dt>결론 대신</dt><dd>확인할 행동 안내</dd></div>
          </dl>
        </div>

        <div className="refresh-hero-visual" aria-label="Co끼리 위험카드 화면 예시">
          <span className="refresh-demo-label">화면 예시</span>
          <div className="refresh-demo-window">
            <div className="refresh-demo-bar"><i /><i /><i /><span>Co끼리 · 사업장 확인</span></div>
            <div className="refresh-demo-company">
              <b>OO</b><div><strong>OO건설</strong><span>인천광역시 · 건설업</span></div>
            </div>
            <div className="refresh-demo-cards">
              <article className="is-watch"><small>사업장 단위</small><strong>임금 지급 관련 정보</strong><em>추가 확인 권장</em><p>공개된 항목과 확인 질문을 살펴보세요.</p></article>
              <article className="is-review"><small>지역·업종 맥락</small><strong>산업재해 확인 신호</strong><em>우선 확인 필요</em><p>현장 안전조치와 교육 여부를 물어보세요.</p></article>
            </div>
          </div>
          <span className="refresh-float-chip refresh-chip-top">공개 데이터 기준일 표시</span>
          <span className="refresh-float-chip refresh-chip-bottom">공식 근거 기반 다음 행동</span>
        </div>
      </div>
    </section>
  );
}
