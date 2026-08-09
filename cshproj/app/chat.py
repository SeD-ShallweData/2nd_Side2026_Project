"""대화 오케스트레이션.

학습노트의 프롬프트 체이닝 구조를 그대로 구현합니다.

    호출 ①  이력 + 질문  →  독립 질문으로 재작성     (rewrite)
        ↓   (RAG를 붙이면 여기서 검색이 일어납니다)
    호출 ②  참고 자료 + 질문  →  답변 생성            (answer / answer_stream)
        ↓
    후처리   가드레일 검사                            (guardrails)

호출 ①은 config.REWRITE_ENABLED 로 끄고 켤 수 있습니다.
끈 상태와 켠 상태의 답변 품질을 비교하는 것이 프로토타입 단계의 목적 중 하나입니다.
"""

import time
from typing import Iterator

from . import config, demo, guardrails, llm, prompts, store


# 사업장 조회 결과를 프롬프트에 넣을 때 붙이는 지시.
# 이 블록이 없으면 모델이 few-shot의 수치 패턴을 조회되지 않는 회사에까지 복사합니다.
WORKPLACE_DB_HEADER = """# 조회 결과 ({scope})

아래 <record> 가 **이 질문에 대해 조회된 사업장의 전부**다. 여기 없는 것은 쓸 수 없다.

- 조회된 사업장은 여기 적힌 수치만 쓴다. 반올림하거나 각색하지 않는다.
- **조회되지 않은 사업장을 물으면 "공개 데이터에서 찾지 못했습니다"라고 답한다.**
  가입자 수, 결측 개월, 명단 등재 여부를 **절대 추측해서 만들지 않는다.**
  대신 확인 가능한 경로(고용노동부 체불사업주 명단공개 페이지)를 안내하고,
  근로계약 전 확인할 일반 항목을 알려준다.
- 실명 대기업을 묻더라도 마찬가지다. 조회되지 않으면 조회되지 않는다고 말한다.
- **조회 결과가 비어 있으면 "조건에 맞는 사업장이 조회되지 않았습니다"라고 답한다.**
  다른 지역·업종의 사업장으로 대신 채우지 않는다.

<workplace_db>
{records}
</workplace_db>"""

EMPTY_DB = "(조건에 맞는 사업장이 조회되지 않았습니다)"
NO_TARGET_DB = ("(조회 대상이 지정되지 않았습니다. 사업장명 또는 지역·업종을 받기 전에는 "
                "어떤 사업장의 수치도 인용하지 않습니다.)")

AMBIGUOUS_HEADER = """# 조회 결과 — 동명 사업장 ({scope})

같은 이름의 사업장이 여러 곳 조회되어 **관측 지표를 아직 가져오지 않았습니다.**

- 아래 소재지와 설립연도만 나열하고, **어느 곳인지 되묻는다.**
- 가입자 수·이직률·고지금액·결측·명단 등재 여부를 **어느 쪽도 말하지 않는다.**
  여기 없는 값이므로 지어내면 안 된다.
- 두 곳을 비교하거나 한쪽을 추천하지 않는다.
- 확인 체크리스트도 아직 내지 않는다. 소재지를 받은 뒤에 낸다.

{records}"""

SAFETY_DB_HEADER = """# 산재 경보 조회 결과 ({scope})

아래 <alert> 가 **이 질문에 대해 산출된 경보의 전부**다.

- 등급·건수·신호는 여기 적힌 값만 쓴다. 다른 지역·업종의 값을 가져오지 않는다.
- **조회 결과가 비어 있으면 "해당 지역·업종은 이번 주 경보를 산출하지 않았습니다"라고 답한다.**
  등급을 추측해서 만들지 않는다. 건수가 적어 신뢰구간이 넓다는 뜻이며,
  안전하다는 뜻은 아니라는 점을 함께 말한다.
- 경보는 시도×업종 집계다. 개별 사업장에 적용하지 않는다.

<safety_alerts>
{alerts}
</safety_alerts>"""


# ── 이력 정리 ─────────────────────────────────────────────────────────
def _normalize_history(raw) -> list[dict]:
    """프런트에서 온 이력을 OpenAI messages 형태로 정리합니다."""
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        content = (item.get("content") or item.get("text") or "").strip()
        if not content:
            continue
        role = str(item.get("role", "user"))
        role = "assistant" if role.startswith(("assistant", "bot")) else "user"
        out.append({"role": role, "content": content})
    return out


