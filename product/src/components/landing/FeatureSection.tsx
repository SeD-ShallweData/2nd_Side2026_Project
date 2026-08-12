import Link from "next/link";

const STEPS = [
  { number: "01", icon: "⌕", title: "사업장 확인", body: "회사명과 지역·업종으로 정확한 사업장을 선택합니다.", tag: "공개 데이터" },
  { number: "02", icon: "?", title: "확인 질문 정리", body: "임금과 산업안전 신호를 섞지 않고 확인할 질문을 봅니다.", tag: "두 가지 위험카드" },
  { number: "03", icon: "✓", title: "계약서 진단", body: "계약서에서 확인된 항목과 다시 물어볼 내용을 정리합니다.", tag: "원문 대조" },
] as const;

const WAGE_ITEMS = ["체불사업주 명단", "건강보험 체납 명단", "국민연금 가입자 (12개월)", "이직률 (12개월)", "1인당 고지금액", "고용 추이", "업종 폐업률", "데이터 충실도"] as const;

export function FeatureSection() {
  return (
    <section className="section refresh-flow" aria-labelledby="flow-title">
      <div className="shell">
        <div className="section-heading"><span className="eyebrow">돈워리 이용 흐름</span><h2 id="flow-title">확인하고, 질문하고, 대비하세요</h2><p>입사 전부터 문제가 생긴 뒤까지 필요한 확인을 순서대로 연결합니다.</p></div>
        <div className="refresh-step-grid">
          {STEPS.map((step) => <article key={step.number}><i>{step.icon}</i><span>STEP {step.number}</span><h3>{step.title}</h3><p>{step.body}</p><b>{step.tag}</b></article>)}
        </div>
      </div>
    </section>
  );
}

export function RiskPreviewSection() {
  return (
    <section className="section refresh-risk-showcase" aria-labelledby="risk-preview-title">
      <div className="shell">
        <div className="refresh-section-row"><div><span className="eyebrow">사업장 확인</span><h2 id="risk-preview-title">두 가지 위험카드로 나눠 확인하세요</h2><p>사업장 단위 임금 정보와 지역·업종 단위 산업안전 정보를 섞지 않습니다.</p></div><Link href="/companies" className="button button-outline">사업장 검색하기 →</Link></div>
        <div className="refresh-risk-preview" aria-label="위험카드 화면 예시">
          <article className="refresh-risk-card is-watch">
            <header><div><small>사업장 단위 확인 정보</small><h3>임금 지급 관련 정보</h3></div><strong>추가 확인 권장</strong></header>
            <p className="refresh-status-copy">확인할 공개 항목이 있습니다. 아래 세부 지표와 공식 명단 결과를 함께 확인하세요.</p>
            <dl>{WAGE_ITEMS.map((item) => <div key={item}><dt>{item}</dt><dd>확인할 수 없음</dd></div>)}</dl>
            <small className="refresh-preview-note">화면 예시 · 연결되지 않은 값은 추정하지 않습니다.</small>
          </article>
          <article className="refresh-risk-card is-review">
            <header><div><small>개별 사업장 판정 아님</small><h3>지역·업종 산업재해 신호</h3></div><strong>우선 확인 필요</strong></header>
            <p className="refresh-status-copy">이 신호는 해당 회사의 사고확률이 아닙니다. 현장별 안전조치를 직접 확인하세요.</p>
            <div className="refresh-context-box"><b>분석 범위</b><span>지역·업종 맥락 · 인천광역시 · 건설업</span></div>
            <ul><li>입사 전 안전교육 일정 확인</li><li>업무별 보호구 지급 여부 확인</li><li>위험 작업과 작업중지 절차 질문</li></ul>
            <small className="refresh-preview-note">화면 예시 · 실제 결과는 선택한 사업장 데이터로 표시됩니다.</small>
          </article>
        </div>
      </div>
    </section>
  );
}

