const companies = [
  {
    id: "demo-oo-incheon",
    name: "OO건설",
    logo: "OO",
    address: "인천광역시 서구 검단로 00",
    region: "인천광역시",
    industry: "건설업",
    size: "50~99명",
    wage: {
      level: "watch",
      status: "추가 확인 권장",
      summary: "최근 인원 변동이 보여 임금 지급 조건과 4대보험 처리 시점을 확인하는 것이 좋습니다.",
      facts: [["공식 명단 확인", "일치 결과 없음"], ["최근 고용 흐름", "가입자 수 감소 관측"]],
      prompt: "최근 인원 변동의 이유와 급여 지급일, 4대보험 가입 시점을 확인할 수 있을까요?",
      source: "국민연금 가입 사업장 자료 · 체불사업주 명단공개",
      limitation: "명단에서 확인되지 않았다는 사실이 체불 이력이 전혀 없거나 미래 체불이 없다는 뜻은 아닙니다."
    },
    safety: {
      level: "review",
      status: "현장 확인 필요",
      summary: "이 사업장이 속한 지역·업종의 공개 참고자료를 바탕으로 현장 안전조치를 직접 확인해 주세요.",
      facts: [["분석 범위", "인천광역시 · 건설업"], ["확인할 맥락", "안전조치 추가 확인"]],
      prompt: "첫 출근 전 안전교육 일정과 보호구 지급 여부, 사고 보고 절차를 확인할 수 있을까요?",
      source: "산업재해 지역·업종 공개 참고자료",
      limitation: "지역·업종 단위 참고정보이며 이 사업장의 사고 확률이나 안전 판정이 아닙니다."
    }
  },
  {
    id: "demo-oo-hwaseong",
    name: "OO건설",
    logo: "OO",
    address: "경기도 화성시 동탄산단로 00",
    region: "경기도",
    industry: "전문직별 공사업",
    size: "10~49명",
    wage: {
      level: "normal",
      status: "뚜렷한 이상 신호 없음",
      summary: "현재 확인 가능한 자료에서는 뚜렷한 추가 확인 신호가 보이지 않습니다.",
      facts: [["공식 명단 확인", "일치 결과 없음"], ["관측 자료", "최근 자료 확인됨"]],
      prompt: "신호와 별개로 실제 급여 지급일과 근로계약서 교부 시점을 확인할 수 있을까요?",
      source: "국민연금 가입 사업장 자료 · 체불사업주 명단공개",
      limitation: "뚜렷한 신호가 없다는 표현은 안전 인증이나 향후 문제없음을 뜻하지 않습니다."
    },
    safety: {
      level: "watch",
      status: "추가 확인 권장",
      summary: "지역·업종 참고자료만으로 개별 현장을 판단할 수 없어 실제 근무환경 확인이 필요합니다.",
      facts: [["분석 범위", "경기도 · 전문직별 공사업"], ["자료 충분도", "제한적 자료"]],
      prompt: "배치될 현장의 안전관리 책임자와 정기 안전교육 일정을 알려주실 수 있을까요?",
      source: "산업재해 지역·업종 공개 참고자료",
      limitation: "이 정보는 개별 현장의 사고 가능성을 나타내지 않습니다."
    }
  },
  {
    id: "demo-daon",
    name: "다온제조",
    logo: "다온",
    address: "충청남도 아산시 산업로 00",
    region: "충청남도",
    industry: "제조업",
    size: "100~299명",
    wage: {
      level: "normal",
      status: "뚜렷한 이상 신호 없음",
      summary: "현재 공개 가능한 자료에서는 뚜렷한 이상 신호가 확인되지 않았습니다.",
      facts: [["공식 명단 확인", "일치 결과 없음"], ["고용 흐름", "최근 큰 변동 없음"]],
      prompt: "급여 지급일과 수습기간의 임금 조건이 계약서에 어떻게 적히는지 확인할 수 있을까요?",
      source: "국민연금 가입 사업장 자료 · 체불사업주 명단공개",
      limitation: "현재 신호만으로 입사 적합성이나 미래 상황을 확정하지 않습니다."
    },
    safety: {
      level: "normal",
      status: "뚜렷한 추가 신호 없음",
      summary: "지역·업종 자료에서 최근 뚜렷한 추가 확인 신호가 나타나지 않았습니다.",
      facts: [["분석 범위", "충청남도 · 제조업"], ["확인할 사항", "실제 공정별 안전조치"]],
      prompt: "배치 공정의 위험요인과 보호구, 신규자 안전교육을 안내받을 수 있을까요?",
      source: "산업재해 지역·업종 공개 참고자료",
      limitation: "지역·업종 자료가 개별 공정이나 사업장의 안전을 보증하지 않습니다."
    }
  },
  {
    id: "demo-future",
    name: "미래산업",
    logo: "미래",
    address: "강원특별자치도 원주시 기업도시로 00",
    region: "강원특별자치도",
    industry: "기타 전문 서비스업",
    size: "규모 정보 없음",
    wage: {
      level: "unknown",
      status: "분석 자료 부족",
      summary: "분석 가능한 사업장 자료가 부족합니다. 자료 부족을 정상이나 안전으로 바꾸지 않습니다.",
      facts: [["공식 명단 확인", "확인 가능한 기준일 없음"], ["관측 자료", "분석에 부족"]],
      prompt: "공개 자료가 부족한 경우 회사에 어떤 임금·보험 자료를 직접 확인하면 좋을까요?",
      source: "연결된 공개 출처 없음",
      limitation: "정보 부족은 문제가 없다는 뜻도, 문제가 있다는 뜻도 아닙니다."
    },
    safety: {
      level: "unknown",
      status: "분석 자료 부족",
      summary: "연결 가능한 산업안전 참고자료가 부족해 결과를 추정하지 않습니다.",
      facts: [["분석 범위", "지역·업종 자료 부족"], ["관측 자료", "결과 추정 안 함"]],
      prompt: "공개 정보가 없을 때 실제 근무환경에서 무엇부터 확인해야 하나요?",
      source: "연결된 공개 출처 없음",
      limitation: "자료가 없다는 사실만 표시하며 안전 여부를 추론하지 않습니다."
    }
  }
];

