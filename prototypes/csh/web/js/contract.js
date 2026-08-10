// 근로계약서 진단
//
// 흐름
//   ① POST /api/contract/review          파일 → Document Parse → 조항 추출 → 규칙 엔진 판정
//   ② POST /api/contract/explain/stream  판정 결과 → 해설 (두 모델 동시 스트리밍)
//
// 판정(①)과 해설(②)을 나눈 이유 — 판정은 결정적이라 한 번만 계산하면 되고,
// 해설만 모델을 바꿔가며 여러 번 받습니다. 계약 내용을 브라우저가 되돌려 보내지 않도록
// 서버가 review_id 로 들고 있습니다.

const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const render = (t) => esc(t)
  .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  .replace(/`([^`]+)`/g, "<code>$1</code>");

const won = (n) => (n == null ? "—" : `${Number(n).toLocaleString("ko-KR")}원`);

// 판정 4단계 — 색만으로 구분하지 않도록 기호와 라벨을 함께 붙입니다.
const LEVELS = {
  violation: { mark: "●", label: "법정 기준 미달", order: 0 },
  check:     { mark: "▲", label: "확인 필요",      order: 1 },
  ok:        { mark: "✓", label: "기준 충족",      order: 2 },
  excluded:  { mark: "–", label: "적용 제외",      order: 3 },
};

const state = { file: null, sample: null, providers: [], reviewId: null,
                busy: false, blocked: false };

// ── 초기화 ────────────────────────────────────────────
async function init() {
  let health;
  try {
    health = await fetch("/api/health").then((r) => r.json());
    state.providers = Object.entries(health.providers || {})
      .filter(([, v]) => v.key)
      .map(([id, v]) => ({ id, label: v.label, model: v.model }));
  } catch {
    fail("서버에 연결하지 못했습니다. ./run.sh 가 실행 중인지 확인하세요.");
    return;
  }

  if (health.contract?.enabled === false) {
    block("근로계약서 진단이 꺼져 있습니다.", "<code>CONTRACT_ENABLED=1</code> 로 켜고 서버를 다시 시작하세요.");
  } else if (!state.providers.length) {
    // 키가 없는데 업로드 화면을 열어 두면 파일을 고른 뒤에야 실패합니다.
    // 무엇이 막혀 있고 무엇은 볼 수 있는지 처음부터 알려줍니다.
    block(
      "API 키를 불러오지 못해 진단을 실행할 수 없습니다.",
      (health.key_file_error
        ? `서버가 키 파일을 <b>${esc(health.key_file_error)}</b>`
        : "서버에 사용 가능한 API 키가 없습니다.")
      + "<br>문서 인식(Upstage Document Parse)과 해설 생성이 모두 이 키를 씁니다."
      + "<br><br>키 없이도 <b>예시 계약서 원본과 화면 구성은 확인할 수 있습니다.</b> "
      + "아래 예시 계약서의 &lsquo;원본 보기&rsquo;를 눌러 보세요.");
  }

  loadSamples();
}

// 진단을 실행할 수 없는 상태. 업로드는 막고 이유를 화면에 띄웁니다.
function block(title, detail) {
  state.blocked = true;
  $("notice").hidden = false;
  $("notice").innerHTML = `<b>${esc(title)}</b><p>${detail}</p>`;
  $("drop").classList.add("is-blocked");
  $("submit").disabled = true;
  $("file").disabled = true;
}

async function loadSamples() {
  let data;
  try {
    data = await fetch("/api/contract/samples").then((r) => r.json());
  } catch { return; }
  if (!data.items?.length) return;

  $("samples-box").hidden = false;
  $("samples-box").querySelector("h3").textContent = state.blocked
    ? "예시 계약서 — 원본을 눌러 내용을 확인할 수 있습니다"
    : "파일이 없다면 — 예시 계약서로 먼저 보기";

  $("samples").innerHTML = data.items.map((s) => `
    <div class="sample">
      <span class="sample__name">${esc(s.label)}</span>
      <span class="sample__desc">${esc(s.summary)}</span>
      <span class="sample__foot">
        <span class="badge badge--muted">${esc(s.expect)}</span>
        <a class="sample__link" href="/api/contract/samples/${esc(s.id)}" target="_blank"
           rel="noopener">원본 보기</a>
      </span>
      ${state.blocked ? "" :
        `<button class="btn btn--dark btn--sm sample__run" type="button"
                 data-id="${esc(s.id)}">이 계약서로 진단</button>`}
    </div>`).join("");

  [...$("samples").querySelectorAll(".sample__run")].forEach((btn) => {
    btn.onclick = () => { state.sample = btn.dataset.id; state.file = null; submit(); };
  });
}

// ── 파일 선택 ─────────────────────────────────────────
function setFile(file) {
  state.file = file;
  state.sample = null;
  $("drop").classList.toggle("is-set", Boolean(file));
  $("drop-name").textContent = file
    ? `${file.name} (${(file.size / 1024).toFixed(0)}KB)`
    : "계약서 파일을 여기에 끌어다 놓거나 눌러서 고르세요";
  $("submit").disabled = !file;
}

$("file").addEventListener("change", (e) => setFile(e.target.files[0] || null));

["dragenter", "dragover"].forEach((type) =>
  $("drop").addEventListener(type, (e) => {
    e.preventDefault();
    $("drop").classList.add("is-over");
  }));

["dragleave", "drop"].forEach((type) =>
  $("drop").addEventListener(type, (e) => {
    e.preventDefault();
    $("drop").classList.remove("is-over");
  }));

$("drop").addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) setFile(file);
});

$("upload-form").addEventListener("submit", (e) => { e.preventDefault(); submit(); });

$("reset").addEventListener("click", () => {
  state.reviewId = null;
  setFile(null);
  $("result").hidden = true;
  $("progress").hidden = true;
  $("error").hidden = true;
  $("intro").hidden = false;
  $("reset").hidden = true;
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// ── 진행 표시 ─────────────────────────────────────────
function step(name, status) {
  const el = $("steps").querySelector(`[data-step="${name}"]`);
  if (!el) return;
  el.classList.toggle("is-active", status === "active");
  el.classList.toggle("is-done", status === "done");
}

function progress(message) { $("progress-msg").textContent = message; }

function fail(message) {
  $("error").hidden = false;
  $("error").textContent = message;
  $("progress").hidden = true;
}

// ── ① 진단 ────────────────────────────────────────────
async function submit() {
  if (state.blocked || state.busy || (!state.file && !state.sample)) return;
  state.busy = true;
  $("submit").disabled = true;
  $("error").hidden = true;
  $("result").hidden = true;
  $("progress").hidden = false;
  $("intro").hidden = true;
  $("reset").hidden = false;
  ["parse", "extract", "judge", "explain"].forEach((s) => step(s, ""));
  step("parse", "active");
  progress("문서를 인식하는 중입니다. 스캔본이면 조금 더 걸립니다…");

  const body = new FormData();
  if (state.sample) body.append("sample", state.sample);
  else body.append("file", state.file);
  if ($("force-ocr").checked) body.append("ocr", "force");

  let data;
  try {
    const res = await fetch("/api/contract/review", { method: "POST", body });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  } catch (err) {
    state.busy = false;
    $("submit").disabled = !state.file;
    fail(`진단하지 못했습니다 — ${err.message}`);
    return;
  }

  step("parse", "done");
  step("extract", "done");
  step("judge", "done");
  step("explain", "active");
  progress("판정이 끝났습니다. 해설을 작성하는 중입니다…");

  state.reviewId = data.review_id;
  drawResult(data);
  $("result").hidden = false;
  $("progress").hidden = true;

  await Promise.all(state.providers.map((p) => streamOne(p)));
  step("explain", "done");
  state.busy = false;
  $("submit").disabled = !state.file;
}

// ── 결과 그리기 ───────────────────────────────────────
function drawResult(data) {
  const { verdict, parse, contract, extract } = data;
  const counts = verdict.counts;

  const tone = counts.violation ? "violation" : counts.check ? "check" : "ok";
  $("headline").className = `headline headline--${tone}`;
  $("headline").innerHTML = `
    ${esc(verdict.headline)}
    <div class="headline__counts">
      ${badge("violation", counts.violation)}
      ${badge("check", counts.check)}
      ${badge("ok", counts.ok)}
      ${counts.excluded ? badge("excluded", counts.excluded) : ""}
    </div>`;

  const groups = ["violation", "check", "ok", "excluded"];
  $("findings").innerHTML = groups.map((level) => {
    const rows = verdict.findings.filter((f) => f.level === level);
    if (!rows.length) return "";
    return `<p class="finding__group">${LEVELS[level].mark} ${LEVELS[level].label} ${rows.length}건</p>`
      + rows.map(findingCard).join("");
  }).join("");

  const basis = verdict.basis;
  $("basis").innerHTML = `
    <h3>판정 기준</h3>
    <dl>
      <dt>적용 최저임금</dt><dd>${basis.year}년 ${won(basis.min_hourly)}</dd>
      <dt>1주 소정근로</dt><dd>${basis.weekly_hours ? `${basis.weekly_hours}시간` : "<span class='muted'>미기재</span>"}</dd>
      <dt>월 소정근로(환산)</dt><dd>${basis.monthly_hours ? `${basis.monthly_hours}시간` : "<span class='muted'>계산 불가</span>"}</dd>
      <dt>상시 근로자 수</dt><dd>${basis.headcount != null ? `${basis.headcount}명` : "<span class='muted'>미기재</span>"}</dd>
      <dt>계약 형태</dt><dd>${contract.contract_type === "fixed_term" ? "기간제" : contract.contract_type === "permanent" ? "기간의 정함 없음" : "<span class='muted'>미기재</span>"}</dd>
    </dl>
    <p class="card__foot">
      상시 근로자 5인 미만이면 연장·야간·휴일 가산수당, 연차, 근로시간 제한이 적용되지 않습니다.
      계약서에 인원이 없으면 <b>5인 이상이라고 가정하지 않습니다.</b>
    </p>`;

  $("facts").innerHTML = `
    <h3>인식 결과</h3>
    <dl>
      <dt>페이지</dt><dd>${parse.pages}쪽</dd>
      <dt>읽어낸 글자</dt><dd>${parse.chars.toLocaleString("ko-KR")}자</dd>
      <dt>문서 인식</dt><dd>${parse.cached ? "캐시" : `${parse.elapsed_sec}초`}</dd>
      <dt>조항 추출</dt><dd>${esc(extract.model)} · ${extract.elapsed_sec}초</dd>
    </dl>
    <p class="card__foot">
      문서 인식은 Upstage Document Parse, 조항 추출은 Solar Pro가 합니다.
      <b>판정은 모델이 아니라 규칙 엔진이 계산합니다.</b>
    </p>`;

  $("duo").innerHTML = state.providers.map((p) => `
    <article class="answer" data-provider="${esc(p.id)}">
      <header class="answer__head">
        <span class="answer__dot answer__dot--live"></span>
        <span class="answer__name">${esc(p.label)}</span>
        <span class="answer__model">${esc(p.model)}</span>
        <span class="answer__stats">해설 대기 중…</span>
      </header>
      <div class="answer__body is-typing"></div>
    </article>`).join("");
}

function badge(level, count) {
  const cls = { violation: "danger", check: "brand", ok: "safe", excluded: "muted" }[level];
  return `<span class="badge badge--${cls}">${LEVELS[level].mark} ${LEVELS[level].label} ${count}</span>`;
}

function findingCard(f) {
  const parts = [`
    <article class="finding finding--${f.level}">
      <div class="finding__head">
        <span class="badge badge--${{ violation: "danger", check: "brand", ok: "safe", excluded: "muted" }[f.level]}">${LEVELS[f.level].mark} ${esc(f.level_label)}</span>
        <span class="finding__title">${esc(f.title)}</span>
        ${f.law ? `<span class="finding__law">${esc(f.law)}</span>` : ""}
      </div>
      <p class="finding__msg">${render(f.message)}</p>`];

  if (f.evidence) parts.push(`<blockquote class="finding__quote">${esc(f.evidence)}</blockquote>`);
  if (f.law_text) {
    parts.push(`<p class="finding__law-text">${esc(f.law)} (${esc(f.law_title)}) — ${esc(f.law_text)}`
      + (f.law_penalty ? ` <b>벌칙: ${esc(f.law_penalty)}</b>` : "") + "</p>");
  }
  if (f.detail) parts.push(`<p class="finding__detail">${esc(f.detail)}</p>`);
  if (f.fix) parts.push(`<p class="finding__fix">${render(f.fix)}</p>`);

  parts.push("</article>");
  return parts.join("");
}

// ── ② 해설 스트리밍 ───────────────────────────────────
async function streamOne(provider) {
  const card = $("duo").querySelector(`.answer[data-provider="${provider.id}"]`);
  if (!card) return;
  const body = card.querySelector(".answer__body");
  const stats = card.querySelector(".answer__stats");
  const dot = card.querySelector(".answer__dot");
  let text = "";

  try {
    const res = await fetch("/api/contract/explain/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ review_id: state.reviewId, provider: provider.id }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop();                       // 미완성 조각은 남겨둡니다
      for (const frame of frames) {
        if (!frame.startsWith("data:")) continue;
        const raw = frame.slice(5).trim();
        if (raw === "[DONE]") continue;
        const evt = JSON.parse(raw);

        if (evt.error) throw new Error(evt.error);
        if (evt.delta) { text += evt.delta; body.innerHTML = render(text); }
        if (evt.done) {
          if (evt.replacement) { text = evt.replacement; body.innerHTML = render(text); }
          if (evt.guardrail?.blocked) showGuardrail(card, evt.guardrail);
          stats.textContent = `${evt.elapsed_sec}초 · ${evt.chars}자`;
        }
      }
    }
  } catch (err) {
    body.classList.add("answer__error");
    body.innerHTML = render(text || `해설을 받지 못했습니다: ${err.message}`);
    stats.textContent = "실패";
  } finally {
    body.classList.remove("is-typing");
    dot.classList.remove("answer__dot--live");
  }
}

function showGuardrail(card, guard) {
  const box = document.createElement("div");
  box.className = `guard ${guard.replaced ? "" : "guard--warn"}`.trim();
  box.innerHTML = `
    <b>${guard.replaced ? "가드레일 차단" : "가드레일 경고"}</b> — ${guard.replaced
      ? "해설이 서비스 표현 기준을 벗어나 대체 문구로 교체됐습니다. <b>위 조항별 판정은 규칙 엔진이 계산한 것이라 그대로 유효합니다.</b>"
      : "표현 기준을 벗어났지만 경고 모드라 원문을 그대로 보여드립니다."}
    <ul>${guard.hits.map((h) => `<li>${esc(h.reason)} · <code>${esc(h.matched)}</code></li>`).join("")}</ul>`;
  card.appendChild(box);
}

init();
