#!/usr/bin/env bash
# 돈워리 코드 배포 — 검토한 커밋 하나를 VM에 반영한다.
#
# 이 스크립트는 코드만 배포한다. migration은 절대 실행하지 않는다.
# infra/OPERATIONS.md: "배포와 migration은 분리한다. 앱 시작 명령에 자동
# migration을 섞지 않고, drift가 있으면 배포를 중단한다."
#
# 사용법:
#   sudo infra/scripts/deploy-from-git.sh --sha <40-hex> [옵션]
#
# 옵션:
#   --sha SHA        배포할 40자리 커밋 (필수). 브랜치명은 받지 않는다 —
#                    브랜치는 검토 시점과 배포 시점이 달라질 수 있다.
#   --dry-run        무엇이 바뀌고 무엇을 할지만 출력하고 아무것도 바꾸지 않는다.
#   --cf-tunnel      배포 후 Cloudflare quick tunnel(moneyworry-tunnel)을 켠다.
#                    기본값은 켜지 않는 것이다 — 공개 주소는 Tailscale Funnel 이
#                    담당하며, 그쪽은 web 재시작과 무관하게 계속 살아 있다.
#   --allow-dirty    작업 트리에 미커밋 변경이 있어도 진행한다(패치로 보존 후 stash).
#   --skip-build     product/ 가 바뀌었어도 재빌드하지 않는다(운영자가 이미 빌드한 경우).
#   --ack-guarded P  관문 경로 P 의 절차를 끝냈음을 승인한다. 여러 번 줄 수 있다.
#                    예: --ack-guarded db/migrations/ --ack-guarded infra/systemd/
#                    경로를 하나씩 적게 한 것은 일부러다 — 한 번에 전부 끄는 스위치를
#                    두면 아무도 목록을 읽지 않는다.
#
# 종료 코드:
#   0  성공 (--dry-run 정상 종료 포함)
#   1  실패 — 체크아웃 이후였다면 이전 커밋·이전 빌드로 자동 롤백했다
#   3  관문 정지 — 사람의 승인이 필요하다. 아무것도 바뀌지 않았다
#   5  할 일 없음 — 이미 그 커밋이거나 두 커밋 사이에 변경이 없다
#
# 5 를 1 과 나눈 이유: 자동 배포 폴러에게 "할 일 없음"은 정상이다. 이것이 실패로
# 보이면 10분마다 실패 알림이 나가고, 그 소음 때문에 진짜 실패를 아무도 안 본다.
#
# 실패하면 이전 커밋과 이전 빌드로 자동 롤백한다. 2026-09-11 이전에는 이 서술이
# 거짓이었다 — ERR 트랩이라 빌드 실패만 롤백되고 ready 타임아웃·권한 검증 실패·
# 유닛 비활성은 롤백 없이 그냥 종료됐다. 무인 배포에서 가장 흔한 실패가 ready
# 타임아웃이므로 이 구멍이 가장 위험했다. 지금은 EXIT 트랩이다(6절 참고).
#
# 기계 판독: 진행 상황을 '##MW key=value' 한 줄씩 내보낸다. 배포 이력 래퍼
# (moneyworry-deploy-run)는 그 줄만 읽는다. 아래 한국어 로그 문구는 마음대로
# 고쳐도 되지만 key 이름을 바꾸면 이력이 조용히 깨진다.
#
# 설치: 이 파일은 저장소에 정본으로 두되, 실행은 트리 바깥의 사본으로 한다.
#
#   sudo install -m 0755 -o root -g root \
#     infra/scripts/deploy-from-git.sh /usr/local/sbin/moneyworry-deploy
#
# 이유: 이 스크립트는 실행 도중 git checkout 으로 자기가 들어 있는 트리를
# 갈아엎는다. bash 는 스크립트를 실행하면서 바이트 오프셋 단위로 계속 읽으므로,
# 실행 중에 파일이 바뀌면 새 내용의 엉뚱한 위치부터 이어 읽는다.
# PR 이 머지될 때마다 위 install 로 실행본을 갱신한다.

set -Eeuo pipefail
umask 022

# ── 고정값 ───────────────────────────────────────────────────────────
REMOTE_URL='https://github.com/SeD-ShallweData/2nd_Side2026_Project.git'
UNITS=(moneyworry-db moneyworry-rag moneyworry-contract moneyworry-web)
STATE_DIR=/var/lib/moneyworry-deploy
ROLLBACK_DIR=/srv/moneyworry/rollback
READY_URL='http://127.0.0.1:3111/api/health/ready'
READY_TIMEOUT=300          # web 이 ready 될 때까지 기다릴 초
TUNNEL_UNIT=moneyworry-tunnel.service

