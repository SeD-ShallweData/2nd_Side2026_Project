"""근로계약서 진단 오케스트레이션.

    호출 ①  PDF·이미지  →  Document Parse  →  마크다운          (parse.py)
        ↓
    호출 ②  마크다운  →  LLM  →  조항 JSON                       (extract)
        ↓
    판정     조항 JSON  →  **규칙 엔진(코드)**  →  조항별 판정     (rules.py)
        ↓
    호출 ③  판정 결과  →  LLM  →  사람이 읽는 해설               (explain)
        ↓
    후처리   계약서 전용 가드레일                                  (guard.py)

호출 ②와 ③ 사이에 LLM이 없는 층이 하나 끼어 있는 것이 이 설계의 요점입니다.
최저임금 미달 여부는 나눗셈이고, 나눗셈을 모델에 맡기면 같은 계약서에서 다른 답이 나옵니다.
모델은 **읽기(②)와 쓰기(③)만** 하고 **판정은 하지 않습니다.**

호출 ③만 프로바이더를 바꿀 수 있습니다. 판정이 고정돼 있으므로 두 모델을 비교해도
사실이 흔들리지 않고 설명 품질만 비교됩니다.
"""

import threading
import time
from collections import OrderedDict
from typing import Iterator

from .. import config, llm, prompts, store
from . import guard, parse, rules, schema, standards

# 규칙 엔진의 판정을 해설 프롬프트에 넣을 때 붙이는 지시.
# 이 블록이 없으면 모델이 계약서 원문을 다시 읽고 자기 판단을 섞습니다.
VERDICT_HEADER = """# 판정 결과

아래 <verdict> 는 규칙 엔진이 계약서를 법정 기준과 대조해 **이미 내린 판정**이다.
이것이 이 답변의 유일한 사실 근거다.

- 판정(level)을 올리거나 내리지 않는다. `확인 필요`를 `법정 기준 미달`로 바꾸지 않는다.
- 여기 없는 조항을 새로 지적하지 않는다. 여기 없다는 것은 **판정하지 않았다**는 뜻이지
  문제없다는 뜻이 아니다. "그 밖의 조항은 적법합니다"라고 쓰지 않는다.
- `law_text` 에 적힌 문장만 조문 설명으로 쓴다. 조문 번호를 새로 만들지 않는다.
- `detail` 의 계산 근거(환산 시급, 월 소정근로시간)를 그대로 옮긴다. 다시 계산하지 않는다.
- `evidence` 가 있으면 계약서 원문 그대로 인용부호 안에 넣는다.

<verdict>
{verdict}
</verdict>

# 계약서에서 읽어낸 값 (참고)

판정에 쓰인 값이다. 여기 없는 사실을 지어내지 않는다.

<extracted>
{extracted}
</extracted>"""

NOT_A_CONTRACT = ("올려주신 문서에서 근로계약서로 볼 만한 내용을 찾지 못했습니다. "
                  "근로계약서 원본(사진·스캔본도 가능)을 올려 주세요.")


class ReviewError(RuntimeError):
    pass


# ── 호출 ② 조항 구조화 추출 ───────────────────────────────────────────
def extract_clauses(parsed: dict, provider: str | None = None) -> dict:
    """파싱된 계약서 텍스트에서 조항·수치를 뽑아 정규화합니다.

    반환: {"contract", "raw", "provider", "model", "elapsed_sec", "usage", "not_a_contract"}
    """
    started = time.monotonic()
    result = llm.complete(
        [
            {"role": "system", "content": prompts.contract_extract_prompt()},
            {"role": "user", "content": parse.as_prompt_block(parsed)},
        ],
        provider=provider or config.CONTRACT_EXTRACT_PROVIDER,
        temperature=0.0,
        max_tokens=config.CONTRACT_EXTRACT_MAX_TOKENS,
    )

    raw = schema.parse_json(result["text"])
    if raw is None:
        raise ReviewError("계약서에서 조항을 읽어내지 못했습니다 (모델 응답을 JSON으로 파싱하지 못함). "
                          "잠시 후 다시 시도해 주세요.")

    # 인용문이 계약서 본문에 실제로 있는지 대조합니다. 없는 인용은 버립니다.
    # 모델이 조항 코드 표를 체크리스트로 훑어 전 항목을 나열하는 사례가 있었습니다.
    contract, dropped = schema.verify_quotes(schema.normalize(raw), parsed["markdown"])

    return {
        "contract": contract,
        "dropped_clauses": dropped,
        "not_a_contract": bool(raw.get("not_a_contract")),
        "provider": result["provider"],
        "model": result["model"],
        "usage": result.get("usage", {}),
        "elapsed_sec": round(time.monotonic() - started, 2),
    }


