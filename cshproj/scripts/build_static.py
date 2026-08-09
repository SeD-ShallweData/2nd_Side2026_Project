"""노션·메신저에 올릴 단일 HTML 파일을 만듭니다.

    .venv/bin/python scripts/build_static.py

왜 필요한가
  노션은 HTML을 실행해 주지 않습니다. 파일을 첨부하면 다운로드만 되고,
  css/js가 여러 파일로 쪼개져 있으면 열어도 디자인이 깨집니다.
  그래서 CSS·JS·데이터를 **한 파일 안에** 전부 넣습니다.

무엇이 들어가나
  · 랜딩 페이지 전체 (Figma 6개 섹션)
  · /api/demo/* 응답을 JSON으로 구워 넣어 서버 없이 동작
  · 실제 대화 기록으로 만든 **모델 비교 시연 화면** (상담은 백엔드가 필요해 정적 재현)

폰트는 파일에 넣지 않습니다. woff2 124개가 3.7MB라 첨부 한도를 넘기기 쉽습니다.
구글 폰트 CDN을 쓰고, 인터넷이 없으면 시스템 한글 폰트로 떨어집니다.
"""

import json
import re
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, demo, prompts  # noqa: E402

WEB = config.WEB_DIR
OUT_DIR = config.OUTPUT_DIR / "exports"

FONT_CDN = ('<link rel="preconnect" href="https://fonts.googleapis.com">\n'
            '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
            '<link rel="stylesheet" '
            'href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap">')


def read(rel: str) -> str:
    return (WEB / rel).read_text(encoding="utf-8")


def demo_transcript() -> dict:
    """실제 평가 결과에서 두 모델의 같은 질문 답변을 한 쌍 꺼냅니다."""
    files = sorted((config.EVAL_DIR).glob("*final-compare.jsonl"))
    want = "샘플A건설 어때요? 괜찮은 회사인가요?"
    picked = {}
    if files:
        for line in files[-1].read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            if row.get("question") == want and not row.get("error"):
                picked[row["provider"]] = {
                    "text": row["answer"],
                    "elapsed": row.get("elapsed_sec"),
                    "chars": len(row["answer"]),
                }
    return {"question": want, "answers": picked}


DEMO_SECTION = """
  <!-- ── 모델 비교 시연 (정적 재현) ──────────────────── -->
  <section class="section" id="compare">
    <div class="container">
      <span class="eyebrow">AI 상담</span>
      <h2 class="h2" style="margin-top:8px">같은 질문, 두 모델</h2>
      <p class="sec-head__sub" style="margin-bottom:28px">
        하나의 질문을 Upstage Solar와 SKT A.X에 동시에 보내 답변을 나란히 비교합니다.
        아래는 실제 실행 결과를 그대로 옮긴 것입니다.
      </p>

      <div class="ask" style="max-width:none">
        <span class="ask__avatar">나</span>
        <p class="ask__text" id="demo-q"></p>
      </div>
      <div class="duo" id="demo-duo"></div>

      <p class="notes" style="margin-top:18px">
        이 파일은 서버 없이 열어 보는 정적 사본입니다. 실제 서비스에서는 답변이 실시간으로 생성되고,
        답변 아래 버튼으로 어느 쪽이 나은지 투표할 수 있습니다.
      </p>
    </div>
  </section>
"""

DEMO_SCRIPT = """
// ── 정적 시연: 모델 비교 ──────────────────────────────
// landing.js 에는 마크다운 렌더러가 없어 여기서 정의합니다 (chat.js 와 동일 규칙).
function render(t) {
  return String(t ?? "")
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

(function () {
  const t = window.__DEMO__;
  if (!t || !Object.keys(t.answers).length) return;
  const label = { upstage: "Upstage Solar", skt: "SKT A.X" };
  const model = { upstage: "solar-pro3", skt: "A.X-K1" };
  document.getElementById("demo-q").textContent = t.question;
  document.getElementById("demo-duo").innerHTML = Object.entries(t.answers).map(([id, a]) => `
    <article class="answer">
      <header class="answer__head">
        <span class="answer__dot"></span>
        <span class="answer__name">${label[id] || id}</span>
        <span class="answer__model">${model[id] || ""}</span>
      </header>
      <div class="answer__body">${render(a.text)}</div>
      <footer class="answer__foot">
        <span class="answer__stats">${a.elapsed}초 · ${a.chars}자</span>
      </footer>
    </article>`).join("");
})();
"""