# 공개 진입점은 Tailscale Funnel 이다. 호스트명은 <머신명>.<테일넷>.ts.net 이라
# 머신/테일넷 이름을 바꾸지 않는 한 고정이다. /api/health/live 는 앱의 Basic auth
# 면제 경로이므로 자격증명 없이 외부 경로 전체를 검증할 수 있다.
#
# 이 저장소는 공개이므로 실제 호스트명을 커밋하지 않는다. 실행 시점에 로컬
# tailscaled 에서 읽고, 다른 진입점을 쓴다면 MONEYWORRY_PUBLIC_HEALTH_URL 로 덮어쓴다.
PUBLIC_HEALTH_PATH='/api/health/live'
public_health_url() {
  if [[ -n ${MONEYWORRY_PUBLIC_HEALTH_URL:-} ]]; then
    printf '%s\n' "$MONEYWORRY_PUBLIC_HEALTH_URL"; return 0
  fi
  command -v tailscale >/dev/null 2>&1 || return 1
  local host
  host="$(tailscale status --json 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null)" || return 1
  [[ -n $host ]] || return 1
  printf 'https://%s%s\n' "$host" "$PUBLIC_HEALTH_PATH"
}

# 이 경로들이 바뀌면 로봇은 멈추고 사람에게 넘긴다.
# 전부 별도의 승인·리허설 절차를 가진 것들이다.
GUARDED_PATHS=(
  'db/migrations/'                                   # migration 은 별도 단계
  'db/docker-compose.yml'                            # PG16 이미지 교체 = 복원 리허설 필요
  'infra/systemd/'                                   # unit 템플릿 = 설치기 재실행 필요
  'infra/scripts/'                                   # 배포기·감시기·래퍼·폴러.
                                                     # 실행은 /usr/local/sbin 사본으로 하므로
                                                     # 배포만으로는 실행본이 갱신되지 않는다.
                                                     # 사람이 install 을 다시 돌려야 저장소와
                                                     # 서버가 같아진다. (2026-09-11: --ack-guarded
                                                     # 를 모르는 구판이 돌고 있어 실제로 막혔다.)
  'product/integrations/rag-api/requirements.lock'   # 봉인 venv 재생성
  'product/integrations/contract-api/requirements.lock'
  'product/integrations/rag-api/config/'             # 봉인 자산 매니페스트
  'product/package-lock.json'                        # 공급망 변경
  'db/package-lock.json'
)

# --ack-guarded 로 승인된 경로. 승인한 것만 관문에서 빠진다.
ACKED=()

# ── 유틸 ─────────────────────────────────────────────────────────────
# 색은 해당 스트림이 tty 일 때만 넣는다. 이 출력은 journal·/srv/moneyworry/deploy.log·
# Discord 로도 흘러가는데, 거기 ANSI 이스케이프가 섞이면 사람이 읽기 어렵고
# 기계 판독도 깨진다.
if [[ -t 1 ]]; then C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'; else C_BOLD=''; C_OFF=''; fi
if [[ -t 2 ]]; then C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_EOFF=$'\033[0m'
else C_WARN=''; C_ERR=''; C_EOFF=''; fi

log()  { printf '%s[deploy]%s %s\n' "$C_BOLD" "$C_OFF" "$*"; }
warn() { printf '%s[deploy] 경고:%s %s\n' "$C_WARN" "$C_EOFF" "$*" >&2; }
die()  { printf '%s[deploy] 실패:%s %s\n' "$C_ERR" "$C_EOFF" "$*" >&2; exit 1; }

# 기계 판독용 한 줄. 래퍼가 읽는 값은 전부 이 형식으로만 내보낸다.
mwfact() { printf '##MW %s=%s\n' "$1" "$2"; }

# 목록을 한 줄에 담는다. 인자가 없으면 빈 문자열 — set -u 에서도 안전하다.
join_csv() { local IFS=','; printf '%s' "$*"; }

# 실패가 아니라 "할 일 없음". exit 5 로 die(1) 와 구분한다 — 헤더의 종료 코드 참고.
noop() { printf '%s[deploy] 할 일 없음:%s %s\n' "$C_BOLD" "$C_OFF" "$*"; mwfact result noop; exit 5; }

DRY_RUN=0; CF_TUNNEL=0; ALLOW_DIRTY=0; SKIP_BUILD=0; TARGET_SHA=''
while (( $# > 0 )); do
  case "$1" in
    --sha)         [[ ${2:-} ]] || die '--sha 뒤에 커밋이 필요합니다'; TARGET_SHA="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    --cf-tunnel)   CF_TUNNEL=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --skip-build)  SKIP_BUILD=1; shift ;;
    --ack-guarded) ACKED+=("${2:?--ack-guarded 뒤에 경로가 필요합니다}"); shift 2 ;;
    -h|--help)     awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *)             die "알 수 없는 인자: $1" ;;
  esac
done

(( EUID == 0 )) || die 'root 로 실행해야 합니다 (프로젝트 트리와 systemd 가 root 소유)'

[[ $TARGET_SHA =~ ^[0-9a-f]{40}$ ]] || die '--sha 는 40자리 소문자 hex 여야 합니다 (브랜치명 불가)'