export function ContractPreviewSection() {
  return (
    <section className="section refresh-contract-preview" aria-labelledby="contract-preview-title"><div className="shell refresh-split-section">
      <div><span className="eyebrow">계약서 진단</span><h2 id="contract-preview-title">서명 전에 놓친 항목을 확인하세요</h2><p>계약서 원문에서 임금 지급일, 근로시간, 휴게시간과 수당 기준을 찾아 다시 확인할 질문으로 정리합니다.</p><Link href="/contracts" className="button button-dark">계약서 진단하기 →</Link></div>
      <div className="refresh-contract-card"><span>▤</span><div><small>진단 결과 화면 예시</small><h3>근로계약서 기본 항목</h3><ul><li><b>✓</b><span>문서에서 확인됨</span><strong>3개</strong></li><li><b>!</b><span>누락 가능</span><strong>1개</strong></li><li><b>?</b><span>추가 확인</span><strong>2개</strong></li></ul></div></div>
    </div></section>
  );
}

const COMMUNITY_PREVIEW = [
  ["인천 · 건설업", "급여", "급여일이 자꾸 밀리는데 다들 어떻게 확인하셨나요?", "입사할 때 들었던 날짜와 실제 지급일이 달라서 계약서를 다시 보고 있어요."],
  ["경기 · 제조업", "계약서", "휴게시간이 계약서와 다를 때 어떻게 기록하나요?", "근무표와 실제 쉬는 시간을 따로 기록해 보신 분의 경험이 궁금합니다."],
  ["서울 · 서비스업", "입사 전", "첫 출근 전에 꼭 물어봐야 할 질문을 모아봐요", "급여 구성과 근무시간 외에 미리 확인하면 좋은 항목을 나눠주세요."],
] as const;

export function CommunityPreview() {
  return (
    <section className="section refresh-community-preview" aria-labelledby="community-preview-title"><div className="shell">
      <div className="refresh-section-row"><div><span className="eyebrow">커뮤니티</span><h2 id="community-preview-title">같은 현장, 같은 고민</h2><p>사용자 경험은 공식 데이터와 구분해 표시합니다.</p></div><Link href="/community" className="button button-outline">커뮤니티 보기 →</Link></div>
      <div className="refresh-post-grid">{COMMUNITY_PREVIEW.map(([place, tag, title, body]) => <article key={title}><div><b>{place}</b><em>{tag}</em></div><h3>{title}</h3><p>{body}</p><small>DEMO 게시물</small></article>)}</div>
    </div></section>
  );
}

export function ConsultPreviewSection() {
  return (
    <section className="section refresh-consult-preview" aria-labelledby="consult-preview-title"><div className="shell refresh-split-section">
      <div><span className="eyebrow">AI 노동 상담</span><h2 id="consult-preview-title">막막할 때<br />AI가 먼저 답합니다</h2><p>같은 질문을 두 모델에 보내고, 공식 근거와 다음 행동을 나란히 비교합니다.</p><div className="refresh-prompt-list"><Link href="/chat?prompt=임금이%20밀릴%20때%20어떤%20자료부터%20준비해야%20하나요%3F">“급여가 밀릴 때 뭘 준비하나요?” <span>→</span></Link><Link href="/chat?prompt=근로계약서에서%20꼭%20확인할%20항목을%20알려주세요.">“계약서에서 꼭 볼 것은?” <span>→</span></Link></div></div>
      <div className="refresh-answer-preview"><header><span>두 모델 답변 비교</span><small>같은 질문 · 같은 공식 근거</small></header><div><article><b>Upstage Solar</b><h3>지금 확인할 순서</h3><ol><li>계약서와 임금명세서 확보</li><li>입금 내역과 근무기록 정리</li><li>회사에 지급일 서면 확인</li></ol><small>공식 근거 · 답변 한계 표시</small></article><article><b>SKT A.X</b><h3>핵심 확인 사항</h3><p>사실관계를 기록하고 공식 상담 창구와 구제 절차를 함께 확인하세요.</p><small>응답 상세 · 기술 정보 토글</small></article></div></div>
    </div></section>
  );
}

export function FinalCta() {
  return (
    <section className="refresh-final-cta"><div className="shell"><span className="eyebrow">지금 시작하세요</span><h2>일하기 전에도, 일하는 중에도<br />미리 대비하는 돈워리</h2><p>회사명을 입력하면 공개 데이터에서 관측된 사실과 확인할 항목을 정리합니다.</p><div className="refresh-button-row"><Link href="/companies" className="button button-ai button-large">무료로 위험카드 보기 →</Link><Link href="/chat" className="button button-dark button-large">AI 상담 먼저 해보기</Link></div></div></section>
  );
}