let selectedCompanyId = companies[0].id;
let companyContextActive = false;
let pendingPrompt = "";
let toastTimer;

const initialPosts = [
  { category: "입사 전 확인", title: "면접에서 급여 지급일은 어떻게 물어보면 좋을까요?", body: "계약서를 받기 전에 지급일과 지급 방법을 자연스럽게 확인했던 경험을 나눠주세요.", author: "구직자", time: "12분 전", comments: 4, views: 38 },
  { category: "근로계약서", title: "포괄임금 조항을 받았을 때 먼저 볼 항목", body: "기본급과 고정 연장수당이 분리되어 적혀 있는지부터 확인해보려고 합니다.", author: "익명 근로자", time: "35분 전", comments: 7, views: 61 },
  { category: "현장 안전", title: "보호구와 안전교육 여부를 확인했던 경험", body: "첫 출근 전에 안전교육 일정과 보호구 지급 시점을 문의해도 괜찮았습니다.", author: "익명", time: "1시간 전", comments: 3, views: 44 },
  { category: "입사 전 확인", title: "동명이인 사업장은 주소를 꼭 확인하세요", body: "회사 이름만 보고 골랐다가 다른 지역의 사업장이어서 다시 검색했습니다.", author: "취업준비생", time: "2시간 전", comments: 2, views: 29 },
  { category: "근로계약서", title: "계약서 사본은 언제 받는 게 맞나요?", body: "첫 출근 전 계약 내용을 읽어보고 서명한 뒤 사본을 바로 받아두었습니다.", author: "신입 근로자", time: "3시간 전", comments: 5, views: 52 }
];
let posts = [...initialPosts];

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function currentCompany() {
  return companies.find((company) => company.id === selectedCompanyId) || companies[0];
}