# 배포가 둘 이상 겹치면 체크아웃과 빌드가 서로를 덮어쓴다.
# 래퍼(moneyworry-deploy-run)가 이미 락을 잡았다면 자기 자신과 경합하지 않도록
# 환경변수로 넘겨받는다. 래퍼에만 두지 않고 **여기에도** 두는 이유는, 사람이 옛
# 명령(moneyworry-deploy)을 그대로 타이핑해도 보호받아야 하기 때문이다.
if [[ ${MW_DEPLOY_LOCK_HELD:-} != "$PPID" ]]; then
  exec 9>/var/lock/moneyworry-deploy.lock
  flock -n 9 || die '다른 배포가 진행 중입니다 (/var/lock/moneyworry-deploy.lock).'
fi

# ── 1. 실제 경로·계정을 systemd 에서 읽는다 (문서의 기본값을 믿지 않는다) ──
# 설치 시 --project-root 를 무엇으로 줬는지는 현장마다 다르다. 실제로 이 VM 은
# /srv/moneyworry/repo 이고 저장소 문서의 기본값과 다르다.
WEB_WD="$(systemctl show -p WorkingDirectory --value moneyworry-web.service)"
[[ -n $WEB_WD ]] || die 'moneyworry-web.service 의 WorkingDirectory 를 읽지 못했습니다'
PROJECT_ROOT="$(dirname "$WEB_WD")"            # .../product 의 부모
[[ -d $PROJECT_ROOT/.git ]] || die "프로젝트 루트로 보이지 않습니다: $PROJECT_ROOT"

declare -A SVC_GROUP
for u in "${UNITS[@]}"; do
  SVC_GROUP[$u]="$(systemctl show -p Group --value "$u.service")"
done
[[ -n ${SVC_GROUP[moneyworry-web]} ]] || die '서비스 그룹을 읽지 못했습니다'

log "프로젝트 루트: $PROJECT_ROOT"
log "서비스 그룹  : web=${SVC_GROUP[moneyworry-web]} rag=${SVC_GROUP[moneyworry-rag]} contract=${SVC_GROUP[moneyworry-contract]}"

cd "$PROJECT_ROOT"

# ── 2. 롤백 기준점 ───────────────────────────────────────────────────
PREV_SHA="$(git rev-parse HEAD)"
STAMP="$(date +%Y%m%d-%H%M%S)"
log "현재 HEAD: $PREV_SHA"
log "배포 대상: $TARGET_SHA"
mwfact prev_sha "$PREV_SHA"
mwfact target_sha "$TARGET_SHA"
mwfact phase inspect
[[ $PREV_SHA != "$TARGET_SHA" ]] || noop '이미 그 커밋입니다. 할 일이 없습니다.'

install -d -m 0755 "$STATE_DIR" "$ROLLBACK_DIR"
(( DRY_RUN )) || printf '%s\n' "$PREV_SHA" > "$STATE_DIR/previous-sha"

# ── 3. 작업 트리 위생 ────────────────────────────────────────────────
# 데모 중 VM 에서 직접 고친 흔적은 어디에도 없는 유일본이다. 절대 버리지 않는다.
if [[ -n "$(git status --porcelain=v1)" ]]; then
  if (( ALLOW_DIRTY )); then
    warn "미커밋 변경을 $STATE_DIR/worktree-$STAMP.patch 로 보존하고 stash 합니다"
    if (( ! DRY_RUN )); then
      git diff > "$STATE_DIR/worktree-$STAMP.patch"
      git diff --cached >> "$STATE_DIR/worktree-$STAMP.patch"
      git status --porcelain=v1 > "$STATE_DIR/worktree-$STAMP.status"
      git stash push -u -m "pre-deploy $STAMP"
    fi
  else
    git status --porcelain=v1 >&2
    die '작업 트리가 깨끗하지 않습니다. 내용을 확인하고 --allow-dirty 로 다시 실행하세요.'
  fi
fi

# ── 4. 대상 커밋 가져오기 ────────────────────────────────────────────
# 이 VM 의 클론에는 remote 가 없을 수 있다(Path B 릴리스로 배치된 트리).
# 저장소가 공개라 자격증명 없이 읽기 전용 fetch 가 된다.
# fetch 와 remote add 는 작업 트리를 바꾸지 않으므로 dry-run 에서도 수행한다.
# 그래야 dry-run 이 "이 커밋을 배포하면 무엇이 바뀌는지"를 실제로 계산할 수 있다.
if ! git remote get-url origin >/dev/null 2>&1; then
  log "origin remote 가 없어 추가합니다: $REMOTE_URL"
  git remote add origin "$REMOTE_URL"
fi
GIT_TERMINAL_PROMPT=0 git fetch --prune origin
git cat-file -t "$TARGET_SHA" >/dev/null 2>&1 \
  || die "커밋을 찾을 수 없습니다: $TARGET_SHA (fetch 실패 또는 잘못된 SHA)"

