#!/usr/bin/env bash
# 돈워리 배포 이력 조회 — /srv/moneyworry/deploy.log 를 사람이 읽는 표로 만든다.
#
# 사용법:
#   moneyworry-deploy-log                 최근 15건 표
#   moneyworry-deploy-log --limit 50      건수 지정
#   moneyworry-deploy-log --last          마지막 1건 전체 + 전문 꼬리
#   moneyworry-deploy-log --failures      실패·관문정지·중단만
#   moneyworry-deploy-log --sha <sha>     그 커밋의 모든 시도
#   moneyworry-deploy-log --acks          관문 승인 감사 기록
#
# 읽기 전용이라 /usr/local/bin 에 둔다(배포기·래퍼는 /usr/local/sbin).
# 원장 자체는 0644 라 sudo 없이 읽힌다. --last 의 전문 꼬리만 root 가 필요하다 —
# 전문에는 빌드 출력이 통째로 들어가 무엇이 섞일지 미리 알 수 없기 때문이다.
#
#   sudo install -m 0755 -o root -g root \
#     infra/scripts/deploy-log.sh /usr/local/bin/moneyworry-deploy-log
#
# 형식과 필드 뜻은 infra/DEPLOY_HISTORY.md 참고.

set -Eeuo pipefail
export TZ='Asia/Seoul'

LEDGER="${MW_DEPLOY_LEDGER:-/srv/moneyworry/deploy.log}"
TRANSCRIPT_DIR="${MW_DEPLOY_TRANSCRIPTS:-/srv/moneyworry/deploy-logs}"

case "${1:-}" in
  -h|--help) awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "$0"; exit 0 ;;
esac

if [[ ! -r $LEDGER ]]; then
  printf '아직 배포 기록이 없습니다 (%s).\n' "$LEDGER"
  printf '배포는 moneyworry-deploy-run 으로 해야 기록이 남습니다.\n'
  exit 0
fi

python3 - "$LEDGER" "$TRANSCRIPT_DIR" "$@" <<'PY'
import json
import sys
import unicodedata
from pathlib import Path

ledger, transcript_dir, *argv = sys.argv[1:]

MODE = "recent"
LIMIT = 15
SHA = ""
i = 0
while i < len(argv):
    a = argv[i]
    if a == "--last":
        MODE = "last"
    elif a == "--failures":
        MODE = "failures"
    elif a == "--acks":
        MODE = "acks"
    elif a == "--sha":
        MODE, SHA = "sha", argv[i + 1] if i + 1 < len(argv) else ""
        i += 1
    elif a == "--limit":
        LIMIT = int(argv[i + 1]) if i + 1 < len(argv) else LIMIT
        i += 1
    elif a:
        print(f"모르는 인자입니다: {a}", file=sys.stderr)
        raise SystemExit(2)
    i += 1


def width(text: str) -> int:
    """터미널에서 차지하는 칸 수. 한글은 두 칸이다."""
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def pad(text: str, cells: int) -> str:
    text = str(text)
    while width(text) > cells:
        text = text[:-1]
    return text + " " * (cells - width(text))


# ── 원장 읽기 ────────────────────────────────────────────────────────
# start 와 finish 를 run_id 로 합친다. finish 가 없으면 '중단' 이다 —
# VM 이 01:00 에 꺼지거나 배포기가 SIGKILL 로 죽으면 종료 코드 자체가 없다.
runs: dict[str, dict] = {}
order: list[str] = []
broken = 0
for line in Path(ledger).read_text(encoding="utf-8", errors="replace").splitlines():
    line = line.strip()
    if not line:
        continue
    try:
        record = json.loads(line)
        run_id = record["run_id"]
    except (json.JSONDecodeError, KeyError, TypeError):
        broken += 1
        continue
    if run_id not in runs:
        runs[run_id] = {}
        order.append(run_id)
    runs[run_id].update(record)
    if record.get("event") == "finish":
        runs[run_id]["_finished"] = True

for run_id in order:
    if not runs[run_id].get("_finished"):
        runs[run_id]["result"] = "중단"

RESULT_MARK = {
    "success": "성공",
    "failed": "실패",
    "guarded-halt": "관문정지",
    "noop": "할일없음",
    "중단": "중단",
}
FAILUREISH = {"failed", "guarded-halt", "중단"}


def label(run: dict) -> str:
    return RESULT_MARK.get(run.get("result", ""), run.get("result", "?"))


def when(run: dict) -> str:
    return str(run.get("ts", ""))[:19].replace("T", " ")[5:]  # MM-DD HH:MM:SS


def short(sha: str) -> str:
    return (sha or "")[:7] or "-"