function routeFromHash() {
  const route = location.hash.replace(/^#/, "").split("?")[0];
  return ["home", "companies", "company", "chat", "contracts", "community"].includes(route) ? route : "home";
}

function navigate(route) {
  if (routeFromHash() === route) {
    renderRoute();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  location.hash = route;
}

function renderRoute() {
  const route = routeFromHash();
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("is-active", view.dataset.view === route));
  document.querySelectorAll("[data-nav]").forEach((item) => item.classList.toggle("is-active", item.dataset.nav === route));
  if (route === "company") renderCompany();
  if (route === "home") renderHomeRisk();
  if (route === "chat") prepareChatContext();
  if (route === "community") renderPosts();
  document.title = `${({ home: "홈", companies: "사업장 확인", company: currentCompany().name, chat: "AI 노동 상담", contracts: "계약서 확인", community: "커뮤니티" })[route]} · 돈워리 UI 프로토타입`;
  window.scrollTo({ top: 0, behavior: "auto" });
  document.getElementById("main").focus({ preventScroll: true });
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

function performSearch(query) {
  const normalized = query.trim().replace(/\s+/g, "").toLowerCase();
  const output = document.getElementById("search-output");
  if (!normalized) {
    output.innerHTML = `<div class="empty-state"><span aria-hidden="true">!</span><h2>회사명을 입력해 주세요</h2><p>한 글자 이상 입력하면 더미 사업장 후보를 찾습니다.</p></div>`;
    return;
  }
  const matches = companies.filter((company) => `${company.name}${company.region}${company.industry}`.replace(/\s+/g, "").toLowerCase().includes(normalized));
  if (!matches.length) {
    output.innerHTML = `<div class="empty-state"><span aria-hidden="true">?</span><h2>‘${escapeHtml(query.trim())}’ 검색 결과가 없습니다</h2><p>띄어쓰기를 바꾸거나 빠른 검색어를 사용해 보세요.</p></div>`;
    return;
  }
  output.innerHTML = `
    <div class="result-summary"><h2>‘${escapeHtml(query.trim())}’ 관련 사업장 ${matches.length}곳</h2><span>첫 결과를 자동 선택하지 않습니다.</span></div>
    <div class="company-results">
      ${matches.map((company) => `
        <article class="company-result">
          <span class="company-logo">${escapeHtml(company.logo)}</span>
          <div class="company-result-main">
            <strong>${escapeHtml(company.name)}</strong>
            <span>${escapeHtml(company.address)}</span>
            <div class="result-tags"><span>${escapeHtml(company.region)}</span><span>${escapeHtml(company.industry)}</span><span>${escapeHtml(company.size)}</span></div>
          </div>
          <button class="button button-light" type="button" data-select-company="${company.id}">위험카드 보기</button>
        </article>`).join("")}
    </div>`;
}

function workplaceRiskCard(company) {
  const observedStatus = company.wage.level === "unknown" ? "자료 부족" : "명단 미등재";
  const badgeClass = company.wage.level === "unknown" ? "badge-muted" : "badge-safe";
  const contextLevel = company.safety.level === "normal" ? "정상" : company.safety.level === "unknown" ? "자료 부족" : "주의";
  const contextDot = company.safety.level === "normal" ? "normal" : company.safety.level === "unknown" ? "unknown" : "warning";
  const contextNumbers = company.safety.level === "unknown"
    ? "연결 가능한 집계가 없어 수치를 표시하지 않습니다."
    : company.safety.level === "normal" ? "예측 4건 / 평시 4건 (1.0배)" : "예측 9건 / 평시 5건 (1.8배)";
  const contextWidth = company.safety.level === "unknown" ? 18 : company.safety.level === "normal" ? 44 : 78;
  return `
    <article class="wcard">
      <div class="wcard-head">
        <div><h3>${escapeHtml(company.name)}</h3><p>⌖ ${escapeHtml(company.region)} · ${escapeHtml(company.industry)} · ${escapeHtml(company.size)}</p></div>
        <span class="wcard-badge ${badgeClass}">${observedStatus}</span>
      </div>
      <section class="wcard-layer layer-observed">
        <span class="wcard-layer-title">관측 사실 · 공개 데이터</span>
        <div class="wcard-facts">
          <div><span>체불사업주 명단</span><strong class="fact-safe">미등재</strong></div>
          <div><span>건강보험 체납 명단</span><strong class="fact-safe">미등재</strong></div>
          ${company.wage.facts.filter(([key]) => !key.includes("명단")).map(([key, value]) => `<div><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}
          <div><span>데이터 충실도</span><strong>${company.wage.level === "unknown" ? "낮음 · 결측 있음" : "보통 · 최근 자료 확인"}</strong></div>
        </div>
        <div class="wcard-flags"><span>공개 출처 확인</span><span>기준일 표시</span></div>
      </div>
      <section class="wcard-layer layer-check">
        <span class="wcard-layer-title">확인 체크리스트 · 예측을 질문으로</span>
        <div class="wcard-check"><i>!</i><p><strong>임금 조건을 서면으로 확인하세요</strong><span>${escapeHtml(company.wage.prompt)}</span></p></div>
        <div class="wcard-check info"><i>i</i><p><strong>실제 현장 조건을 함께 확인하세요</strong><span>${escapeHtml(company.safety.prompt)}</span></p></div>
      </section>
      <section class="wcard-layer layer-context">
        <span class="wcard-layer-title">지역·업종 맥락 · 집계</span>
        <div class="context-head"><i class="context-dot ${contextDot}"></i><strong>${escapeHtml(company.region)} · ${escapeHtml(company.industry)} — ${contextLevel}</strong></div>
        <p class="context-numbers">${contextNumbers}</p>
        <div class="context-scale" aria-label="지역·업종 집계 신호 시각화"><span style="width:${contextWidth}%"></span></div>
        <ul><li>최근 지역·업종 공개 참고자료 기준</li><li>현장 안전교육과 보호구 지급 여부 직접 확인</li></ul>
        <p class="wcard-note">지역·업종 집계이며 이 사업장의 사고 위험이나 안전 판정이 아닙니다.</p>
      </section>
      <details class="wcard-more"><summary>출처·기준일·해석 한계 보기</summary><p class="wcard-disclaimer">이 카드는 공개 데이터에서 관측된 사실과 확인할 질문을 정리한 참고자료입니다. 입사 결정이나 법률 판단을 대신하지 않습니다.</p><div class="wcard-foot"><span>출처 · 국민연금 가입 사업장 자료 · 공개 명단 · 산업재해 지역·업종 참고자료</span><span>기준 · 고용 2026-07 · 산재 2026-07-31 · 매칭 ${company.wage.level === "unknown" ? "확인 필요" : "92%"}</span></div></details>
      <button class="wcard-action" type="button" data-ask="${escapeHtml(company.wage.prompt)}" data-company-context>이 카드로 AI 상담 이어가기 →</button>
    </article>`;
}

function renderHomeRisk() {
  const picker = document.getElementById("home-risk-picker");
  const card = document.getElementById("home-risk-card");
  if (!picker || !card) return;
  picker.innerHTML = companies.map((company) => `<button type="button" class="chip ${company.id === selectedCompanyId ? "is-active" : ""}" data-home-company="${company.id}">${escapeHtml(company.name)}${company.id === "demo-oo-hwaseong" ? " (화성)" : ""}</button>`).join("");
  card.innerHTML = workplaceRiskCard(currentCompany());
}

function renderCompany() {
  const company = currentCompany();
  document.getElementById("detail-logo").textContent = company.logo;
  document.getElementById("company-title").textContent = company.name;
  document.getElementById("company-address").textContent = company.address;
  document.getElementById("detail-tags").innerHTML = `<span>${escapeHtml(company.region)}</span><span>${escapeHtml(company.industry)}</span><span>${escapeHtml(company.size)}</span>`;
  document.getElementById("risk-grid").innerHTML = workplaceRiskCard(company);
  const questions = [
    ["임금 조건", company.wage.prompt, "임금 카드에서 이어짐"],
    ["현장 안전", company.safety.prompt, "산업안전 카드에서 이어짐"],
    ["계약서", "이 사업장에 입사하기 전 근로계약서에서 무엇을 확인해야 하나요?", "공통 확인 항목"]
  ];
  document.getElementById("company-question-actions").innerHTML = questions.map(([tag, prompt, source]) => `<button class="question-action" type="button" data-ask="${escapeHtml(prompt)}" data-company-context><span>${tag}</span><strong>${escapeHtml(prompt)}</strong><small>${source} · AI 상담으로 이동 →</small></button>`).join("");
}

function askInChat(prompt, useCompanyContext = false) {
  companyContextActive = useCompanyContext;
  pendingPrompt = prompt;
  navigate("chat");
}

function prepareChatContext() {
  const context = document.getElementById("chat-company-context");
  const input = document.getElementById("chat-input");
  if (companyContextActive) {
    const company = currentCompany();
    context.hidden = false;
    context.innerHTML = `<strong>${escapeHtml(company.name)}</strong><br>${escapeHtml(company.region)} · ${escapeHtml(company.industry)}<br><small>사업장 공개 컨텍스트 연결</small>`;
    input.placeholder = `${company.name} 또는 노동 문제에 관해 질문하세요`;
  } else {
    context.hidden = true;
    context.innerHTML = "";
    input.placeholder = "노동 관련 질문을 입력하세요";
  }
  if (pendingPrompt) {
    input.value = pendingPrompt;
    pendingPrompt = "";
    setTimeout(() => input.focus(), 0);
  }
}

function dummyAnswers(question) {
  const company = currentCompany();
  const companyName = companyContextActive ? company.name : "특정 사업장";
  const lower = question.toLowerCase();
  let core;
  let actions;
  let sources;
  if (lower.includes("산재") || lower.includes("안전") || lower.includes("보호구")) {
    core = `${companyName}의 공개 정보만으로 현장의 안전 여부를 확정할 수는 없습니다. 산업안전 참고정보는 지역·업종 범위이므로, 실제 배치 현장의 안전교육·보호구·작업중지 절차를 직접 확인하는 것이 핵심입니다.`;
    actions = ["안전교육 일정과 담당자를 확인하기", "보호구 지급·교체 기준을 서면으로 확인하기", "급박한 위험 시 대피와 작업중지 절차 묻기"];
    sources = ["산업안전보건법 관련 공식 안내", "근로복지공단 산재 신청 안내"];
  } else if (lower.includes("계약서") || lower.includes("근로계약")) {
    core = `계약서에서는 임금의 구성·계산·지급일, 소정근로시간, 휴일·연차, 근무 장소와 업무 내용을 먼저 확인하세요. 문서에 보이지 않는 항목이 실제로 누락된 것인지 회사에 서면으로 다시 묻는 것이 좋습니다.`;
    actions = ["급여 구성과 지급일 표시 찾기", "근로시간·휴게시간 구분 확인하기", "계약서 사본 교부 시점 묻기"];
    sources = ["근로기준법 제17조", "고용노동부 표준근로계약서 안내"];
  } else if (lower.includes("임금") || lower.includes("4대보험") || lower.includes("급여")) {
    core = `${companyName}의 공개 카드에서는 임금 지급 조건을 추가로 확인할 항목이 있을 수 있습니다. 이것은 체불 발생 확정이 아니므로, 급여 지급일·지급 방법·4대보험 가입 예정일을 계약서와 회사 답변으로 대조하세요.`;
    actions = ["근로계약서와 급여명세서 확보하기", "지급일·지급 방법을 서면으로 확인하기", "문제가 생기면 고용노동부 1350에 상담하기"];
    sources = ["근로기준법 임금·근로조건 명시 조항", "고용노동부 1350 상담 안내"];
  } else {
    core = companyContextActive
      ? `입사 여부를 대신 결정할 수는 없지만, ${company.name}에 관해서는 임금 조건과 실제 근무환경을 따로 확인할 수 있습니다. 공개 카드의 신호보다 회사가 제공하는 계약서와 현장 설명이 일치하는지 살펴보세요.`
      : "입사 여부를 대신 결정할 수는 없습니다. 특정 회사가 궁금하다면 사업장을 먼저 검색해 정확한 주소·업종을 선택하고, 임금 조건과 실제 근무환경을 따로 확인하세요.";
    actions = ["정확한 사업장 주소와 업무 확인하기", "임금·보험 조건을 서면으로 확인하기", "현장 안전조치를 구체적으로 질문하기"];
    sources = ["사업장 공개 확인정보", "공식 노동 상담 안내"];
  }
  return [
    { name: "Upstage Solar", dot: "", answer: core, actions, sources },
    { name: "SKT A.X", dot: "model-dot-skt", answer: `${core}\n\n확인한 답변은 입사 결정의 한 자료로만 사용하고, 실제 계약 조건과 최신 현장 상황을 함께 비교하세요.`, actions: [...actions].reverse(), sources }
  ];
}

function sendChat(question) {
  const trimmed = question.trim();
  if (!trimmed) return;
  const messages = document.getElementById("chat-messages");
  messages.insertAdjacentHTML("beforeend", `<div class="chat-row user-row"><div class="bubble user-bubble"><p>${escapeHtml(trimmed)}</p></div></div><div class="typing" id="typing"><i></i>두 더미 모델 답변을 준비하고 있습니다</div>`);
  messages.scrollTop = messages.scrollHeight;
  document.getElementById("chat-input").value = "";
  setTimeout(() => {
    document.getElementById("typing")?.remove();
    const answers = dummyAnswers(trimmed);
    messages.insertAdjacentHTML("beforeend", `
      <div class="comparison-block">
        <div class="comparison-summary"><strong>같은 질문과 공개 컨텍스트로 비교</strong><span>UI 더미 응답</span></div>
        <div class="answer-grid">
          ${answers.map((item) => `<article class="answer-card">
            <div class="answer-head"><i class="model-dot ${item.dot}"></i><strong>${item.name}</strong><span>더미 답변</span></div>
            <div class="answer-copy">${escapeHtml(item.answer)}</div>
            <div class="answer-section"><strong>공식 근거 예시</strong><ul>${item.sources.map((source) => `<li>${escapeHtml(source)}</li>`).join("")}</ul></div>
            <div class="answer-section"><strong>지금 할 일</strong><ul>${item.actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul></div>
            <details class="answer-details"><summary>응답 상세 · 기술 정보</summary><dl><div><dt>응답 시간</dt><dd>더미·미측정</dd></div><div><dt>토큰</dt><dd>더미·미측정</dd></div><div><dt>공식 검색</dt><dd>예시 자료</dd></div><div><dt>외부 전송</dt><dd>없음</dd></div></dl></details>
          </article>`).join("")}
        </div>
        <div class="comparison-vote"><button type="button" data-vote>Solar가 더 유용</button><button type="button" data-vote>A.X가 더 유용</button><button type="button" data-vote>비슷함</button></div>
      </div>`);
    messages.scrollTop = messages.scrollHeight;
  }, 650);
}

function renderContractResult(file) {
  const result = document.getElementById("contract-result");
  result.hidden = false;
  document.getElementById("contract-upload").hidden = true;
  result.innerHTML = `
    <div class="contract-result-head"><div><span class="eyebrow">더미 검토 완료</span><h2>${escapeHtml(file.name)}</h2><p>파일 내용은 읽지 않았으며 미리 준비된 UI 결과입니다.</p></div><span class="result-pill">확인 3 · 누락 가능 1 · 추가 확인 2</span></div>
    <div class="contract-columns">
      <section class="contract-column"><strong>✓ 문서에서 확인됨</strong><ul><li><strong>임금 지급일</strong><span>매월 25일로 표시</span></li><li><strong>근무 장소</strong><span>사업장 주소 확인</span></li><li><strong>업무 내용</strong><span>생산 설비 보조</span></li></ul></section>
      <section class="contract-column"><strong>! 누락 가능</strong><ul><li><strong>연차 유급휴가</strong><span>문서 인식 범위에서 찾기 어려움</span></li></ul></section>
      <section class="contract-column"><strong>? 추가 확인</strong><ul><li><strong>고정 연장수당</strong><span>기본급과 계산 기준을 대조하세요</span></li><li><strong>휴게시간</strong><span>실제 운영 시간을 회사에 확인하세요</span></li></ul></section>
    </div>
    <div class="contract-next"><div><strong>결과를 법률 확정판정으로 보지 마세요.</strong><p>궁금한 항목은 공식 근거 기반 더미 상담에서 이어서 확인할 수 있습니다.</p></div><button class="button button-ai" type="button" data-ask="계약서에서 연차 유급휴가와 고정 연장수당을 어떻게 확인해야 하나요?">AI 상담으로 이어가기</button></div>
    <button class="button button-light" id="contract-reset" type="button" style="margin-top:12px">다른 파일로 다시 보기</button>`;
}

function renderPosts() {
  const selected = document.querySelector(".category-tabs button.is-active")?.dataset.category || "전체";
  const query = document.getElementById("community-search").value.trim().toLowerCase();
  const filtered = posts.filter((post) => (selected === "전체" || post.category === selected) && `${post.title} ${post.body}`.toLowerCase().includes(query));
  const list = document.getElementById("post-list");
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><span aria-hidden="true">?</span><h2>조건에 맞는 게시글이 없습니다</h2><p>다른 분류나 검색어를 선택해 보세요.</p></div>`;
    return;
  }
  list.innerHTML = filtered.map((post) => `<article class="post-card"><div><div class="post-meta"><span>${escapeHtml(post.category)}</span><small>${escapeHtml(post.author)} · ${escapeHtml(post.time)}</small></div><h2>${escapeHtml(post.title)}</h2><p>${escapeHtml(post.body)}</p></div><div class="post-stats"><span>조회 ${post.views}</span><span>댓글 ${post.comments}</span></div></article>`).join("");
}