# ── 5. 무엇이 바뀌는지 판단 ──────────────────────────────────────────
CHANGED="$(git diff --name-only "$PREV_SHA" "$TARGET_SHA")"
[[ -n $CHANGED ]] || noop '두 커밋 사이에 변경이 없습니다.'

log '변경 요약:'
printf '%s\n' "$CHANGED" | cut -d/ -f1-2 | sort | uniq -c | sed 's/^/    /'

HALT=''
ACK_USED=''
ACK_LIST=()
HALT_LIST=()
for p in "${GUARDED_PATHS[@]}"; do
  printf '%s\n' "$CHANGED" | grep -q "^${p}" || continue
  acked=0
  for a in ${ACKED+"${ACKED[@]}"}; do
    [[ $a == "$p" ]] && acked=1 && break
  done
  if (( acked )); then
    ACK_USED+="  - $p"$'\n'
    ACK_LIST+=("$p")
  else
    HALT+="  - $p"$'\n'
    HALT_LIST+=("$p")
  fi
done
# 승인 내역은 이력에 남아야 한다 — 팀에 그렇게 공지했다
# (0911_주간회의_브리핑_배포자동화.md: "승인 내역은 배포 기록에 남습니다").
mwfact ack "$(join_csv ${ACK_LIST+"${ACK_LIST[@]}"})"
mwfact halt "$(join_csv ${HALT_LIST+"${HALT_LIST[@]}"})"
if [[ -n $ACK_USED ]]; then
  # 승인은 기록으로 남긴다. 나중에 "왜 그날 그냥 넘어갔지" 를 답할 수 있어야 한다.
  log '운영자가 절차 완료를 승인한 관문:'
  printf '%s' "$ACK_USED"
