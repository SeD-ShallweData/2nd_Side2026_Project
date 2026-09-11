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
# 실패하면 이전 커밋과 이전 빌드로 자동 롤백한다.
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
  'infra/scripts/install-systemd-units.sh'
  'product/integrations/rag-api/requirements.lock'   # 봉인 venv 재생성
  'product/integrations/contract-api/requirements.lock'
  'product/integrations/rag-api/config/'             # 봉인 자산 매니페스트
  'product/package-lock.json'                        # 공급망 변경
  'db/package-lock.json'
)

# --ack-guarded 로 승인된 경로. 승인한 것만 관문에서 빠진다.
ACKED=()

# ── 유틸 ─────────────────────────────────────────────────────────────
log()  { printf '\033[1m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[deploy] 경고:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[deploy] 실패:\033[0m %s\n' "$*" >&2; exit 1; }

DRY_RUN=0; CF_TUNNEL=0; ALLOW_DIRTY=0; SKIP_BUILD=0; TARGET_SHA=''
while (( $# > 0 )); do
  case "$1" in
    --sha)         [[ ${2:-} ]] || die '--sha 뒤에 커밋이 필요합니다'; TARGET_SHA="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    --cf-tunnel)   CF_TUNNEL=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --skip-build)  SKIP_BUILD=1; shift ;;
    --ack-guarded) ACKED+=("${2:?--ack-guarded 뒤에 경로가 필요합니다}"); shift 2 ;;
    -h|--help)     sed -n '2,30p' "$0"; exit 0 ;;
    *)             die "알 수 없는 인자: $1" ;;
  esac
done

(( EUID == 0 )) || die 'root 로 실행해야 합니다 (프로젝트 트리와 systemd 가 root 소유)'
[[ $TARGET_SHA =~ ^[0-9a-f]{40}$ ]] || die '--sha 는 40자리 소문자 hex 여야 합니다 (브랜치명 불가)'

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
[[ $PREV_SHA != "$TARGET_SHA" ]] || die '이미 그 커밋입니다. 할 일이 없습니다.'

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
[[ -n $CHANGED ]] || die '두 커밋 사이에 변경이 없습니다.'

log '변경 요약:'
printf '%s\n' "$CHANGED" | cut -d/ -f1-2 | sort | uniq -c | sed 's/^/    /'

HALT=''
ACK_USED=''
for p in "${GUARDED_PATHS[@]}"; do
  printf '%s\n' "$CHANGED" | grep -q "^${p}" || continue
  acked=0
  for a in ${ACKED+"${ACKED[@]}"}; do
    [[ $a == "$p" ]] && acked=1 && break
  done
  if (( acked )); then
    ACK_USED+="  - $p"$'\n'
  else
    HALT+="  - $p"$'\n'
  fi
done
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
  exit 3
fi

NEED_BUILD=0;    printf '%s\n' "$CHANGED" | grep -q '^product/'                     && NEED_BUILD=1
NEED_CONTRACT=0; printf '%s\n' "$CHANGED" | grep -q '^product/integrations/contract-api/' && NEED_CONTRACT=1
NEED_RAG=0;      printf '%s\n' "$CHANGED" | grep -q '^product/integrations/rag-api/'      && NEED_RAG=1
(( SKIP_BUILD )) && NEED_BUILD=0

log "계획: 빌드=$NEED_BUILD  contract재시작=$NEED_CONTRACT  rag재시작=$NEED_RAG  web재시작=1"
if (( DRY_RUN )); then
  log 'dry-run 이므로 여기서 종료합니다. 아무것도 바뀌지 않았습니다.'
  exit 0
fi

# ── 6. 실패 시 롤백 ──────────────────────────────────────────────────
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
trap 'rc=$?; (( rc != 0 )) && rollback; exit $rc' ERR

# ── 7. 체크아웃 ──────────────────────────────────────────────────────
log "체크아웃: $TARGET_SHA"
git checkout --detach "$TARGET_SHA"
[[ "$(git rev-parse HEAD)" == "$TARGET_SHA" ]] || die '체크아웃 후 HEAD 가 일치하지 않습니다'
[[ -z "$(git status --porcelain=v1)" ]] || die '체크아웃 후 작업 트리가 깨끗하지 않습니다'

# ── 8. 소유·권한 복구 ────────────────────────────────────────────────
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
  return $ok
}

# ── 9. 빌드 ──────────────────────────────────────────────────────────
if (( NEED_BUILD )); then
  NODE_WANT='v22.23.2'
  [[ "$(node -v)" == "$NODE_WANT" ]] || die "Node 가 $NODE_WANT 이어야 합니다 (현재 $(node -v))"

  if [[ -d product/.next ]]; then
    log "이전 빌드 백업 → $ROLLBACK_DIR/next-$PREV_SHA"
    rm -rf "$ROLLBACK_DIR/next-$PREV_SHA"
    cp -a product/.next "$ROLLBACK_DIR/next-$PREV_SHA"
  fi

  log 'web 을 내리고 빌드합니다 (실행 중 .next 를 덮어쓰지 않기 위해)'
  systemctl stop moneyworry-web.service || true

  # env -u NODE_ENV: web unit 이 NODE_ENV=production 을 설정한다. 그 값이 새면
  # npm ci 가 devDependencies 를 건너뛰어 next/tsc/eslint 가 사라진다.
  ( cd product && umask 022 && env -u NODE_ENV npm ci )
  ( cd product && umask 022 && env -u NODE_ENV npm run build )
  [[ -r product/.next/BUILD_ID ]] || die '빌드 후 .next/BUILD_ID 가 없습니다'
fi

fix_ownership
verify_access || die '권한 검증 실패 — 위 경고를 보고 그룹 소유를 확인하세요'
log '권한 검증 통과'

# ── 10. 재시작 (db → rag·contract → web 순서) ────────────────────────
# rag 는 TimeoutStartSec=15min 이다. 필요할 때만 건드린다.
if (( NEED_RAG )); then
  log 'rag 재시작 (봉인 자산 재해싱 + 모델 워밍업으로 최대 15분)'
  systemctl restart moneyworry-rag.service
fi
if (( NEED_CONTRACT )); then
  log 'contract 재시작'
  systemctl reset-failed moneyworry-contract.service 2>/dev/null || true
  systemctl restart moneyworry-contract.service
fi

log 'web 시작'
systemctl reset-failed moneyworry-web.service 2>/dev/null || true
systemctl restart moneyworry-web.service

# ── 11. 헬스체크 ─────────────────────────────────────────────────────
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
trap - ERR
echo
log 'migration 상태 (읽기 전용 — 이 스크립트는 절대 migrate 하지 않습니다)'
if ( cd db && npm run --silent check:migration-drift -- --env-file /etc/moneyworry/db.env ); then
  log 'DB 정렬됨'
else
  rc=$?
  warn "드리프트 검사 exit=$rc (2 = 적용 대기 있음)"
  warn '적용하려면: 덤프 → cd db && umask 022 && env -u NODE_ENV npm ci → npm run migrate'
  warn 'drizzle-kit 은 devDependency 라 npm ci 없이는 not found 가 납니다.'
fi

echo
log "배포 완료: $PREV_SHA → $TARGET_SHA"
log "롤백하려면: $0 --sha $PREV_SHA --skip-build  (그리고 $ROLLBACK_DIR/next-$PREV_SHA 복원)"
