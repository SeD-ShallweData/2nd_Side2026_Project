"""환경 점검. 키·경로·프롬프트·API 연결을 한 번에 확인합니다.

    .venv/bin/python scripts/check_env.py
    .venv/bin/python scripts/check_env.py --no-api   # API 호출 없이 로컬만 점검
"""

import argparse
import json
import shutil
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, llm, prompts  # noqa: E402

OK, NG, WARN = "  OK ", "  실패", "  주의"


def check_keys() -> bool:
    print("\n[1] API 키")
    print(f"  키 파일: {config.TEAM_ENV_FILE}")
    if config.LOCAL_ENV_FILE.exists():
        print(f"  로컬 오버라이드: {config.LOCAL_ENV_FILE}")

    ok = True
    for name, cfg in config.PROVIDERS.items():
        state = OK if cfg["api_key"] else NG
        print(f"{state} {name:8s} {config.masked(cfg['api_key'])}  model={cfg['model']}")
        ok = ok and bool(cfg["api_key"])

    if config.TEAM_ENV_ERROR:
        # 로컬 config.env 가 키를 채웠다면 팀 파일을 못 읽는 것은 치명적이지 않습니다.
        if config.available_providers():
            print(f"{WARN} 팀 공용 키 파일을 {config.TEAM_ENV_ERROR}")
            print(f"       지금은 {config.LOCAL_ENV_FILE.name} 의 값으로 동작 중입니다.")
            print(f"       권한이 복구되면 지우세요:  "
                  f".venv/bin/python scripts/set_local_keys.py --remove")
        else:
            print(f"{NG} 팀 공용 키 파일을 {config.TEAM_ENV_ERROR}")
            print(f"       권한 확인 :  ls -l {config.TEAM_ENV_FILE}")
            print(f"       권한 복구 :  sudo chmod 644 {config.TEAM_ENV_FILE}")
            print(f"       임시 우회 :  .venv/bin/python scripts/set_local_keys.py")
            print(f"       서버는 뜹니다 — 화면·더미 데이터는 정상이고 LLM 기능만 막힙니다.")
    return ok


def check_paths() -> bool:
    print("\n[2] 경로")
    ok = True
    targets = [
        ("prompts", config.PROMPT_DIR, False),
        ("knowledge", config.KNOWLEDGE_DIR, False),
        ("web", config.WEB_DIR, False),
        ("prompts/rewrite", config.PROMPT_DIR / "rewrite", False),
        ("data", config.DATA_DIR, True),
        ("outputs", config.OUTPUT_DIR, True),
        ("design", config.DESIGN_DIR, True),
    ]
    for label, path, is_link in targets:
        exists = path.exists()
        arrow = f" -> {path.resolve()}" if is_link and exists else ""
        print(f"{OK if exists else NG} {label:10s} {path}{arrow}")
        ok = ok and exists

    total, used, free = shutil.disk_usage("/")
    print(f"{WARN if free < 5 << 30 else OK} 홈 디스크 여유 {free / (1 << 30):.0f}G")
    _, _, dfree = shutil.disk_usage("/data")
    print(f"{OK} /data 여유 {dfree / (1 << 30):.0f}G")
    return ok


def check_prompts() -> bool:
    print("\n[3] 프롬프트 · 지식")
    try:
        registry = prompts.load_registry()
    except Exception as exc:
        print(f"{NG} registry.json 로드 실패: {exc}")
        return False

    ok = True
    for pid in registry:
        try:
            text = prompts.system_prompt(pid)
            shots = len(prompts.few_shot(pid)) // 2
            print(f"{OK} {pid:14s} system {len(text):>6,}자 · few-shot {shots}개")
        except Exception as exc:
            print(f"{NG} {pid:14s} {exc}")
            ok = False

    for topic, stat in prompts.knowledge_stats().items():
        files = ", ".join(stat["files"]) or "(비어 있음)"
        mark = OK if stat["files"] else WARN
        print(f"{mark} knowledge/{topic:8s} {stat['chars']:>6,}자 · {files}")
    return ok


def check_contract() -> bool:
    """근로계약서 진단이 돌아갈 준비가 됐는지. API는 부르지 않습니다."""
    print("\n[4] 근로계약서 진단")
    from app.contract import review, rules, standards

    ok = True
    summary = review.standards_summary()
    print(f"{OK} 기준값       {summary['min_wage_year']}년 최저임금 시급 "
          f"{summary['min_wage_hourly']:,}원 · 월 환산 {summary['min_wage_monthly_209']:,}원")
    print(f"{OK} 규칙 엔진     규칙 {summary['rules']}개 · 조문 {summary['laws']}개 · "
          f"조항코드 {summary['clause_codes']}개")

    if standards.min_wage_year() != date.today().year:
        print(f"{WARN} 최저임금     {date.today().year}년 값이 없어 "
              f"{standards.min_wage_year()}년 값을 씁니다. standards.MIN_WAGE 갱신 필요")

    # 조문 표에 없는 조문을 규칙이 인용하면 여기서 걸립니다.
    for spec in rules.CLAUSE_RULES.values():
        if spec["law"] and spec["law"] not in standards.LAWS:
            print(f"{NG} 조문 표      규칙이 표에 없는 조문을 인용합니다: {spec['law']}")
            ok = False

    font = config.FONT_DIR / "NotoSansKR.ttf"
    print(f"{OK if font.exists() else WARN} 한글 폰트     {font}"
          f"{'' if font.exists() else '  (없음 — 더미 계약서 생성 시 --download-font)'}")

    manifest = config.CONTRACT_SAMPLE_DIR / "manifest.json"
    if manifest.exists():
        items = json.loads(manifest.read_text(encoding="utf-8"))["samples"]
        missing = [s["file"] for s in items
                   if not (config.CONTRACT_SAMPLE_DIR / s["file"]).exists()]
        mark = NG if missing else OK
        print(f"{mark} 더미 계약서   {len(items) - len(missing)}/{len(items)}건 "
              f"· {config.CONTRACT_SAMPLE_DIR}")
        ok = ok and not missing
    else:
        print(f"{WARN} 더미 계약서   없음 — .venv/bin/python scripts/make_contract_samples.py")

    print(f"{OK} Document Parse  {config.PROVIDERS['upstage']['api_key'] and '키 있음' or '키 없음'}"
          f"  (실호출 점검은 scripts/check_contract_api.py)")
    return ok


def check_api() -> bool:
    print("\n[5] API 연결")
    ok = True
    probe = [{"role": "user", "content": "한 단어로만 답하세요: 안녕"}]
    for name in config.PROVIDERS:
        if not config.PROVIDERS[name]["api_key"]:
            print(f"{WARN} {name:8s} 키가 없어 건너뜁니다")
            continue
        try:
            res = llm.complete(probe, provider=name, max_tokens=20)
            print(f"{OK} {name:8s} {res['model']} → {res['text'].strip()[:40]!r}")
        except llm.LLMError as exc:
            print(f"{NG} {name:8s} {exc}")
            ok = False
    return ok


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-api", action="store_true", help="API 호출 생략")
    args = parser.parse_args()

    print("=" * 60)
    print("환경 점검")
    print("=" * 60)

    results = [check_keys(), check_paths(), check_prompts(), check_contract()]
    if not args.no_api:
        results.append(check_api())

    print("\n" + "=" * 60)
    if all(results):
        print("모두 정상입니다. ./run.sh 로 서버를 띄우세요.")
    else:
        print("실패 항목이 있습니다. 위 로그를 확인하세요.")
        sys.exit(1)


if __name__ == "__main__":
    main()