fi
if [[ -n $HALT ]]; then
  printf '\n\033[33m[deploy] 사람에게 넘깁니다 — 아래 경로는 별도 승인 절차가 필요합니다:\033[0m\n%s\n' "$HALT" >&2
  cat >&2 <<'MSG'
  db/migrations/          → 덤프 후 별도로 npm run migrate (infra/OPERATIONS.md)
  requirements.lock       → 봉인 venv 재생성 (product/integrations/*/README.md 의 게이트)
  infra/systemd/          → install-systemd-units.sh --force 재실행
  docker-compose.yml      → 빈 PG16 복원 리허설 + Path B 릴리스 게이트
  package-lock.json       → 공급망 변경. 사람이 diff 를 읽어야 한다.

  각 항목의 절차를 끝냈다면 그 경로를 --ack-guarded 로 하나씩 승인하세요.
  예: --ack-guarded db/migrations/ --ack-guarded infra/systemd/
  (그냥 다시 실행해도 같은 목록이 나옵니다 — 변경 목록은 두 커밋의 차이라
   절차를 끝내도 줄어들지 않습니다.)
MSG
  mwfact result guarded-halt
  exit 3
fi

NEED_BUILD=0;    printf '%s\n' "$CHANGED" | grep -q '^product/'                     && NEED_BUILD=1
NEED_CONTRACT=0; printf '%s\n' "$CHANGED" | grep -q '^product/integrations/contract-api/' && NEED_CONTRACT=1
NEED_RAG=0;      printf '%s\n' "$CHANGED" | grep -q '^product/integrations/rag-api/'      && NEED_RAG=1
(( SKIP_BUILD )) && NEED_BUILD=0

log "계획: 빌드=$NEED_BUILD  contract재시작=$NEED_CONTRACT  rag재시작=$NEED_RAG  web재시작=1"
if (( DRY_RUN )); then
  log 'dry-run 이므로 여기서 종료합니다. 아무것도 바뀌지 않았습니다.'
  # success 가 아니라 dry-run 이다. 래퍼가 이것을 성공으로 기록하면 아무것도 하지
  # 않은 실행이 이력에 성공으로 남고 감시기가 한 시간 눈을 감는다.
  mwfact result dry-run
  exit 0
fi

# ── 6. 소유·권한 복구 함수 ──────────────────────────────────────────
#
# rollback() 이 fix_ownership 을 부르므로 **반드시 그보다 먼저 정의돼야 한다.**
# bash 는 순차 실행이라, 정의 전에 롤백이 돌면 command not found(127) 가 나고
# 체크아웃이 망가뜨린 그룹 소유가 복구되지 않는다. 예전 배치는 트랩 설치보다
# 뒤였다 — || true 가 가려서 아무도 몰랐을 뿐이다.
#
#   ★ 여기가 이 스크립트에서 가장 중요한 부분이다 ★
#
# 'chown -R root:root' 를 쓰면 안 된다. 아래 세 트리는 모드가 0750/0640 이고
# **그룹 소유가 곧 접근 권한**이다. 그룹을 root 로 덮으면 서비스 계정이 자기
# venv/빌드산출물에 접근하지 못해 ExecStartPre 가 실패하고, Restart 가 10회
# 재시도한 뒤 'Start request repeated too quickly' 로 멈춘다.
# (2026-09-07 배포에서 실제로 발생했다.)
#
# 소유자만 root 로 맞추고(콜론 없이), 그룹은 각 서비스 그룹으로 복원한다.
# group 에 w 는 없으므로 "서비스 계정은 프로젝트 트리에 쓸 수 없다"는
# install-systemd-units.sh 의 불변식은 그대로 유지된다.
fix_ownership() {
  chown -R root "$PROJECT_ROOT"
  chgrp -R "${SVC_GROUP[moneyworry-contract]}" "$PROJECT_ROOT/product/integrations/contract-api/.venv" 2>/dev/null || true
  chgrp -R "${SVC_GROUP[moneyworry-rag]}"      "$PROJECT_ROOT/product/integrations/rag-api/.venv"      2>/dev/null || true
  for d in product/.next product/node_modules; do
    [[ -e $PROJECT_ROOT/$d ]] && chgrp -R "${SVC_GROUP[moneyworry-web]}" "$PROJECT_ROOT/$d"
  done

  # web 이 런타임에 쓰는 **유일한** 경로. 유닛의 ReadWritePaths 와 짝이다.
  # 빌드가 .next 를 새로 만들 때마다 사라지므로 배포마다 다시 만든다.
  # setgid(2)를 주는 이유: web 이 만든 하위 파일도 그룹을 유지해야 다음 배포의
  # chgrp 와 어긋나지 않는다. 그룹 쓰기(7)가 없으면 UMask=0027 아래에서
  # web 이 아무것도 못 쓴다.
  install -d -m 2775 -o root -g "${SVC_GROUP[moneyworry-web]}" \
    "$PROJECT_ROOT/product/.next/cache"
  return 0
}

# 롤백 백업은 1회당 약 237MB 다. 그냥 두면 배포할수록 디스크가 찬다 —
# 그리고 디스크가 차는 순간이 바로 위 .partial 이 막으려는 상황이다.
# 최근 2 개만 남긴다. 데이터 디스크라 지워도 서비스에 영향이 없다.
prune_rollback_backups() {
  local keep=2 files=() victims=() f
  for f in "$ROLLBACK_DIR"/next-*; do
    [[ -e $f ]] || continue          # 매칭이 없으면 글롭 문자열이 그대로 온다
    [[ $f == *.partial ]] && continue # 완성되지 않은 사본은 백업이 아니다
    files+=("$f")
  done
  (( ${#files[@]} > keep )) || return 0

  # `ls -1dt "$ROLLBACK_DIR"/next-* | tail -n +3` 으로 쓰면 안 된다. 매칭이
  # 없을 때 ls 가 non-zero 를 내고 pipefail + set -e 가 **성공한 배포를
  # 롤백시키고 exit 1** 로 만든다. 위에서 배열이 비어 있지 않음을 확인했으므로
  # 명시적 인자로 넘기는 이 형태는 안전하다.
  mapfile -t victims < <(ls -1dt "${files[@]}" | tail -n "+$((keep + 1))")
  for f in ${victims+"${victims[@]}"}; do
    # 이번 배포의 롤백 기준점은 어떤 경우에도 지우지 않는다.
    [[ -n $f && $f != "$ROLLBACK_DIR/next-$PREV_SHA" ]] || continue
    log "오래된 롤백 백업 삭제: ${f##*/}"
    rm -rf "$f"
  done
  return 0
}

verify_access() {
  local ok=0
  runuser -u "$(systemctl show -p User --value moneyworry-contract.service)" -- \
    test -x "$PROJECT_ROOT/product/integrations/contract-api/.venv/bin/gunicorn" || { warn 'contract 가 자기 venv 를 실행할 수 없습니다'; ok=1; }
  runuser -u "$(systemctl show -p User --value moneyworry-rag.service)" -- \
    test -x "$PROJECT_ROOT/product/integrations/rag-api/.venv/bin/gunicorn" || { warn 'rag 가 자기 venv 를 실행할 수 없습니다'; ok=1; }
  runuser -u "$(systemctl show -p User --value moneyworry-web.service)" -- \
    test -r "$PROJECT_ROOT/product/.next/BUILD_ID" || { warn 'web 이 .next/BUILD_ID 를 읽을 수 없습니다'; ok=1; }
  # 반대 방향 불변식: 서비스 계정은 프로젝트 루트에 쓸 수 없어야 한다
  if runuser -u "$(systemctl show -p User --value moneyworry-web.service)" -- test -w "$PROJECT_ROOT"; then
    warn 'web 계정이 프로젝트 루트에 쓸 수 있습니다 — 격리 모델이 깨졌습니다'; ok=1
  fi
  # 그러나 캐시 한 칸에는 쓸 수 있어야 한다. 못 쓰면 ISR·fetch 캐시가
  # ENOENT 로 죽는다(2026-09-11 이미지 최적화기 사고와 같은 원인).
  runuser -u "$(systemctl show -p User --value moneyworry-web.service)" -- \
    test -w "$PROJECT_ROOT/product/.next/cache" \
    || { warn 'web 이 .next/cache 에 쓸 수 없습니다 — ISR·fetch 캐시가 깨집니다'; ok=1; }
  return $ok
}