# ── 호출 ③ 해설 ───────────────────────────────────────────────────────
def _verdict_block(verdict: dict, contract: dict) -> str:
    """판정 결과와 추출값을 프롬프트용 텍스트로 만듭니다."""
    lines = [f"headline: {verdict['headline']}", ""]
    for row in verdict["findings"]:
        lines.append(f"- [{row['level_label']}] {row['title']} ({row['code']})")
        lines.append(f"  판정: {row['message']}")
        if row.get("law"):
            lines.append(f"  조문: {row['law']} — {row['law_title']}")
            lines.append(f"  law_text: {row['law_text']}")
            if row.get("law_penalty"):
                lines.append(f"  벌칙: {row['law_penalty']}")
        if row.get("detail"):
            lines.append("  detail: " + row["detail"].replace("\n", " / "))
        if row.get("evidence"):
            lines.append(f'  evidence: "{row["evidence"]}"')
        if row.get("fix"):
            lines.append(f"  fix: {row['fix']}")
        lines.append("")

    basis = verdict["basis"]
    extracted = [
        f"- 상시 근로자 수: {basis['headcount'] if basis['headcount'] is not None else '미기재'}",
        f"- 1주 소정근로시간: {basis['weekly_hours'] or '미기재'}",
        f"- 월 소정근로시간(환산): {basis['monthly_hours'] or '계산 불가'}",
        f"- 임금: {contract['wage']['type'] or '미기재'} "
        f"{contract['wage']['amount'] or '미기재'}",
        f"- 계약 형태: {contract['contract_type'] or '미기재'}",
        f"- 적용 최저임금: {basis['year']}년 시급 {basis['min_hourly']:,}원",
    ]
    return VERDICT_HEADER.format(verdict="\n".join(lines).strip(),
                                 extracted="\n".join(extracted))


def _verdict_laws(verdict: dict) -> set[str]:
    return {row["law"] for row in verdict["findings"] if row.get("law")}


def _explain_messages(verdict: dict, contract: dict, question: str | None) -> list[dict]:
    system = prompts.system_prompt("contract_review")
    system += "\n\n---\n\n" + _verdict_block(verdict, contract)
    user = (question or "").strip() or \
        "올린 근로계약서의 진단 결과를 설명해 주세요."
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def explain(verdict: dict, contract: dict, provider: str | None = None,
            question: str | None = None) -> dict:
    """판정 결과를 사람이 읽는 해설로 옮깁니다."""
    started = time.monotonic()
    result = llm.complete(
        _explain_messages(verdict, contract, question),
        provider=provider,
        temperature=0.0,
        max_tokens=config.CONTRACT_EXPLAIN_MAX_TOKENS,
    )
    text, checked = guard.apply(result["text"], _verdict_laws(verdict), config.GUARDRAIL_MODE)
    return {
        "text": text,
        "provider": result["provider"],
        "model": result["model"],
        "usage": result.get("usage", {}),
        "elapsed_sec": round(time.monotonic() - started, 2),
        "guardrail": {"blocked": checked.blocked, "replaced": checked.replaced,
                      "mode": checked.mode, "hits": checked.hits},
    }


def explain_stream(verdict: dict, contract: dict, provider: str | None = None,
                   question: str | None = None) -> Iterator[dict]:
    """해설 스트리밍. 마지막에 가드레일 결과를 함께 내보냅니다."""
    started = time.monotonic()
    collected: list[str] = []
    for piece in llm.stream(_explain_messages(verdict, contract, question),
                            provider=provider, temperature=0.0,
                            max_tokens=config.CONTRACT_EXPLAIN_MAX_TOKENS):
        collected.append(piece)
        yield {"delta": piece}

    raw = "".join(collected)
    text, checked = guard.apply(raw, _verdict_laws(verdict), config.GUARDRAIL_MODE)
    yield {
        "done": True,
        "elapsed_sec": round(time.monotonic() - started, 2),
        "chars": len(text),
        "guardrail": {"blocked": checked.blocked, "replaced": checked.replaced,
                      "mode": checked.mode, "hits": checked.hits},
        "replacement": text if checked.replaced else None,
    }