document.addEventListener("click", (event) => {
  const previewCategory = event.target.closest("[data-preview-category]");
  if (previewCategory) {
    const category = previewCategory.dataset.previewCategory;
    document.querySelectorAll("[data-preview-category]").forEach((button) => button.classList.toggle("is-active", button === previewCategory));
    document.querySelectorAll("[data-preview-post]").forEach((post) => { post.hidden = category !== "전체" && post.dataset.previewPost !== category; });
    return;
  }
  const homeCompany = event.target.closest("[data-home-company]");
  if (homeCompany) {
    selectedCompanyId = homeCompany.dataset.homeCompany;
    companyContextActive = true;
    renderHomeRisk();
    return;
  }
  const go = event.target.closest("[data-go]");
  if (go) {
    event.preventDefault();
    if (go.dataset.go === "company") companyContextActive = true;
    navigate(go.dataset.go);
    return;
  }
  const selected = event.target.closest("[data-select-company]");
  if (selected) {
    selectedCompanyId = selected.dataset.selectCompany;
    companyContextActive = true;
    navigate("company");
    return;
  }
  const queryButton = event.target.closest("[data-query]");
  if (queryButton) {
    const input = document.getElementById("company-search");
    input.value = queryButton.dataset.query;
    performSearch(input.value);
    return;
  }
  const ask = event.target.closest("[data-ask]");
  if (ask) {
    askInChat(ask.dataset.ask, ask.hasAttribute("data-company-context"));
    return;
  }
  const prompt = event.target.closest("[data-prompt]");
  if (prompt) {
    sendChat(prompt.dataset.prompt);
    return;
  }
  if (event.target.closest("[data-vote]")) {
    showToast("더미 비교 평가가 화면에 반영되었습니다.");
    return;
  }
});