def _tail(history: list[dict], turns: int) -> list[dict]:
    return history[-turns * 2:] if turns > 0 else []


# ── 호출 ① 질의 재작성 ────────────────────────────────────────────────
def rewrite_query(message: str, history=None, provider: str | None = None) -> dict:
    """후속 질문을 이력 없이도 이해되는 독립 질문으로 바꿉니다.

    반환: {"original", "rewritten", "changed", "elapsed_sec", "skipped"}
    실패하면 원문을 그대로 돌려줍니다. 재작성은 보조 기능이라
    여기서 막히면 전체 대화가 멈추는 편보다 그냥 통과하는 편이 낫습니다.
    """
    history = _normalize_history(history)
    base = {"original": message, "rewritten": message, "changed": False, "elapsed_sec": 0.0}

    if not config.REWRITE_ENABLED or not history:
        return {**base, "skipped": True}

    lines = [
        f"- {'사용자' if m['role'] == 'user' else '어시스턴트'}: {m['content'][:300]}"
        for m in _tail(history, config.REWRITE_HISTORY_TURNS)
    ]
    user_block = "이력:\n" + "\n".join(lines) + f"\n\n질문: {message}\n출력:"

    started = time.monotonic()
    try:
        result = llm.complete(
            [
                {"role": "system", "content": prompts.rewrite_prompt()},
                {"role": "user", "content": user_block},
            ],
            provider=provider or config.REWRITE_PROVIDER,
            temperature=0.0,
            max_tokens=config.REWRITE_MAX_TOKENS,
        )
    except llm.LLMError as exc:
        return {**base, "skipped": True, "error": str(exc)}

    rewritten = result["text"].strip().strip('"').split("\n")[0].strip()
    # 재작성이 실패하거나 엉뚱하게 길어지면 원문을 씁니다.
    if not rewritten or len(rewritten) > len(message) * 6 + 120:
        return {**base, "skipped": True}

    return {
        "original": message,
        "rewritten": rewritten,
        "changed": rewritten != message,
        "elapsed_sec": round(time.monotonic() - started, 2),
        "skipped": False,
    }


# ── 호출 ② 답변 생성 ──────────────────────────────────────────────────
def build_messages(message: str, persona: str, history=None) -> list[dict]:
    """system(계약+자료+페르소나+사업장DB+가드레일) → few-shot → 최근 이력 → 질문."""
    system = prompts.system_prompt(persona)

    # 사업장 조회를 하는 페르소나에는 조회 결과를 함께 넣습니다.
    # 지역·업종 필터는 **코드로** 겁니다. 모델에 맡기면 조건에 맞는 곳이 없을 때
    # 다른 지역·업종으로 채웁니다("제주도 숙박업 추천"에 서울 제조업을 답한 사례).
    ambiguous = False
    if prompts.uses_workplace_db(persona):
        rows, scope = demo.filter_records(message)
        if demo.is_ambiguous(rows):
            ambiguous = True
            # 동명 사업장에는 수치를 아예 주지 않습니다. 주면 인용합니다.
            system += "\n\n---\n\n" + AMBIGUOUS_HEADER.format(
                scope=scope, records=demo.as_choice_block(rows))
            rows = []
            records = None
        elif rows:
            records = demo.as_prompt_block(rows)
        elif scope.startswith("조회 대상 없음"):
            records = NO_TARGET_DB
        else:
            records = EMPTY_DB
        if records is not None:
            system += "\n\n---\n\n" + WORKPLACE_DB_HEADER.format(scope=scope, records=records)

    # 산재 경보도 같은 방식으로 조회 결과만 넣습니다.
    # 넣지 않으면 데이터에 없는 등급을 지어냅니다("제주 숙박업 주의 단계").
    if prompts.uses_safety_db(persona):
        alerts, ascope = demo.filter_alerts(message)
        system += "\n\n---\n\n" + SAFETY_DB_HEADER.format(
            scope=ascope, alerts=demo.alerts_prompt_block(alerts))

    # 동명 사업장은 지시가 중간에 묻히면 흘립니다. 맨 끝에 한 줄 더 박습니다.
    if ambiguous:
        system += ("\n\n---\n\n# 이번 답변에서 반드시 지킬 것\n\n"
                   "같은 이름의 사업장이 여러 곳 조회됐다. **소재지 목록만 보여주고 어느 곳인지 되묻고 끝낸다.**\n"
                   "관측 지표·명단 등재 여부·확인 체크리스트는 이번 답변에 넣지 않는다. "
                   "소재지를 받은 다음 턴에 안내한다.")

    messages = [{"role": "system", "content": system}]
    messages += prompts.few_shot(persona)
    messages += _tail(_normalize_history(history), config.MAX_HISTORY_TURNS)
    messages.append({"role": "user", "content": message})
    return messages


