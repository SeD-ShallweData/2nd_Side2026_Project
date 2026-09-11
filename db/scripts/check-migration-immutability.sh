#!/usr/bin/env bash
# 이미 있던 migration 의 SQL 을 고치지 못하게 막는다.
#
# 왜 막아야 하나 — migration 파일은 한 번 적용되면 **바이트가 곧 신분증**이다.
# drizzle 은 파일 원본을 sha256 해서 drizzle.__drizzle_migrations 에 남기고
# (drizzle-orm/migrator.js), db/scripts/check-migration-drift.mjs 는 그 값을
# 현재 파일 해시와 대조한다. 주석 한 글자만 바뀌어도 해시가 달라져
# `ledger_diverged` 가 나고, 그 DB 는 배포 게이트를 통과하지 못한다.
#
# 2026-09-11 에 실제로 겪었다. PR #40 이 0002·0006 의 COMMENT 문구를 다듬었는데
# 둘 다 이미 운영 DB 에 적용된 뒤였다. 고친 값 자체는 옳았지만 자리가 틀렸다 —
# 그런 정정은 db/schema.ts 처럼 해시되지 않는 곳이나 새 migration 으로 간다.
#
# 사용법
#   db/scripts/check-migration-immutability.sh [base-ref]      # 기본 origin/main
set -euo pipefail

BASE_REF="${1:-origin/main}"
MIGRATION_GLOB="db/migrations"

cd "$(git rev-parse --show-toplevel)"

if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  echo "기준 ref 를 찾을 수 없습니다: $BASE_REF" >&2
  echo "CI 라면 actions/checkout 의 fetch-depth 가 0 인지 확인하세요." >&2
  exit 2
fi

merge_base="$(git merge-base "$BASE_REF" HEAD)"

# 기준에 이미 있었는데 내용이 바뀐 .sql 만 고른다. 새로 추가된 것은 통과.
changed=()
while IFS= read -r path; do
  [[ -n $path ]] || continue
  git cat-file -e "$merge_base:$path" 2>/dev/null || continue   # 새 파일이면 건너뛴다
  changed+=("$path")
done < <(git diff --name-only --diff-filter=M "$merge_base"...HEAD -- "$MIGRATION_GLOB/*.sql")

if (( ${#changed[@]} == 0 )); then
  echo "적용된 migration 이 수정되지 않았습니다. (기준 $BASE_REF)"
  exit 0
fi

# 예외 — 잘못 고쳐진 파일을 **원장 해시로 되돌리는** 복구는 허용해야 한다.
# 되돌리는 것도 git 에게는 "수정"이라, 이 장치가 없으면 복구 PR 이 스스로 막힌다.
#
# 파일 형식 (# 로 시작하면 주석):
#   <경로> <허용할 sha256 전체> <사유>
#
# 결과 해시를 함께 적는 것이 요점이다. "이 파일은 마음대로 고쳐도 된다"가 아니라
# "정확히 이 내용으로만 바뀌어도 된다"가 된다.
EXCEPTIONS_FILE="$MIGRATION_GLOB/.immutability-exceptions"

# macOS 기본 bash 는 3.2 라 연관배열(declare -A)을 못 쓴다. 팀원이 각자 Mac 에서
# 돌려 볼 수 있어야 하므로 파일을 직접 조회한다.
allowed_hash_for() {
  [[ -f $EXCEPTIONS_FILE ]] || return 0
  awk -v want="$1" '$1 == want { print $2; exit }' "$EXCEPTIONS_FILE"
}

remaining=()
for path in "${changed[@]}"; do
  actual="$(shasum -a 256 "$path" | cut -d" " -f1)"
  if [[ "$(allowed_hash_for "$path")" == "$actual" ]]; then
    printf "허용된 복구: %s (sha256 %s…)\n" "$path" "${actual:0:16}"
    continue
  fi
  remaining+=("$path")
done

if (( ${#remaining[@]} == 0 )); then
  echo "수정된 migration 이 전부 등록된 복구입니다. (기준 $BASE_REF)"
  exit 0
fi
changed=("${remaining[@]}")

echo "❌ 이미 있던 migration 의 SQL 이 수정됐습니다:" >&2
for path in "${changed[@]}"; do
  before="$(git show "$merge_base:$path" | shasum -a 256 | cut -c1-16)"
  after="$(shasum -a 256 "$path" | cut -c1-16)"
  printf '   %s\n     sha256 %s → %s\n' "$path" "$before" "$after" >&2
done
cat >&2 <<'GUIDE'

migration 은 적용되는 순간 바이트가 신분증이 됩니다. 한 글자만 바뀌어도
운영 DB 의 원장 해시와 어긋나 `check:migration-drift` 가 ledger_diverged 를
내고 배포 게이트가 막힙니다.

고치려는 내용이

  - 주석·문구 정정이면      → db/schema.ts 처럼 해시되지 않는 곳에 적습니다
  - 스키마를 바꿔야 하면    → 새 migration 을 만듭니다 (후조건 등록도 같은 PR 에서)
  - 아직 어디에도 적용 전이면 → 이 검사를 건너뛸 근거를 PR 에 적고 리뷰어 승인을 받습니다

절차: db/docs/MIGRATION_OPERATIONS.md
GUIDE
exit 1