# ── 전체 파이프라인 ───────────────────────────────────────────────────
def review(data: bytes, filename: str = "contract.pdf", *,
           ocr: str = "auto", year: int | None = None,
           extract_provider: str | None = None,
           explain_provider: str | None = None,
           with_explanation: bool = True) -> dict:
    """업로드된 파일 하나를 끝까지 진단합니다.

    해설(호출 ③)은 `with_explanation=False`로 끌 수 있습니다.
    프런트가 판정을 먼저 그리고 해설을 스트리밍으로 따로 받을 때 씁니다.
    """
    parse.check_upload(filename, data)
    parsed = parse.parse_document(data, filename, ocr=ocr)

    extracted = extract_clauses(parsed, extract_provider)
    if extracted["not_a_contract"]:
        return {
            "ok": False,
            "reason": "not_a_contract",
            "message": NOT_A_CONTRACT,
            "parse": _parse_meta(parsed),
        }

    contract = extracted["contract"]
    verdict = rules.evaluate(contract, year)
    _log(parsed, contract, verdict, extracted)

    out = {
        "ok": True,
        "parse": _parse_meta(parsed),
        "contract": contract,
        "verdict": verdict,
        "extract": {k: extracted[k] for k in ("provider", "model", "elapsed_sec", "usage")},
    }
    if with_explanation:
        out["explanation"] = explain(verdict, contract, explain_provider)
    return out


def _log(parsed: dict, contract: dict, verdict: dict, extracted: dict) -> None:
    """규칙을 고칠 때 필요한 것만 남깁니다.

    계약서 본문·원문 인용·사업장명·근로자명은 **남기지 않습니다.**
    파일 해시가 있으므로 같은 계약서인지 구분하는 데는 지장이 없습니다.
    """
    store.log_contract_review({
        "digest": parsed["digest"],
        "pages": parsed["pages"],
        "chars": len(parsed["markdown"]),
        "extract_model": extracted["model"],
        "extract_sec": extracted["elapsed_sec"],
        "counts": verdict["counts"],
        "basis": verdict["basis"],
        "findings": [{"code": f["code"], "level": f["level"]} for f in verdict["findings"]],
        "clause_codes": [c["code"] for c in contract["clauses"]],
    })


def _parse_meta(parsed: dict) -> dict:
    """파싱 결과 중 화면·로그에 내보낼 것만. 본문 전체는 응답에 싣지 않습니다."""
    return {
        "digest": parsed["digest"],
        "pages": parsed["pages"],
        "chars": len(parsed["markdown"]),
        "cached": parsed.get("cached", False),
        "elapsed_sec": parsed.get("elapsed_sec", 0.0),
        "model": parsed.get("model"),
    }


# ── 진행 중인 진단 보관 ───────────────────────────────────────────────
# 프런트가 판정을 먼저 받아 그리고, 해설은 두 모델로 나눠 스트리밍합니다.
# 그때 계약 내용을 브라우저가 되돌려 보내게 하면 조작된 판정으로 해설을 만들 수 있어
# 서버가 들고 있습니다. **프로세스 메모리라 재시작하면 사라집니다** — 프로토타입 전제입니다.
_REVIEWS: "OrderedDict[str, dict]" = OrderedDict()
_REVIEW_LOCK = threading.Lock()
REVIEW_TTL_SEC = 30 * 60
REVIEW_MAX = 50


def remember(review_id: str, payload: dict) -> None:
    with _REVIEW_LOCK:
        _REVIEWS[review_id] = {"at": time.time(), **payload}
        _REVIEWS.move_to_end(review_id)
        while len(_REVIEWS) > REVIEW_MAX:
            _REVIEWS.popitem(last=False)


def recall(review_id: str) -> dict | None:
    now = time.time()
    with _REVIEW_LOCK:
        for key in [k for k, v in _REVIEWS.items() if now - v["at"] > REVIEW_TTL_SEC]:
            _REVIEWS.pop(key, None)
        return _REVIEWS.get(review_id)


# ── 점검용 ────────────────────────────────────────────────────────────
def standards_summary() -> dict:
    """/api/health 에 실을 기준값 요약. 화면과 문서의 숫자가 어긋나는지 확인용."""
    wage = standards.min_wage()
    return {
        "min_wage_year": standards.min_wage_year(),
        "min_wage_hourly": wage["hourly"],
        "min_wage_monthly_209": wage["monthly_209"],
        "laws": len(standards.LAWS),
        "rules": len(rules.RULES),
        "clause_codes": len(schema.CLAUSE_CODES),
    }
