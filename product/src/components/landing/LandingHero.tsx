import Link from "next/link";

export function LandingHero() {
  return (
    <section className="hero-section">
      <div className="shell hero-grid">
        <div className="hero-copy">
          <span className="eyebrow">구직자와 근로자를 위한 AI 노동 정보</span>
          <h1>
            일하기 전에도,
            <br />
            일하는 중에도 <mark>돈워리</mark>
          </h1>
          <p>
            공공데이터 기반 고용 신호와 공식 노동 정보를 연결해, 입사 전과 재직 중 확인해야 할 정보를
            안내합니다.
          </p>
          <div className="hero-actions">
            <Link href="/companies" className="button button-dark button-large">
              사업장 확인하기
              <span aria-hidden="true">→</span>
            </Link>
            <Link href="/chat" className="button button-ghost button-large">
              일반 노동 상담
            </Link>
          </div>
          <p className="hero-disclaimer">
            회사의 안전·위법 여부나 입사 결정을 확정하지 않고, 확인할 정보와 행동을 안내합니다.
          </p>
        </div>
        <div className="hero-visual" aria-label="돈워리 서비스 화면 예시">
          <div className="floating-chip chip-top">확률 대신 확인할 정보</div>
          <div className="demo-window">
            <div className="demo-window-top">
              <span />
              <span />
              <span />
              <small>돈워리 사업장 확인</small>
            </div>
            <div className="demo-company">
              <div className="demo-logo">OO</div>
              <div>
                <strong>OO건설</strong>
                <span>인천광역시 · 건설업</span>
              </div>
            </div>
            <div className="demo-signal-grid">
              <div className="demo-signal">
                <small>임금 지급 관련</small>
                <strong>추가 확인 권장</strong>
                <span>고용 변동을 확인하세요</span>
              </div>
              <div className="demo-signal demo-signal-warn">
                <small>지역·업종 산재 신호</small>
                <strong>우선 확인 필요</strong>
                <span>현장 안전조치를 물어보세요</span>
              </div>
            </div>
            <div className="demo-chat-bubble">입사 전에 무엇을 확인해야 하나요?</div>
          </div>
          <div className="floating-chip chip-bottom">공식 자료 기반 행동 가이드</div>
        </div>
      </div>
    </section>
  );
}
