// AI 상담 — 한 질문을 두 모델에 동시에 보내 답변을 나란히 비교합니다.
//
// 흐름
//   ① POST /api/rewrite        후속 질문을 독립 질문으로 재작성 (한 번만)
//   ② POST /api/chat/stream ×2  같은 질의로 두 모델을 동시에 스트리밍
//   ③ POST /api/feedback        어느 쪽이 나은지 투표 → outputs/feedback/

const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 최소한의 마크다운만 지원합니다 (굵게, 인라인 코드).
const render = (t) => esc(t)
  .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  .replace(/`([^`]+)`/g, "<code>$1</code>");

const state = {
  personas: [],
  providers: [],
  persona: "general",
  history: [],      // [{role, content}] — 대표 모델의 답변만 쌓습니다
  busy: false,
  turn: 0,
  config: {},
};

// ── 초기화 ────────────────────────────────────────────
async function init() {
  try {
    const data = await fetch("/api/personas").then((r) => r.json());
    state.personas = data.personas || [];
    state.providers = data.providers || [];
    state.config = data;
  } catch {
    $("hint").textContent = "서버에 연결하지 못했습니다. ./run.sh 가 실행 중인지 확인하세요.";
    return;
  }

  renderPersonas();
  renderStatus();
  updateHint();

  // 랜딩에서 ?q= 로 넘어온 질문은 바로 보냅니다.
  const q = new URLSearchParams(location.search).get("q");
  if (q) { $("input").value = q; submit(); }
}

function renderPersonas() {
  $("persona").innerHTML = state.personas.map((p) => `
    <button class="persona__btn" data-id="${esc(p.id)}" aria-pressed="${p.id === state.persona}">
      <div class="persona__name">${esc(p.label)}</div>
      <div class="persona__desc">${esc(p.description)}</div>
    </button>`).join("");

  [...$("persona").children].forEach((btn) => {
    btn.onclick = () => {
      state.persona = btn.dataset.id;
      [...$("persona").children].forEach((b) =>
        b.setAttribute("aria-pressed", String(b.dataset.id === state.persona)));
      renderSamples();
      reset();
    };
  });
  renderSamples();
}

function renderSamples() {
  const p = state.personas.find((x) => x.id === state.persona);
  $("samples").innerHTML = (p?.suggestions || [])
    .map((s) => `<button type="button">${esc(s)}</button>`).join("");
  [...$("samples").children].forEach((btn) => {
    btn.onclick = () => { $("input").value = btn.textContent; submit(); };
  });
}

function renderStatus() {
  const row = (k, on, extra = "") =>
    `<div><span>${k}</span><span class="badge ${on ? "badge--safe" : "badge--muted"}">${on ? "ON" : "OFF"}${extra}</span></div>`;
  const mode = state.config.guardrail_mode || "block";
  $("status").innerHTML =
    row("질의 재작성", state.config.rewrite_enabled) +
    row("출력 가드레일", state.config.guardrails_enabled,
        state.config.guardrails_enabled ? ` · ${mode}` : "") +
    `<div><span>비교 모델</span><span class="badge badge--muted">${state.providers.length}개</span></div>`;
}

function updateHint() {
  // 키가 없으면 질문을 보내 봐야 빈 화면만 나옵니다. 보내기 전에 알립니다.
  if (!state.providers.length) {
    $("hint").textContent = state.config.key_file_error
      ? `사용할 수 있는 모델이 없습니다 — 서버가 키 파일을 ${state.config.key_file_error}`
      : "사용할 수 있는 모델이 없습니다. scripts/check_env.py 로 키 상태를 확인하세요.";
    $("send").disabled = true;
    $("input").disabled = true;
    $("input").placeholder = "API 키가 없어 상담을 이용할 수 없습니다.";
    return;
  }
  const names = state.providers.map((p) => `${p.label} (${p.model})`).join(" · ");
  $("hint").textContent =
    `${names} 에 동시에 질문합니다. 답변 아래 버튼으로 어느 쪽이 나은지 남기면 outputs/feedback/ 에 기록됩니다.`;
}

// ── 전송 ──────────────────────────────────────────────
async function submit() {
  const message = $("input").value.trim();
  if (!message || state.busy) return;

  state.busy = true;
  $("send").disabled = true;
  $("input").value = "";
  $("input").style.height = "auto";
  $("empty")?.remove();

  const turnId = ++state.turn;
  const historySnapshot = state.history.slice();
  const turnEl = createTurn(turnId, message);

  // ① 질의 재작성 — 두 모델이 같은 질의로 출발하도록 한 번만 호출합니다.
  let resolved = message;
  if (state.config.rewrite_enabled && historySnapshot.length) {
    try {
      const rw = await fetch("/api/rewrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history: historySnapshot }),
      }).then((r) => r.json());

      if (rw.changed) {
        resolved = rw.rewritten;
        turnEl.querySelector(".rewrite").innerHTML =
          `<b>질의 재작성</b> — 이력을 참고해 독립 질문으로 바꿔 두 모델에 보냅니다.<br>“${esc(rw.rewritten)}”`;
        turnEl.querySelector(".rewrite").hidden = false;
      }
    } catch { /* 재작성은 보조 기능이라 실패해도 그냥 진행합니다 */ }
  }

  // ② 두 모델 동시 스트리밍
  const results = await Promise.all(state.providers.map((p) =>
    streamOne(turnEl, p, { message, resolved, history: historySnapshot })));

  // 대화 이력에는 기본 모델의 답변을 쌓습니다. 투표하면 그쪽으로 교체됩니다.
  const primary = results.find((r) => r.provider === state.config.default_provider) || results[0];
  state.history.push({ role: "user", content: message });
  state.history.push({ role: "assistant", content: primary?.text || "" });

  wireVotes(turnEl, message, results);

  state.busy = false;
  $("send").disabled = false;
  $("input").focus();
}

function createTurn(turnId, message) {
  const el = document.createElement("section");
  el.className = "turn";
  el.dataset.turn = turnId;
  el.innerHTML = `
    <div class="ask">
      <span class="ask__avatar">나</span>
      <p class="ask__text">${esc(message)}</p>
    </div>
    <div class="rewrite" hidden></div>
    <div class="duo">
      ${state.providers.map((p) => `
        <article class="answer" data-provider="${esc(p.id)}">
          <header class="answer__head">
            <span class="answer__dot answer__dot--live"></span>
            <span class="answer__name">${esc(p.label)}</span>
            <span class="answer__model">${esc(p.model)}</span>
          </header>
          <div class="answer__body is-typing"></div>
          <footer class="answer__foot">
            <span class="answer__stats">응답 대기 중…</span>
            <button class="vote" type="button" aria-pressed="false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><use href="#i-thumbs-up"/></svg>
              이쪽이 낫다
            </button>
          </footer>
        </article>`).join("")}
    </div>`;
  $("thread").querySelector(".thread__inner").appendChild(el);
  scrollDown();
  return el;
}

async function streamOne(turnEl, provider, { message, resolved, history }) {
  const card = turnEl.querySelector(`.answer[data-provider="${provider.id}"]`);
  const body = card.querySelector(".answer__body");
  const stats = card.querySelector(".answer__stats");
  const dot = card.querySelector(".answer__dot");
  let text = "";

  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message, persona: state.persona, provider: provider.id,
        history, resolved_query: resolved,
      }),
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

        if (evt.delta) {
          text += evt.delta;
          body.innerHTML = render(text);
          scrollDown();
        }

        if (evt.done) {
          if (evt.replacement) {                   // 가드레일에 걸려 교체된 경우
            text = evt.replacement;
            body.innerHTML = render(text);
          }
          if (evt.guardrail?.blocked) showGuardrail(card, evt.guardrail);
          stats.innerHTML = `${evt.elapsed_sec}초 · ${evt.chars}자`;
        }
      }
    }
  } catch (err) {
    body.classList.add("answer__error");
    text = text || `응답을 받지 못했습니다: ${err.message}`;
    body.innerHTML = render(text);
    stats.textContent = "실패";
  } finally {
    body.classList.remove("is-typing");
    dot.classList.remove("answer__dot--live");
  }

  return { provider: provider.id, label: provider.label, model: provider.model, text };
}

function showGuardrail(card, guard) {
  const replaced = guard.replaced;
  const box = document.createElement("div");
  box.className = `guard ${replaced ? "" : "guard--warn"}`.trim();
  box.innerHTML = `
    <b>${replaced ? "가드레일 차단" : "가드레일 경고"}</b> — ${replaced
      ? "이 답변은 서비스 표현 기준을 벗어나 대체 문구로 교체됐습니다."
      : "표현 기준을 벗어났지만 경고 모드라 원문을 그대로 보여드립니다. (block 모드에서는 교체됩니다)"}
    <ul>${guard.hits.map((h) => `<li>${esc(h.reason)} · <code>${esc(h.matched)}</code></li>`).join("")}</ul>`;
  card.querySelector(".answer__foot").before(box);
}

function wireVotes(turnEl, question, results) {
  turnEl.querySelectorAll(".answer").forEach((card) => {
    const btn = card.querySelector(".vote");
    btn.onclick = async () => {
      turnEl.querySelectorAll(".answer").forEach((c) => {
        c.classList.remove("answer--won");
        c.querySelector(".vote").setAttribute("aria-pressed", "false");
      });
      card.classList.add("answer--won");
      btn.setAttribute("aria-pressed", "true");

      const winner = card.dataset.provider;

      // 마지막 assistant 이력을 선택한 모델의 답변으로 교체합니다.
      const chosen = results.find((r) => r.provider === winner);
      if (chosen && state.history.length) {
        state.history[state.history.length - 1] = { role: "assistant", content: chosen.text };
      }

      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          winner, persona: state.persona, question,
          answers: Object.fromEntries(results.map((r) => [r.provider, r.text])),
        }),
      }).catch(() => {});
    };
  });
}

function scrollDown() { $("thread").scrollTop = $("thread").scrollHeight; }

function reset() {
  state.history = [];
  state.turn = 0;
  $("thread").querySelector(".thread__inner").innerHTML = `
    <div class="empty" id="empty">
      <div class="empty__avatar">
        <svg viewBox="0 0 24 24" fill="none" stroke="#191f28" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></svg>
      </div>
      <h2>무엇을 도와드릴까요?</h2>
      <p>왼쪽에서 상담 유형을 고르거나, 예시 질문을 눌러 보세요.</p>
    </div>`;
}

// ── 이벤트 ────────────────────────────────────────────
$("composer").addEventListener("submit", (e) => { e.preventDefault(); submit(); });

$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
});

$("input").addEventListener("input", () => {
  $("input").style.height = "auto";
  $("input").style.height = `${$("input").scrollHeight}px`;
});

$("reset").addEventListener("click", reset);

init();
