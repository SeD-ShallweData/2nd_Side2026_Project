#!/usr/bin/env bash
# 돈워리 헬스 감시 — 1분마다 돌며 죽은 것을 살리고 사람에게 알린다.
#
# systemd 의 Restart=always 는 **프로세스가 죽었을 때만** 살린다. 프로세스는 살아
# 있는데 응답만 못 하는 상태(DB 커넥션 고갈, 이벤트 루프 블로킹)는 잡지 못한다.
# 이 스크립트가 그 구멍을 메운다.
#
# 두 엔드포인트를 나눠 쓴다 — 고칠 수 있는 고장과 아닌 고장이 다르기 때문이다.
#
#   /api/health/live   앱이 요청을 받긴 하는가        → 실패하면 재시작이 답이다
#   /api/health/ready  DB·RAG·계약서가 다 붙었는가    → 실패해도 재시작은 헛수고다
#
# 알림은 **상태가 바뀔 때만** 보낸다. 1분마다 같은 말을 반복하면 아무도 안 본다.
#
# 사용법
#   sudo /usr/local/sbin/moneyworry-health-watch            # 한 번 검사 (타이머가 이걸 부른다)
#   sudo /usr/local/sbin/moneyworry-health-watch --test     # 알림 경로만 시험
#   sudo /usr/local/sbin/moneyworry-health-watch --status   # 현재 상태 출력
#
# 웹훅 주소는 저장소에 넣지 않는다. /etc/moneyworry/alert.env 에 root 만 읽게 둔다.
set -euo pipefail

LIVE_URL='http://127.0.0.1:3111/api/health/live'
READY_URL='http://127.0.0.1:3111/api/health/ready'
WEB_UNIT='moneyworry-web.service'
ALERT_ENV='/etc/moneyworry/alert.env'
STATE_DIR='/run/moneyworry'
STATE_FILE="$STATE_DIR/health-watch.state"

# 몇 번 연속 실패하면 움직일지. 1분 간격이므로 3 = 약 3분.
# 배포 중 재시작(ready 까지 최대 300초)을 알림으로 오인하지 않을 만큼은 길어야 한다.
FAIL_THRESHOLD=3
PROBE_TIMEOUT=10

log() { printf '%s\n' "$*"; }

# ── 알림 ─────────────────────────────────────────────────────────────
# 웹훅 주소가 argv 에 실리면 ps 로 보인다. curl -K 로 설정 파일처럼 넘겨 가린다.
notify() {
  local text="$1" payload url
  if [[ ! -r $ALERT_ENV ]]; then
    log "알림 건너뜀 — $ALERT_ENV 가 없습니다: $text"
    return 0
  fi
  # shellcheck disable=SC1090
  url="$(set -a; . "$ALERT_ENV"; set +a; printf '%s' "${DISCORD_WEBHOOK_URL:-}")"
  if [[ -z $url ]]; then
    log "알림 건너뜀 — DISCORD_WEBHOOK_URL 이 비어 있습니다: $text"
    return 0
  fi

  payload="$(mktemp)"
  # 줄바꿈·따옴표가 들어가도 깨지지 않게 JSON 은 파이썬으로 만든다.
  MW_TEXT="$text" python3 -c 'import json,os;print(json.dumps({"content": os.environ["MW_TEXT"]}))' > "$payload"

  if curl --silent --show-error --fail --max-time 15 \
       --header 'Content-Type: application/json' \
       --data-binary "@$payload" \
       -K <(printf 'url = "%s"\n' "$url") >/dev/null; then
    log "알림 보냄: $text"
  else
    log "알림 실패(무시하고 계속): $text"
  fi
  rm -f "$payload"
}

# ── 상태 ─────────────────────────────────────────────────────────────
# /run 에 둔다 — 재부팅하면 지워지는 게 맞다. 껐다 켠 뒤 옛 장애 알림이 되살아나면 안 된다.
read_state() {
  [[ -r $STATE_FILE ]] && cat "$STATE_FILE" || printf 'ok 0 0'
}
write_state() {
  install -d -m 0755 "$STATE_DIR"
  printf '%s %s %s' "$1" "$2" "$3" > "$STATE_FILE"
}

probe() { curl --silent --output /dev/null --max-time "$PROBE_TIMEOUT" --write-out '%{http_code}' "$1" || printf '000'; }

