// 랜딩 페이지. 더미 데이터를 /api/demo/* 에서 받아 그립니다.

const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ICON_SVG = (name, size = 15) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"
     stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><use href="#i-${name}"/></svg>`;

// ── 커뮤니티 ──────────────────────────────────────────
let posts = [];

function renderPosts(industry) {
  const list = industry === "전체" ? posts : posts.filter((p) => p.industry === industry);
  $("posts").innerHTML = list.map((p) => `
    <article class="card post">
      <div class="post__top">
        <span class="post__icon">${ICON_SVG(p.icon)}</span>
        <span class="badge badge--muted">${esc(p.region)} · ${esc(p.industry)}</span>
        ${p.tag ? `<span class="badge badge--danger">${ICON_SVG("alert-circle", 12)} ${esc(p.tag)}</span>` : ""}
      </div>
      <h3 class="post__title">${esc(p.title)}</h3>
      <p class="post__body">${esc(p.body)}</p>
      <div class="post__foot">
        <span>${esc(p.ago)}</span>
        <span class="post__metrics">
          <span>${ICON_SVG("message-circle", 13)} ${p.comments}</span>
          <span>${ICON_SVG("star", 13)} ${p.likes}</span>
        </span>
      </div>
    </article>`).join("");
}

function renderFilters() {
  const industries = ["전체", ...new Set(posts.map((p) => p.industry))];
  $("filters").innerHTML = industries
    .map((n, i) => `<button class="chip" aria-pressed="${i === 0}">${esc(n)}</button>`).join("");
  [...$("filters").children].forEach((btn) => {
    btn.onclick = () => {
      [...$("filters").children].forEach((b) => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      renderPosts(btn.textContent);
    };
  });
}

// ── 위험카드 ──────────────────────────────────────────
let cards = [];

const TREND_LABEL = {
  increasing: "증가", decreasing: "감소", stable: "보합",
  unknown: "판단 불가", too_small: "표본 부족",
};
const LEVEL_LABEL = { normal: "정상", warning: "주의", danger: "위험" };
const COMPLETENESS = { high: "높음", medium: "보통", low: "낮음" };

const fact = (k, v, cls = "") =>
  `<div class="fact"><span class="fact__k">${k}</span><span class="fact__v ${cls}">${v}</span></div>`;

const dim = (s) => `<span style="color:var(--muted);font-weight:400">${s}</span>`;

const won = (v) => v == null ? "-"
  : v >= 1e8 ? `${(v / 1e8).toFixed(1)}억원` : `${Math.round(v / 1e4).toLocaleString()}만원`;

function employmentFacts(e) {
  if (e.small_sample) {
    return fact("국민연금 가입자", `${e.subscriber_count}명 ${dim("(5인 미만 · 지표 비표시)")}`);
  }
  if (e.net_change_rate_12m == null) {
    return fact("국민연금 가입자", `${e.subscriber_count}명 ${dim("(추이 판단 불가)")}`);
  }

  const pct = (e.net_change_rate_12m * 100).toFixed(1);
  const cls = e.net_change_rate_12m < -0.05 ? "fact__v--danger"
            : e.net_change_rate_12m > 0.05 ? "fact__v--safe" : "";

  let out = fact("국민연금 가입자 (12개월)",
    `${e.subscriber_before} → ${e.subscriber_count}명 (${pct >= 0 ? "+" : ""}${pct}%)`, cls);

  if (e.turnover_rate_12m != null) {
    out += fact("이직률 (12개월)", `${Math.round(e.turnover_rate_12m * 100)}%`,
      e.turnover_rate_12m >= 0.3 ? "fact__v--danger" : "");
  }
  if (e.notice_per_head != null) {
    const streak = e.notice_falling_streak
      ? ` ${dim(`· ${e.notice_falling_streak}개월 연속 하락`)}` : "";
    out += fact("1인당 고지금액", `월 ${won(e.notice_per_head)}${streak}`,
      e.notice_falling_streak >= 3 ? "fact__v--danger" : "");
  }
  return out;
}

function renderCard(c) {
  const w = c.workplace, o = c.observed, alert = c.context.safety_alert;
  const listed = o.defaulter_list.matched;
  const arrears = o.health_arrears.matched;

  const flags = o.green_flags.length
    ? `<div class="flags">${o.green_flags.map((f) => `<span class="badge badge--safe">${esc(f)}</span>`).join("")}</div>`
    : "";

  const notes = o.data_quality.notes.length
    ? `<p class="notes">${o.data_quality.notes.map(esc).join("<br>")}</p>` : "";

  const checks = c.checklist.length ? c.checklist.map((k) => `
      <div class="check check--${k.severity}">
        <span class="check__icon">${ICON_SVG(k.severity === "attention" ? "alert-circle" : "info", 16)}</span>
        <div><h4>${esc(k.title)}</h4><p>${esc(k.body)}</p></div>
      </div>`).join("")
    : `<p class="notes" style="margin-top:12px">특별히 확인하실 만한 신호는 보이지 않습니다.
       그래도 근로계약서에 임금 지급일과 지급 방법이 적혀 있는지는 확인해 두세요.</p>`;

  const context = alert ? `
    <div class="layer layer--context">
      <div class="layer__label">지역·업종 맥락 · 집계</div>
      <div class="alert">
        <div class="alert__head">
          <span class="alert__dot alert__dot--${alert.level}"></span>
          <span class="alert__title">${esc(alert.region_label)} · ${esc(alert.industry_label)} — ${LEVEL_LABEL[alert.level]}</span>
        </div>
        <p class="alert__nums">예측 ${alert.predicted_count}건 / 평시 ${alert.baseline_count}건 (${alert.risk_ratio}배)</p>
        <ul class="alert__drivers">${alert.top_drivers.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
        <p class="notes">${esc(alert.disclaimer)}</p>
      </div>
    </div>` : "";

  $("wcard").innerHTML = `
    <div class="wcard">
      <div class="wcard__head">
        <div>
          <div class="wcard__name">${esc(w.name)}</div>
          <div class="wcard__meta">
            ${ICON_SVG("map-pin", 14)} ${esc(w.region_label)} ${esc(w.district)} <i></i>
            ${ICON_SVG("building", 14)} ${esc(w.industry_label)} <i></i>
            설립 ${w.founded_year}
          </div>
        </div>
        <span class="badge ${listed ? "badge--danger" : "badge--muted"}">
          ${listed ? "명단 등재 이력" : "명단 미등재"}
        </span>
      </div>

      <div class="layer layer--observed">
        <div class="layer__label">관측 사실 · 공개 데이터</div>
        <div class="facts">
          ${fact("체불사업주 명단",
            listed
              ? `등재 (${esc(o.defaulter_list.published_at)} 공개분 · 체불액 ${won(o.defaulter_list.amount)})`
              : "미등재",
            listed ? "fact__v--danger" : "fact__v--safe")}
          ${fact("건강보험 체납 명단",
            arrears
              ? `등재 (${esc(o.health_arrears.published_at)} 공개분 · 체납액 ${won(o.health_arrears.amount)})`
              : "미등재",
            arrears ? "fact__v--danger" : "fact__v--safe")}
          ${employmentFacts(o.employment)}
          ${fact("고용 추이", TREND_LABEL[o.employment.trend] || "-")}
          ${fact("업종 폐업률", `${(o.industry.closure_rate * 100).toFixed(1)}% ${dim("· KOSIS")}`)}
          ${fact("데이터 충실도",
            `${COMPLETENESS[o.data_quality.completeness]} · 최근 3개월 결측 ${o.data_quality.missing_months_recent_3}개월`)}
        </div>
        ${flags}
        ${notes}
      </div>

      <div class="layer layer--check">
        <div class="layer__label">확인 체크리스트 · 예측을 질문으로</div>
        <div class="checks">${checks}</div>
      </div>

      ${context}

      <p class="disclaimer">${esc(c.disclaimer)}</p>

      <div class="wcard__foot">
        <span>기준 · 고용 ${esc(c.as_of.employment)} (월 1회 갱신) · 산재 ${esc(c.as_of.safety)} (주 1회 갱신)</span>
        <span>매칭 신뢰도 ${Math.round(o.data_quality.match_confidence * 100)}%</span>
      </div>
    </div>`;
}

function renderPicker() {
  const dupes = new Set(
    cards.map((c) => c.workplace.name)
         .filter((n, i, a) => a.indexOf(n) !== i));

  $("wpicker").innerHTML = cards.map((c, i) => {
    const w = c.workplace;
    // 동명 사업장은 소재지를 붙여 구분합니다.
    const label = dupes.has(w.name) ? `${w.name} (${w.district})` : w.name;
    return `<button class="chip" aria-pressed="${i === 0}" title="${esc(w.case)}">${esc(label)}</button>`;
  }).join("");
  [...$("wpicker").children].forEach((btn, i) => {
    btn.onclick = () => {
      [...$("wpicker").children].forEach((b) => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      renderCard(cards[i]);
    };
  });
}

// ── AI 상담 미리보기 ──────────────────────────────────
function renderPrompts(list) {
  $("prompts").innerHTML = list.map((q) => `
    <button class="consult__prompt" type="button">
      <span>${esc(q)}</span>${ICON_SVG("arrow-right", 14)}
    </button>`).join("");
  [...$("prompts").children].forEach((btn) => {
    btn.onclick = () => goChat(btn.querySelector("span").textContent);
  });
}

function goChat(question) {
  const url = question ? `/chat?q=${encodeURIComponent(question)}` : "/chat";
  location.href = url;
}

// ── 초기화 ────────────────────────────────────────────
async function init() {
  try {
    const [community, workplaces, personas] = await Promise.all([
      fetch("/api/demo/community").then((r) => r.json()),
      fetch("/api/demo/workplaces").then((r) => r.json()),
      fetch("/api/personas").then((r) => r.json()),
    ]);

    $("stats").innerHTML = community.stats.map((s) => `
      <div class="stats__item">
        <div class="stats__value">${esc(s.value)}<span class="stats__unit">${esc(s.unit)}</span></div>
        <div class="stats__label">${esc(s.label)}</div>
      </div>`).join("");

    posts = community.items;
    renderFilters();
    renderPosts("전체");

    cards = workplaces.items;
    renderPicker();
    renderCard(cards[0]);

    // 랜딩은 시안대로 앞 5개만. 더미 사업장명이 들어간 예시는 /chat 사이드바에만 둡니다.
    const general = personas.personas.find((p) => p.id === "general");
    renderPrompts((general ? general.suggestions : []).slice(0, 5));
  } catch (err) {
    console.error(err);
    $("posts").innerHTML = `<p class="lead">서버에 연결하지 못했습니다. <code>./run.sh</code> 가 실행 중인지 확인하세요.</p>`;
  }

  $("quick-form").addEventListener("submit", (e) => {
    e.preventDefault();
    goChat($("quick-input").value.trim());
  });
}

init();