def took(run: dict) -> str:
    seconds = run.get("duration_s")
    if not isinstance(seconds, int):
        return "-"
    return f"{seconds // 60}분{seconds % 60:02d}초" if seconds >= 60 else f"{seconds}초"


def table(selected: list[str]) -> None:
    header = (
        pad("시각", 15) + pad("실행", 12) + pad("커밋", 18)
        + pad("결과", 10) + pad("소요", 9) + "비고"
    )
    print(header)
    print("─" * 84)
    for run_id in selected:
        run = runs[run_id]
        note = []
        if run.get("rolled_back"):
            note.append("롤백함")
        if run.get("guarded_ack"):
            note.append("승인 " + ",".join(run["guarded_ack"]))
        if run.get("guarded_halt"):
            note.append("정지 " + ",".join(run["guarded_halt"]))
        if run.get("result") == "중단":
            note.append(f"phase={run.get('phase', '?')} 이후 기록 없음")
        elif run.get("reason"):
            note.append(str(run["reason"])[:40])
        print(
            pad(when(run), 15)
            + pad(run.get("actor", "?"), 12)
            + pad(f"{short(run.get('prev_sha', ''))}→{short(run.get('target_sha', ''))}", 18)
            + pad(label(run), 10)
            + pad(took(run), 9)
            + " · ".join(note)
        )


def detail(run_id: str) -> None:
    run = runs[run_id]
    print(f"run_id      {run_id}")
    for key, title in (
        ("ts", "시각"), ("actor", "실행"), ("unattended", "무인"),
        ("prev_sha", "이전"), ("target_sha", "대상"), ("result", "결과"),
        ("exit_code", "종료코드"), ("duration_s", "소요(초)"), ("phase", "마지막 단계"),
        ("built", "빌드"), ("restarted", "재시작"), ("rolled_back", "롤백"),
        ("guarded_ack", "관문 승인"), ("guarded_halt", "관문 정지"),
        ("drift", "드리프트"), ("reason", "사유"),
        ("deploy_exec_sha256", "배포기 해시"),
    ):
        if key not in run or run[key] == "":
            continue  # 빈 칸을 줄줄이 보여 주면 정작 있는 값이 안 보인다
        value = run[key]
        if isinstance(value, list):
            value = ", ".join(value) if value else "-"
        elif isinstance(value, bool):
            value = "예" if value else "아니오"
        elif key == "result":
            value = label(run)
        print(f"{pad(title, 12)}{value}")

    path = Path(transcript_dir) / f"{run_id}.log"
    print()
    if not path.exists():
        print(f"전문 없음: {path}")
        return
    try:
        tail = path.read_text(encoding="utf-8", errors="replace").splitlines()[-25:]
    except PermissionError:
        print("전문은 root 만 읽습니다: sudo moneyworry-deploy-log --last")
        return
    print(f"── 전문 꼬리 ({path}) ──")
    for line in tail:
        print("  " + line)


# ── 출력 ─────────────────────────────────────────────────────────────
if not order:
    print("아직 배포 기록이 없습니다.")
    raise SystemExit(0)

if MODE == "last":
    detail(order[-1])
elif MODE == "failures":
    picked = [r for r in order if runs[r].get("result") in FAILUREISH]
    if not picked:
        print("실패·관문정지·중단 기록이 없습니다.")
    else:
        table(picked[-LIMIT:])
elif MODE == "sha":
    picked = [
        r for r in order
        if SHA and (str(runs[r].get("target_sha", "")).startswith(SHA)
                    or str(runs[r].get("prev_sha", "")).startswith(SHA))
    ]
    if not picked:
        print(f"{SHA} 에 대한 시도 기록이 없습니다.")
    else:
        print(f"{SHA} 관련 시도 {len(picked)}건")
        table(picked)
elif MODE == "acks":
    picked = [r for r in order if runs[r].get("guarded_ack")]
    if not picked:
        print("관문 승인 기록이 없습니다.")
    else:
        print("관문 승인 감사 기록 — 누가 언제 어떤 경로의 절차 완료를 승인했는가")
        print("─" * 84)
        for run_id in picked:
            run = runs[run_id]
            print(f"{pad(when(run), 15)}{pad(run.get('actor', '?'), 12)}"
                  f"{pad(short(run.get('target_sha', '')), 9)}{pad(label(run), 10)}"
                  f"{', '.join(run['guarded_ack'])}")
else:
    table(order[-LIMIT:])

if broken:
    print(f"\n경고: 읽을 수 없는 줄 {broken}개를 건너뛰었습니다.", file=sys.stderr)
PY