document.getElementById("company-search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  performSearch(document.getElementById("company-search").value);
});

document.getElementById("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  sendChat(document.getElementById("chat-input").value);
});

document.getElementById("chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendChat(event.currentTarget.value);
  }
});

document.getElementById("contract-file").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    showToast("10MB 이하 파일을 선택해 주세요.");
    event.target.value = "";
    return;
  }
  renderContractResult(file);
});

document.getElementById("contract-result").addEventListener("click", (event) => {
  if (event.target.closest("#contract-reset")) {
    document.getElementById("contract-file").value = "";
    document.getElementById("contract-result").hidden = true;
    document.getElementById("contract-upload").hidden = false;
  }
});

document.querySelectorAll(".category-tabs button").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".category-tabs button").forEach((item) => item.classList.toggle("is-active", item === button));
  renderPosts();
}));
document.getElementById("community-search").addEventListener("input", renderPosts);

const dialog = document.getElementById("write-dialog");
document.getElementById("open-write").addEventListener("click", () => dialog.showModal());
document.getElementById("close-write").addEventListener("click", () => dialog.close());
document.getElementById("write-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const title = document.getElementById("post-title").value.trim();
  const body = document.getElementById("post-body").value.trim();
  if (!title || !body) return;
  posts.unshift({ category: document.getElementById("post-category").value, title, body, author: "나 · DEMO", time: "방금", comments: 0, views: 1 });
  event.currentTarget.reset();
  dialog.close();
  document.querySelectorAll(".category-tabs button").forEach((item) => item.classList.toggle("is-active", item.dataset.category === "전체"));
  renderPosts();
  showToast("더미 게시글이 이 화면에 추가되었습니다.");
});

window.addEventListener("hashchange", renderRoute);
renderRoute();