def _fact_records(question: str) -> list[dict]:
    """가드레일이 대조할 사실. 프롬프트에 넣은 것과 **같은 조회 결과**여야 합니다.

    실DB로 넘어가면 여기만 바꿉니다.
    """
    rows, _ = demo.filter_records(question)
    return [
        {"name": wp["name"],
         "defaulter_matched": wp["defaulter_matched"],
         "health_arrears_matched": wp["health_arrears_matched"]}
        for wp in rows
    ]


def _finish(text: str, meta: dict) -> dict:
    """가드레일을 적용하고 로그를 남깁니다."""
    question = meta.get("question") or ""
    records = _fact_records(question)
    if config.GUARDRAILS_ENABLED:
        final, verdict = guardrails.apply(text, records, question, config.GUARDRAIL_MODE)
    else:
        final, verdict = text, guardrails.inspect(text, records, question)

    store.log_turn({
        **meta,
        "answer": final,
        "raw_answer": text if verdict.blocked else None,
        "guardrail_blocked": verdict.blocked,
        "guardrail_replaced": verdict.replaced,
        "guardrail_mode": verdict.mode,
        "guardrail_hits": verdict.hits,
    })
    return {
        "text": final,
        "guardrail": {
            "blocked": verdict.blocked,
            "replaced": verdict.replaced,
            "mode": verdict.mode,
            "hits": verdict.hits,
        },
    }


def answer(message: str, persona: str, provider: str | None = None,
           history=None, resolved_query: str | None = None, **opts) -> dict:
    """한 번에 받는 응답."""
    query = (resolved_query or message).strip() or message
    started = time.monotonic()
    result = llm.complete(build_messages(query, persona, history), provider=provider, **opts)

    checked = _finish(result["text"], {
        "persona": persona,
        "provider": result["provider"],
        "model": result["model"],
        "question": message,
        "resolved_query": query if query != message else None,
        "usage": result.get("usage", {}),
        "elapsed_sec": round(time.monotonic() - started, 2),
        "streaming": False,
    })
    return {
        "text": checked["text"],
        "model": result["model"],
        "provider": result["provider"],
        "usage": result.get("usage", {}),
        "guardrail": checked["guardrail"],
        "elapsed_sec": round(time.monotonic() - started, 2),
    }


def answer_stream(message: str, persona: str, provider: str | None = None,
                  history=None, resolved_query: str | None = None, **opts) -> Iterator[dict]:
    """스트리밍 응답.

    조각을 흘려보낸 뒤 마지막에 가드레일 결과를 함께 내보냅니다.
    스트리밍 도중에는 문장이 완성되지 않아 검사가 불가능하므로,
    차단되면 프런트가 이미 그린 텍스트를 대체 문구로 교체합니다.
    """
    query = (resolved_query or message).strip() or message
    started = time.monotonic()
    collected: list[str] = []

    for piece in llm.stream(build_messages(query, persona, history), provider=provider, **opts):
        collected.append(piece)
        yield {"delta": piece}

    raw = "".join(collected)
    elapsed = round(time.monotonic() - started, 2)
    checked = _finish(raw, {
        "persona": persona,
        "provider": (provider or config.DEFAULT_PROVIDER).lower(),
        "model": config.PROVIDERS.get((provider or config.DEFAULT_PROVIDER).lower(), {}).get("model"),
        "question": message,
        "resolved_query": query if query != message else None,
        "elapsed_sec": elapsed,
        "streaming": True,
    })

    yield {
        "done": True,
        "elapsed_sec": elapsed,
        "chars": len(checked["text"]),
        "guardrail": checked["guardrail"],
        "replacement": checked["text"] if checked["guardrail"]["replaced"] else None,
    }
