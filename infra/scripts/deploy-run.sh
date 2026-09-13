#!/usr/bin/env bash
# 돈워리 배포 래퍼 — 배포 한 번을 원장에 남긴다.
#
# 사람도 자동 배포 폴러도 **이것으로** 배포한다. 실제 배포는 moneyworry-deploy 가
# 하고, 이 스크립트는 그 전후로 /srv/moneyworry/deploy.log 에 두 줄을 남긴다.
#
# 사용법:
#   sudo /usr/local/sbin/moneyworry-deploy-run --sha <40-hex> [옵션]
#
# 옵션:
#   --sha SHA        배포할 40자리 커밋 (필수)
#   --actor NAME     기록할 실행 주체. 기본값은 sudo 를 부른 사람
#   --unattended     무인 실행(폴러 전용). --ack-guarded 와 함께 올 수 없다
#   그 밖의 인자는 moneyworry-deploy 로 그대로 넘긴다
#
# ── 왜 배포기 안이 아니라 바깥 래퍼인가 ──────────────────────────────
#
# 배포기는 실행 도중 git checkout 으로 자기가 들어 있는 트리를 갈아엎고, 실행본이
# 트리 밖(/usr/local/sbin)에 있어 "지금 도는 나는 어느 판인가"를 스스로 적을 수
# 없다. 래퍼는 트리를 건드리지 않으므로 실행본 해시를 정직하게 기록할 수 있고,
# 배포기가 어떻게 죽든(die·SIGKILL·VM 정지) 바깥에서 그 사실을 남길 수 있다.
#
# ── 왜 시도 '전에' start 를 쓰는가 ───────────────────────────────────
#
# VM 이 매일 01:00 에 꺼진다. 빌드 한가운데서 꺼지면 종료 코드 자체가 없다.
# 실행 전에 써 두면 finish 없는 start 가 남고, 그것이 (1) 사람에게는 "중단"으로,
# (2) 폴러에게는 "이 SHA 는 이미 시도했다"는 근거로 쓰인다. 종료 코드에 의존하지
# 않는 것이 요점이다.
#
# ── 왜 /srv 인가 ─────────────────────────────────────────────────────
#
# /srv/moneyworry 는 데이터 디스크다(VM 을 지워도 남는다). /var/lib 는 VM 과 함께
# 지워지는 부팅 디스크다. 원장은 관문 승인의 감사 기록이므로 살아남아야 한다.
#
# 설치: 실행은 트리 밖 사본으로 한다 (배포기와 같은 이유).
#
#   sudo install -m 0755 -o root -g root \
#     infra/scripts/deploy-run.sh /usr/local/sbin/moneyworry-deploy-run
#
# 조회는 moneyworry-deploy-log 를 쓴다. 형식은 infra/DEPLOY_HISTORY.md 참고.

set -Eeuo pipefail
umask 022

# 원장의 모든 시각은 Asia/Seoul 이다. VM OS 는 UTC 로 도는 일이 흔하고, 팀이 쓰는
# 모든 일정(프리즈·심사·VM 가동창)은 KST 다. 섞이면 최대 9시간 어긋난다.
export TZ='Asia/Seoul'

DEPLOY_EXEC='/usr/local/sbin/moneyworry-deploy'
LEDGER_DIR='/srv/moneyworry'
LEDGER="$LEDGER_DIR/deploy.log"
TRANSCRIPT_DIR="$LEDGER_DIR/deploy-logs"
LOCK='/var/lock/moneyworry-deploy.lock'

# 전문은 최근 30개만 남긴다. 원장 자체는 로테이션하지 않는다 — 1000회 배포해도
# 1MB 미만이고, 관문 승인의 감사 기록이라 지우면 안 된다.
KEEP_TRANSCRIPTS=30

# 실행본이 이 표식을 갖고 있지 않으면 롤백이 돌지 않는 구판이다.
# 그런 배포기로는 이력을 남길 가치가 없다 — 실패해도 되돌아가지 않기 때문이다.
REQUIRED_MARKER='MW_ROLLBACK_ON_EXIT_V2'