# ── 7. 실패 시 롤백 ──────────────────────────────────────────────────
ROLLED_BACK=0
rollback() {
  (( ROLLED_BACK )) && return
  ROLLED_BACK=1
  warn "롤백합니다 → $PREV_SHA"
  cd "$PROJECT_ROOT"
  git checkout --detach "$PREV_SHA" >/dev/null 2>&1 || warn '체크아웃 롤백 실패 — 수동 확인 필요'
  if [[ -d "$ROLLBACK_DIR/next-$PREV_SHA" ]]; then
    rm -rf product/.next
    cp -a "$ROLLBACK_DIR/next-$PREV_SHA" product/.next
  fi
  fix_ownership || true
  systemctl restart moneyworry-contract.service >/dev/null 2>&1 || true
  systemctl restart moneyworry-web.service >/dev/null 2>&1 || true
  warn '롤백 완료. journalctl 로 원인을 확인하세요.'
}

# 감시기(health-watch.sh)가 이 깃발을 보고 배포 중에는 판정을 건너뛴다.
# 배포는 빌드 동안 web 을 의도적으로 내리는데(9절의 systemctl stop) 상호 배제가
# 없으면 감시기가 3분째에 빌드 중인 .next 위로 web 을 재시작한다. ExecStartPre 의
# BUILD_ID 읽기가 실패하고 Restart=always 가 폭주한 뒤 오탐 알림이 나간다.
# (2026-09-11 확인. 두 스크립트 어디에도 flock·플래그·Conflicts= 가 없었다.)
#
# 깃발은 폴러가 아니라 **배포기가** 쓴다 — 사람이 moneyworry-deploy 를 직접
# 타이핑해도 똑같이 보호받아야 하기 때문이다. flock 을 여기 둔 것과 같은 이유다.
DEPLOY_FLAG_DIR='/run/moneyworry'    # 휘발 상태. 재부팅하면 지워지는 것이 맞다
DEPLOY_FLAG="$DEPLOY_FLAG_DIR/deploy-in-progress"

# 유효기간은 **최대 배포 소요보다 길어야** 한다. 빌드 25분 + ready 5분 +
# rag 재시작 최대 15분 = 45분. 짧게 잡으면 빌드 한복판에서 억제가 풀려
# 고치려던 오탐 재시작을 그대로 재현한다. 15분 여유를 둬 60분으로 잡는다.
DEPLOY_FLAG_TTL=3600
MW_RUN_ID="${MW_DEPLOY_RUN_ID:-manual-$STAMP-$$}"   # 래퍼가 있으면 그 run_id 를 잇는다

set_deploy_flag() {
  install -d -m 0755 "$DEPLOY_FLAG_DIR"
  printf '%s %s\n' "$MW_RUN_ID" "$(( $(date +%s) + DEPLOY_FLAG_TTL ))" > "$DEPLOY_FLAG"
}
clear_deploy_flag() { rm -f "$DEPLOY_FLAG"; }

# ERR 이 아니라 **EXIT** 트랩을 쓴다.
#
# bash 의 ERR 트랩은 (1) exit 빌트인과 (2) 'X || die' 리스트의 좌변 실패에 걸리지
# 않는다. die() 는 exit 을 부르고, ready 타임아웃·권한 검증 실패·유닛 비활성
# 판정은 전부 'X || die' 형태다. 그래서 예전에는 **빌드 실패만** 롤백되고
# 무인 배포에서 가장 흔한 실패인 ready 타임아웃은 깨진 채 방치됐다.
#
#   재현: bash -c 'set -Eeuo pipefail; trap "echo ROLLBACK" ERR
#                  die() { exit 1; }; [[ 1 == 2 ]] || die boom'
#   → ROLLBACK 은 출력되지 않는다.
#
# 아래 표식 문자열은 지우지 말 것. 자동 배포 폴러가 /usr/local/sbin 실행본에서
# 이것을 찾지 못하면 "롤백이 돌지 않는 구판"으로 보고 무장을 거부한다.
MW_ROLLBACK_ON_EXIT_V2=1

ARMED_FOR_ROLLBACK=0   # 체크아웃 직전에 켠다. 그 전 실패는 되돌릴 것이 없다
DEPLOY_COMPLETE=0      # 13절 진입 시 켠다. 그 뒤 실패는 배포를 되돌릴 이유가 없다
on_exit() {
  local rc=$?
  trap - EXIT
  if (( rc != 0 && ARMED_FOR_ROLLBACK && ! DEPLOY_COMPLETE )); then
    rollback
  fi
  clear_deploy_flag
  mwfact rolled_back "$ROLLED_BACK"
  if (( rc == 0 )); then mwfact result success; else mwfact result failed; fi
  exit "$rc"
}

