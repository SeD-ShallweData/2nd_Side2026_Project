import Link from "next/link";

const FEATURES = [
  {
    number: "01",
    title: "사업장 신뢰 정보 확인",
    description: "동명이인 사업장을 주소와 업종으로 구분하고 임금·산재 신호를 따로 확인합니다.",
    icon: "⌕",
  },
  {
    number: "02",
    title: "노동법·신고 절차 상담",
    description: "회사 컨텍스트와 공식 노동 정보를 연결해 지금 확인하고 행동할 순서를 안내합니다.",
    icon: "…",
  },
  {
    number: "03",
    title: "근로계약서 확인",
    description: "기본 명시 항목과 추가로 회사에 질문할 내용을 빠르게 점검합니다.",
    icon: "✓",
  },
] as const;

export function FeatureSection() {
  return (
    <section className="section feature-section" aria-labelledby="feature-title">
      <div className="shell">
        <div className="section-heading">
          <span className="eyebrow">돈워리가 돕는 세 가지</span>
          <h2 id="feature-title">판정 대신, 확인할 정보를 선명하게</h2>
          <p>서로 다른 데이터를 섞지 않고 사용자에게 필요한 다음 행동까지 연결합니다.</p>
        </div>
        <div className="feature-grid">
          {FEATURES.map((feature) => (
            <article className="feature-card" key={feature.number}>
              <div className="feature-icon" aria-hidden="true">
                {feature.icon}
              </div>
              <small>{feature.number}</small>
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function HowItWorks() {
  return (
    <section className="section how-section" aria-labelledby="how-title">
      <div className="shell how-grid">
        <div className="how-copy">
          <span className="eyebrow">간단한 이용 흐름</span>
          <h2 id="how-title">회사명을 찾고, 확인하고, 물어보세요</h2>
          <p>
            실제 ML과 LLM이 연결되지 않은 현재 프로토타입에서도 전체 흐름을 Mock 데이터로 체험할 수 있습니다.
          </p>
          <Link href="/companies" className="text-link">
            데모 시작하기 <span aria-hidden="true">→</span>
          </Link>
        </div>
        <ol className="step-list">
          <li>
            <span>1</span>
            <div>
              <strong>정확한 사업장 선택</strong>
              <p>이름이 같아도 주소와 업종을 확인해 직접 선택합니다.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>서로 다른 신호 확인</strong>
              <p>임금 지급 관련 정보와 지역·업종 산업재해 정보를 분리해 봅니다.</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>행동 가이드로 연결</strong>
              <p>챗봇, 체크리스트, 계약서 검토로 무엇을 물어볼지 정리합니다.</p>
            </div>
          </li>
        </ol>
      </div>
    </section>
  );
}

export function FinalCta() {
  return (
    <section className="section cta-section">
      <div className="shell cta-card">
        <div>
          <span className="eyebrow">지금 바로 확인해 보세요</span>
          <h2>내가 일할 곳, 무엇을 확인해야 할까요?</h2>
          <p>확률이나 단정 대신 공개 데이터의 관측 신호와 구체적인 질문 목록을 제공합니다.</p>
        </div>
        <Link href="/companies" className="button button-dark button-large">
          사업장 확인하기 <span aria-hidden="true">→</span>
        </Link>
      </div>
    </section>
  );
}