if [[ -t 1 ]]; then C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'; else C_BOLD=''; C_OFF=''; fi
if [[ -t 2 ]]; then C_ERR=$'\033[31m'; C_EOFF=$'\033[0m'; else C_ERR=''; C_EOFF=''; fi
log() { printf '%s[deploy-run]%s %s\n' "$C_BOLD" "$C_OFF" "$*"; }
die() { printf '%s[deploy-run] 실패:%s %s\n' "$C_ERR" "$C_EOFF" "$*" >&2; exit 1; }

# JSON 은 파이썬으로 만들되 **값을 argv 로만** 넘긴다.
# 셸 문자열 안에 파이썬 코드를 조립하면 따옴표가 섞여 깨진다 — 검토에서 실제로
# 재현된 버그다(작은따옴표 문자열 안의 \' 는 bash 구문 오류). argv 로 넘기면
# 값에 따옴표·백슬래시·줄바꿈이 들어 있어도 셸이 건드리지 않는다.
#
#   json_line k1 v1 "k2#" 42 "k3[]" "a,b" "k4?" 1
#     k#  → 숫자   k[] → 쉼표 구분 배열   k? → 불린(1/0)
json_line() {
  python3 - "$@" <<'PY'
import json, sys
it = iter(sys.argv[1:])
out = {}
for key in it:
    value = next(it)
    if key.endswith("[]"):
        out[key[:-2]] = [x for x in value.split(",") if x]
    elif key.endswith("#"):
        out[key[:-1]] = int(value) if value.lstrip("-").isdigit() else None
    elif key.endswith("?"):
        out[key[:-1]] = value == "1"
    else:
        out[key] = value
print(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
PY
}

# 배포기가 뿜은 '##MW key=value' 줄을 읽는다. 같은 key 가 여러 번 나오면 마지막 것.
# grep 무매칭은 정상이므로 || true 로 받는다 — 없으면 set -e 가 래퍼를 죽인다.
fact() {
  local value
  value="$(grep -a "^##MW $1=" "$TRANSCRIPT" | tail -1)" || true
  if [[ -z $value ]]; then printf '%s' "${2-}"; return 0; fi
  printf '%s' "${value#\#\#MW $1=}"
}

# 전문 정리. ls 에 글롭을 바로 넘기면 매칭이 없을 때 non-zero → pipefail →
# set -e 로 **성공한 배포가 실패로 기록된다.** run_id 가 YYYYmmdd-HHMMSS 로
# 시작하므로 글롭의 사전순 확장이 곧 시간순이다. 정렬도 필요 없다.
prune_transcripts() {
  local files=() f i
  for f in "$TRANSCRIPT_DIR"/*.log; do
    [[ -e $f ]] || continue      # 매칭이 없으면 글롭 문자열이 그대로 온다
    files+=("$f")
  done
  (( ${#files[@]} > KEEP_TRANSCRIPTS )) || return 0
  for (( i = 0; i < ${#files[@]} - KEEP_TRANSCRIPTS; i++ )); do
    rm -f "${files[i]}"
  done
  return 0
}

# ── 인자 ─────────────────────────────────────────────────────────────
TARGET_SHA=''
ACTOR=''
UNATTENDED=0
HAS_ACK=0
DRY_RUN=0
PASS=()
while (( $# > 0 )); do
  case "$1" in
    --sha)         [[ ${2:-} ]] || die '--sha 뒤에 커밋이 필요합니다'
                   TARGET_SHA="$2"; PASS+=(--sha "$2"); shift 2 ;;
    --actor)       ACTOR="${2:?--actor 뒤에 이름이 필요합니다}"; shift 2 ;;
    --unattended)  UNATTENDED=1; shift ;;
    --ack-guarded) HAS_ACK=1; PASS+=(--ack-guarded "${2:?--ack-guarded 뒤에 경로가 필요합니다}"); shift 2 ;;
    --dry-run)     DRY_RUN=1; PASS+=(--dry-run); shift ;;
    -h|--help)     awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *)             PASS+=("$1"); shift ;;
  esac
done

# 인자 자체의 모순은 권한보다 먼저 본다. 권한이 없어도 잘못된 인자는 잘못된
# 인자이고, root 없이도 검증할 수 있어야 CI 가 이 규칙을 실제로 시험할 수 있다.
#
# 로봇은 관문을 승인하지 못한다. 관문은 "사람이 별도 절차를 끝냈다"는 선언이고,
# 폴러는 그 절차를 밟을 수 없다. 폴러 소스에 --ack-guarded 문자열이 없는 것과
# 이 거부가 이중 장치다.
if (( UNATTENDED && HAS_ACK )); then
  die '--unattended 와 --ack-guarded 를 함께 쓸 수 없습니다. 관문은 사람이 승인합니다.'
fi
[[ $TARGET_SHA =~ ^[0-9a-f]{40}$ ]] || die '--sha 는 40자리 소문자 hex 여야 합니다 (브랜치명 불가)'

(( EUID == 0 )) || die 'root 로 실행해야 합니다'

[[ -x $DEPLOY_EXEC ]] || die "배포기 실행본이 없습니다: $DEPLOY_EXEC"

# 실행본이 롤백 없는 구판이면 배포하지 않는다.
# 저장소를 고쳐도 install 을 다시 돌리지 않으면 서버는 옛 판 그대로다.
grep -q "$REQUIRED_MARKER" "$DEPLOY_EXEC" || die \
  "배포기 실행본에 $REQUIRED_MARKER 표식이 없습니다 — 롤백이 돌지 않는 구판입니다.
  sudo install -m 0755 -o root -g root \\
    /srv/moneyworry/repo/infra/scripts/deploy-from-git.sh $DEPLOY_EXEC"

# ── --dry-run 은 배포가 아니다 ───────────────────────────────────────
# 아무것도 하지 않은 실행이 이력에 success 로 남으면, 그 기록을 믿은 사람이
# "배포됐다"고 판단하고 폴러는 그 SHA 를 시도 완료로 본다. 원장을 건드리지 않고
# 그대로 통과시킨다.
if (( DRY_RUN )); then
  log 'dry-run 이므로 이력을 남기지 않고 배포기로 그대로 넘깁니다.'
  exec "$DEPLOY_EXEC" "${PASS[@]}"
fi

# ── 락 ───────────────────────────────────────────────────────────────
# 래퍼가 잡고 배포기에게 물려준다. 배포기도 자체적으로 잡으므로(사람이 옛 명령을
# 직접 타이핑하는 경우) MW_DEPLOY_LOCK_HELD 로 "이미 내 부모가 갖고 있다"를 알린다.
exec 9>"$LOCK"
flock -n 9 || die "다른 배포가 진행 중입니다 ($LOCK)."

# ── 기록 준비 ────────────────────────────────────────────────────────
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
STARTED_AT="$(date +%s)"
TRANSCRIPT="$TRANSCRIPT_DIR/$RUN_ID.log"

if [[ -z $ACTOR ]]; then
  if (( UNATTENDED )); then ACTOR='autodeploy'; else ACTOR="${SUDO_USER:-root}"; fi
fi

# 프로젝트 루트는 배포기와 같은 방법으로 읽는다 — 문서의 기본값을 믿지 않는다.
WEB_WD="$(systemctl show -p WorkingDirectory --value moneyworry-web.service 2>/dev/null || true)"
if [[ -n $WEB_WD ]]; then
  PREV_SHA="$(git -C "$(dirname "$WEB_WD")" rev-parse HEAD 2>/dev/null || printf 'unknown')"
else
  PREV_SHA='unknown'
fi
EXEC_SHA="$(sha256sum "$DEPLOY_EXEC" | cut -d' ' -f1)"

install -d -m 0755 "$LEDGER_DIR" "$TRANSCRIPT_DIR"
# 원장은 구조화된 필드만 담으므로 누구나 읽어도 된다. 전문은 빌드 출력이 통째로
# 들어가므로 root 만 읽는다 — 무엇이 섞여 들어올지 미리 알 수 없다.
[[ -e $LEDGER ]] || { : > "$LEDGER"; chmod 0644 "$LEDGER"; }
: > "$TRANSCRIPT"; chmod 0640 "$TRANSCRIPT"

json_line event start run_id "$RUN_ID" ts "$(date --iso-8601=seconds)" \
  actor "$ACTOR" "unattended?" "$UNATTENDED" \
  prev_sha "$PREV_SHA" target_sha "$TARGET_SHA" \
  deploy_exec_sha256 "$EXEC_SHA" >> "$LEDGER"

log "run_id=$RUN_ID actor=$ACTOR"
log "원장: $LEDGER"
log "전문: $TRANSCRIPT"

# ── 실행 ─────────────────────────────────────────────────────────────
# set +e 로 감싸는 이유: 배포기가 1·3·5 중 무엇으로 끝나든 finish 를 반드시
# 써야 한다. 여기서 죽으면 모든 실패가 "중단"으로 기록돼 원인을 잃는다.
set +e
MW_DEPLOY_LOCK_HELD=$$ MW_DEPLOY_RUN_ID="$RUN_ID" \
  "$DEPLOY_EXEC" "${PASS[@]}" 2>&1 | tee -a "$TRANSCRIPT"
rc=${PIPESTATUS[0]}
set -e

DURATION=$(( $(date +%s) - STARTED_AT ))

# ── 결과 판정 ────────────────────────────────────────────────────────
# 종료 코드를 정본으로 삼고, ##MW result 는 교차 검증에만 쓴다.
# 배포기가 죽는 방식은 여러 가지지만(SIGKILL 포함) 종료 코드는 언제나 있다.
case "$rc" in
  0) RESULT='success' ;;
  3) RESULT='guarded-halt' ;;
  5) RESULT='noop' ;;
  *) RESULT='failed' ;;
esac

CLAIMED="$(fact result '')"
REASON=''
if [[ -n $CLAIMED && $CLAIMED != "$RESULT" ]]; then
  # dry-run 은 위에서 걸렀으므로 여기 오면 안 된다. 와도 success 로는 기록하지 않는다.
  REASON="기계판독 result=$CLAIMED 인데 종료 코드는 $rc 입니다"
  log "경고: $REASON"
fi
if [[ $RESULT == 'failed' ]]; then
  # 마지막 실패 메시지를 남긴다. 배포기가 직접 쓴 문장이라 자유 입력이 아니다.
  REASON="$(grep -a '\[deploy\] 실패:' "$TRANSCRIPT" | tail -1 | sed 's/.*\[deploy\] 실패: *//')" || true
  [[ -n $REASON ]] || REASON="종료 코드 $rc (실패 메시지 없음 — 강제 종료일 수 있습니다)"
fi

json_line event finish run_id "$RUN_ID" ts "$(date --iso-8601=seconds)" \
  "duration_s#" "$DURATION" result "$RESULT" "exit_code#" "$rc" \
  phase "$(fact phase 'unknown')" reason "$REASON" \
  prev_sha "$(fact prev_sha "$PREV_SHA")" target_sha "$(fact target_sha "$TARGET_SHA")" \
  "guarded_ack[]" "$(fact ack '')" "guarded_halt[]" "$(fact halt '')" \
  "built?" "$(fact built 0)" "restarted[]" "$(fact restarted '')" \
  "rolled_back?" "$(fact rolled_back 0)" drift "$(fact drift '')" >> "$LEDGER"

prune_transcripts

log "결과: $RESULT (${DURATION}초, exit=$rc)"
log '자세히 보려면: moneyworry-deploy-log --last'
exit "$rc"