# systemd 는 TimeoutStartSec 초과와 systemctl stop 에서 SIGTERM 을 보낸다.
# bash 는 그때 EXIT 트랩을 **실행하지 않는다.** 자동 배포는 이 스크립트를
# systemd 유닛으로 돌리므로, 그대로 두면 타임아웃으로 죽은 배포가 새 코드를
# 깨진 채 남긴다.
#
# 'trap on_exit EXIT TERM' 으로 고치는 것은 **오답이다.** 신호가 도착할 때 $? 는
# 보통 0 이라 on_exit 의 'rc != 0' 조건에 걸리지 않아 롤백이 돌지 않는다.
# (2026-09-12 컨테이너에서 세 가지를 실제로 돌려 확인했다.)
# 신호 핸들러가 **종료 코드를 만들어** 주어야 EXIT 트랩이 제 일을 한다.
#
# 한계: bash 는 전경 명령이 끝날 때까지 트랩 처리를 미룬다. 20분짜리
# npm run build 한가운데서 온 SIGTERM 은 빌드가 끝나야 처리된다. systemd 는
# KillMode=control-group 이라 npm 도 함께 죽으므로 결국 되돌아가지만,
# SIGKILL 에는 어떤 방법도 없다 — 그래서 배포 깃발에 만료 시각을 적고
# 이력에 시도 '전에' start 를 쓴다.
on_signal() {
  warn "신호 $1 을 받았습니다 — 중단하고 되돌립니다"
  exit $(( 128 + $1 ))
}
trap 'on_signal 15' TERM
trap 'on_signal 2'  INT
trap on_exit EXIT

# ── 8. 체크아웃 ──────────────────────────────────────────────────────
# 여기서부터 되돌릴 것이 생긴다. 앞의 세 종료(dry-run 0 / 관문 3 / 할 일 없음 5)는
# 모두 이 줄보다 위라 롤백 대상이 아니다.
ARMED_FOR_ROLLBACK=1
set_deploy_flag
mwfact phase checkout
log "체크아웃: $TARGET_SHA"
git checkout --detach "$TARGET_SHA"
[[ "$(git rev-parse HEAD)" == "$TARGET_SHA" ]] || die '체크아웃 후 HEAD 가 일치하지 않습니다'
[[ -z "$(git status --porcelain=v1)" ]] || die '체크아웃 후 작업 트리가 깨끗하지 않습니다'

# ── 9. 빌드 ──────────────────────────────────────────────────────────
if (( NEED_BUILD )); then
  NODE_WANT='v22.23.2'
  [[ "$(node -v)" == "$NODE_WANT" ]] || die "Node 가 $NODE_WANT 이어야 합니다 (현재 $(node -v))"

  if [[ -d product/.next ]]; then
    log "이전 빌드 백업 → $ROLLBACK_DIR/next-$PREV_SHA"
    # .partial 로 받은 뒤 mv 로 갈아끼운다. 여기는 트랩이 켜진 구간이라, 디스크가
    # 차서 cp 가 반쯤 끝나면 rollback() 이 "디렉터리가 있다"는 이유로 **멀쩡한
    # .next 를 지우고 잘린 사본을 복원**한다. mv 는 같은 파일시스템 안에서
    # 원자적이므로 그 창이 없다.
    rm -rf "$ROLLBACK_DIR/next-$PREV_SHA" "$ROLLBACK_DIR/next-$PREV_SHA.partial"
    cp -a product/.next "$ROLLBACK_DIR/next-$PREV_SHA.partial"
    mv "$ROLLBACK_DIR/next-$PREV_SHA.partial" "$ROLLBACK_DIR/next-$PREV_SHA"
    prune_rollback_backups
  fi

  mwfact phase build
  log 'web 을 내리고 빌드합니다 (실행 중 .next 를 덮어쓰지 않기 위해)'
  systemctl stop moneyworry-web.service || true

  # env -u NODE_ENV: web unit 이 NODE_ENV=production 을 설정한다. 그 값이 새면
  # npm ci 가 devDependencies 를 건너뛰어 next/tsc/eslint 가 사라진다.
  ( cd product && umask 022 && env -u NODE_ENV npm ci )
  ( cd product && umask 022 && env -u NODE_ENV npm run build )
  [[ -r product/.next/BUILD_ID ]] || die '빌드 후 .next/BUILD_ID 가 없습니다'
fi
mwfact built "$NEED_BUILD"

mwfact phase ownership
fix_ownership
verify_access || die '권한 검증 실패 — 위 경고를 보고 그룹 소유를 확인하세요'
log '권한 검증 통과'

# ── 10. 재시작 (db → rag·contract → web 순서) ────────────────────────
# rag 는 TimeoutStartSec=15min 이다. 필요할 때만 건드린다.
mwfact phase restart
RESTARTED=()
if (( NEED_RAG )); then
  log 'rag 재시작 (봉인 자산 재해싱 + 모델 워밍업으로 최대 15분)'
  systemctl restart moneyworry-rag.service
  RESTARTED+=(moneyworry-rag)