failed_checks() {
  curl --silent --max-time "$PROBE_TIMEOUT" "$READY_URL" 2>/dev/null \
    | python3 -c '
import json,sys
try:
    checks = json.load(sys.stdin).get("checks", {})
except Exception:
    print("응답을 읽지 못함"); raise SystemExit
bad = [name for name, ok in checks.items() if ok is not True]
print(", ".join(bad) if bad else "표시된 실패 없음")
' 2>/dev/null || printf '확인 불가'
}

host_label() { printf '%s' "$(hostname -s 2>/dev/null || printf 'moneyworry')"; }

case "${1:-}" in
  --test)
    notify ":wrench: **[$(host_label)] 알림 경로 시험** — 이 메시지가 보이면 웹훅 설정이 끝난 것입니다."
    exit 0
    ;;
  --status)
    read -r state fails restarted <<<"$(read_state)"
    log "상태=$state 연속실패=$fails 재시작함=$restarted"
    log "live=$(probe "$LIVE_URL") ready=$(probe "$READY_URL")"
    exit 0
    ;;
  '') ;;
  *) log "모르는 인자입니다: $1"; exit 2 ;;
esac

read -r state fails restarted <<<"$(read_state)"
live_code="$(probe "$LIVE_URL")"
ready_code="$(probe "$READY_URL")"

# ── ① 앱이 요청 자체를 못 받는다 → 재시작이 답이다 ────────────────────
if [[ $live_code != 200 ]]; then
  fails=$((fails + 1))
  if (( fails < FAIL_THRESHOLD )); then
    write_state 'failing' "$fails" "$restarted"
    log "live 실패 $fails/$FAIL_THRESHOLD (HTTP $live_code) — 아직 지켜봅니다"
    exit 0
  fi

  if (( restarted == 0 )); then
    notify ":rotating_light: **[$(host_label)] 웹이 응답하지 않습니다** (HTTP \`$live_code\`, ${FAIL_THRESHOLD}분 연속)
자동으로 재시작합니다. 결과를 곧 알려드립니다."
    log "재시작 시도: $WEB_UNIT"
    systemctl reset-failed "$WEB_UNIT" 2>/dev/null || true
    systemctl restart "$WEB_UNIT" || log "재시작 명령 실패"
    write_state 'down' "$fails" 1
    exit 0
  fi

  # 이미 한 번 살려봤는데 또 죽었다. 다시 흔드는 건 상황을 악화시킨다.
  if [[ $state != 'unrecoverable' ]]; then
    notify ":skull: **[$(host_label)] 재시작해도 살아나지 않습니다** (HTTP \`$live_code\`)
자동 재시작을 멈춥니다. **사람이 봐야 합니다.**
\`\`\`
gcloud compute ssh moneyworry-demo --zone asia-northeast3-a
sudo journalctl -u $WEB_UNIT -n 100 --no-pager
\`\`\`"
  fi
  write_state 'unrecoverable' "$fails" 1
  exit 0
fi

# ── ② 앱은 살아 있는데 연결된 것이 빠졌다 → 재시작은 헛수고다 ──────────
if [[ $ready_code != 200 ]]; then
  fails=$((fails + 1))
  if (( fails < FAIL_THRESHOLD )); then
    write_state 'degraded_pending' "$fails" "$restarted"
    log "ready 실패 $fails/$FAIL_THRESHOLD (HTTP $ready_code) — 아직 지켜봅니다"
    exit 0
  fi
  if [[ $state != 'degraded' ]]; then
    notify ":warning: **[$(host_label)] 일부 기능이 끊겼습니다** (ready HTTP \`$ready_code\`)
웹은 살아 있으니 재시작하지 않습니다. 끊긴 것: **$(failed_checks)**
DB·RAG·계약서 분석 중 하나가 내려갔을 때 납니다."
  fi
  write_state 'degraded' "$fails" "$restarted"
  exit 0
fi

# ── ③ 정상 ───────────────────────────────────────────────────────────
if [[ $state != 'ok' ]]; then
  notify ":white_check_mark: **[$(host_label)] 정상으로 돌아왔습니다** — live·ready 모두 200"
fi
write_state 'ok' 0 0
log "정상 (live=200 ready=200)"