# 상담 화면의 대화 스타일을 이 파일에서도 쓰기 위해 필요한 최소 규칙만 가져옵니다.
CHAT_CSS_KEEP = (".ask", ".duo", ".answer", ".answer__head", ".answer__dot", ".answer__name",
                 ".answer__model", ".answer__body", ".answer__foot", ".answer__stats")


def chat_css_subset() -> str:
    css = read("css/chat.css")
    keep = []
    for block in re.findall(r"([^{}]+)\{([^}]*)\}", css):
        selector = block[0].strip()
        if any(selector.startswith(s) or f" {s}" in selector for s in CHAT_CSS_KEEP):
            keep.append(f"{selector} {{{block[1]}}}")
    return "\n".join(keep)


def build() -> Path:
    html = read("index.html")

    # 1) 폰트 — 로컬 woff2(3.7MB) 대신 CDN
    html = html.replace('<link rel="stylesheet" href="/css/fonts.css">', FONT_CDN)

    # 2) CSS 인라인
    css = "\n".join(read(f"css/{n}.css") for n in ("tokens", "base", "landing"))
    css += "\n\n/* 모델 비교 시연용 (chat.css 발췌) */\n" + chat_css_subset()
    html = re.sub(r'\n\s*<link rel="stylesheet" href="/css/(tokens|base|landing)\.css">', "", html)
    html = html.replace("</head>", f"<style>\n{css}\n</style>\n</head>")

    # 3) 서버 응답을 구워 넣고 fetch를 가로챕니다
    baked = {
        "/api/demo/community": {"items": demo.COMMUNITY, "stats": demo.STATS},
        "/api/demo/workplaces": {"items": demo.list_cards()},
        "/api/personas": {
            "personas": prompts.personas(),
            "providers": [{"id": n, "label": c["label"], "model": c["model"]}
                          for n, c in config.PROVIDERS.items()],
            "default_provider": config.DEFAULT_PROVIDER,
        },
    }
    shim = (
        "<script>\n"
        "// 서버 없이 열리도록 API 응답을 구워 넣었습니다.\n"
        f"window.__BAKED__ = {json.dumps(baked, ensure_ascii=False)};\n"
        f"window.__DEMO__ = {json.dumps(demo_transcript(), ensure_ascii=False)};\n"
        "window.fetch = (url) => {\n"
        "  const d = window.__BAKED__[url];\n"
        "  return d ? Promise.resolve({ ok: true, json: () => Promise.resolve(d) })\n"
        "           : Promise.reject(new Error('static build: ' + url));\n"
        "};\n"
        "</script>"
    )

    # 4) JS 인라인 (상담 화면 이동은 시연 섹션으로 대체)
    js = read("js/icons.js") + "\n" + read("js/landing.js")
    js = js.replace('const url = question ? `/chat?q=${encodeURIComponent(question)}` : "/chat";\n  location.href = url;',
                    'document.getElementById("compare").scrollIntoView({ behavior: "smooth" });')
    js += DEMO_SCRIPT
    html = html.replace('<script src="/js/icons.js"></script>\n<script src="/js/landing.js"></script>',
                        shim + f"\n<script>\n{js}\n</script>")

    # 5) 로고는 인라인 SVG로 (외부 파일 참조 제거)
    logo = read("assets/logo/logo.svg")
    html = html.replace('<link rel="icon" href="/assets/logo/favicon.svg">', "")
    html = html.replace('<img src="/assets/logo/logo.svg" alt="" class="brand-mark">', logo)

    # 6) 시연 섹션 삽입 + 상담 링크를 앵커로
    html = html.replace('  <!-- ── 마무리 CTA ────────────────────────────────── -->',
                        DEMO_SECTION + '\n  <!-- ── 마무리 CTA ────────────────────────────────── -->')
    html = html.replace('href="/chat"', 'href="#compare"')
    html = html.replace('<a class="brand" href="/">', '<a class="brand" href="#">')

    # 7) 정적 사본 표시
    stamp = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M")
    html = html.replace(
        "AI 상담만 실제 모델(Upstage·SKT)에 연결되어 있습니다.",
        f"AI 상담은 실제 실행 결과를 옮긴 <b>정적 사본</b>입니다. (내려받은 시각 {stamp})")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "돈워리-프로토타입.html"
    out.write_text(html, encoding="utf-8")
    return out


if __name__ == "__main__":
    path = build()
    size = path.stat().st_size
    left = re.findall(r'(?:src|href)="/(?!\#)[^"]*"', path.read_text(encoding="utf-8"))
    print(f"생성: {path}")
    print(f"크기: {size / 1024:.0f} KB")
    print(f"남은 외부 참조: {left or '없음 (자립 실행 가능)'}")