fi
if (( NEED_CONTRACT )); then
  log 'contract 재시작'
  systemctl reset-failed moneyworry-contract.service 2>/dev/null || true
  systemctl restart moneyworry-contract.service
  RESTARTED+=(moneyworry-contract)
fi

log 'web 시작'
systemctl reset-failed moneyworry-web.service 2>/dev/null || true
systemctl restart moneyworry-web.service
RESTARTED+=(moneyworry-web)
mwfact restarted "$(join_csv ${RESTARTED+"${RESTARTED[@]}"})"

# ── 11. 헬스체크 ─────────────────────────────────────────────────────
mwfact phase health
log "ready 대기 (최대 ${READY_TIMEOUT}s)"
deadline=$(( SECONDS + READY_TIMEOUT ))
until [[ "$(curl -s -o /dev/null -w '%{http_code}' "$READY_URL" || true)" == '200' ]]; do
  (( SECONDS < deadline )) || die "ready 가 200 이 되지 않았습니다. journalctl -u moneyworry-web -n 100"
  sleep 5
done
log 'ready=200'

for u in "${UNITS[@]}"; do
  [[ "$(systemctl is-active "$u.service")" == 'active' ]] || die "$u 가 active 가 아닙니다"
done
log '네 서비스 모두 active'

# ── 12. 공개 경로 검증 (Tailscale Funnel) ────────────────────────────
# Funnel 은 tailscaled 가 127.0.0.1:3111 로 프록시하는 구조라 web 을 재시작해도
# 끊기지 않고, 주소도 바뀌지 않는다. 그래서 배포가 건드릴 것은 없고 확인만 한다.
# loopback 이 200 이어도 공개 경로가 막혀 있을 수 있으므로 밖에서 한 번 더 본다.
if command -v tailscale >/dev/null 2>&1; then
  log 'Tailscale Funnel 상태'
  tailscale funnel status 2>&1 | sed 's/^/    /' || warn 'funnel status 조회 실패'
fi
if PUBLIC_URL="$(public_health_url)"; then
  PUB="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$PUBLIC_URL" || true)"
  if [[ $PUB == '200' ]]; then
    log "공개 경로 정상: $PUBLIC_URL → 200"
  else
    warn "공개 경로 응답이 $PUB 입니다 (기대: 200). Funnel 또는 tailscaled 를 확인하세요:"
    warn '  tailscale status / tailscale funnel status / systemctl status tailscaled'
  fi
else
  warn '공개 진입점 주소를 알 수 없어 외부 검증을 건너뜁니다.'
  warn 'tailscale 이 없는 호스트라면 MONEYWORRY_PUBLIC_HEALTH_URL 을 지정하세요.'
fi

# Cloudflare quick tunnel 은 옵트인이다. 주소가 매번 바뀌고 SLA 가 없어
# 고정 공개 주소로는 쓰지 않는다. web 을 내리면 Requires= 로 함께 죽는다.
if (( CF_TUNNEL )) && systemctl list-unit-files "$TUNNEL_UNIT" >/dev/null 2>&1; then
  log 'Cloudflare quick tunnel 시작 (요청됨)'
  systemctl start "$TUNNEL_UNIT" || warn '터널 시작 실패'
  sleep 6
  URL="$(journalctl -u "$TUNNEL_UNIT" --since '2 min ago' --no-pager 2>/dev/null \
        | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
  [[ -n $URL ]] && warn "새 quick tunnel 주소(매 재시작마다 바뀝니다): $URL"
fi

# ── 13. migration 은 보고만 하고 실행하지 않는다 ─────────────────────
# 배포 자체는 여기서 끝났다. 아래 드리프트 검사는 읽기 전용 보고이므로,
# 그것이 실패했다고 해서 방금 성공한 배포를 되돌릴 이유가 없다.
DEPLOY_COMPLETE=1
mwfact phase drift
echo
log 'migration 상태 (읽기 전용 — 이 스크립트는 절대 migrate 하지 않습니다)'
if ( cd db && npm run --silent check:migration-drift -- --env-file /etc/moneyworry/db.env ); then
  log 'DB 정렬됨'
  mwfact drift aligned
else
  rc=$?
  mwfact drift "exit$rc"
  warn "드리프트 검사 exit=$rc (2 = 적용 대기 있음)"
  warn '적용하려면: 덤프 → cd db && umask 022 && env -u NODE_ENV npm ci → npm run migrate'
  warn 'drizzle-kit 은 devDependency 라 npm ci 없이는 not found 가 납니다.'
fi

echo
mwfact phase done
log "배포 완료: $PREV_SHA → $TARGET_SHA"
log "롤백하려면: $0 --sha $PREV_SHA --skip-build  (그리고 $ROLLBACK_DIR/next-$PREV_SHA 복원)"
