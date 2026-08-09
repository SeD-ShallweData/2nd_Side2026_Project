#!/bin/bash
# Noto Sans KR 웹폰트를 로컬에 내려받습니다.
#
# 시안이 Noto Sans KR을 쓰는데, 발표장에서 외부망이 막히면 폰트가 깨집니다.
# 그래서 woff2 서브셋을 프로젝트 안에 두고 직접 서빙합니다.
#
# 받은 파일은 git에 올리지 않습니다(.gitignore). 새 환경에서는 이 스크립트를 한 번 실행하세요.
#   ./scripts/fetch_fonts.sh
#
# 실행하지 않아도 사이트는 동작합니다. 시스템 한글 폰트로 대체될 뿐입니다.
set -e
cd "$(dirname "$0")/.."

OUT="web/assets/fonts/notosanskr"
CSS="web/css/fonts.css"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
API="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap"

mkdir -p "$OUT"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

echo "구글 폰트 CSS를 받는 중…"
curl -sS -A "$UA" "$API" -o "$TMP"

COUNT=$(grep -c 'fonts.gstatic.com' "$TMP" || true)
echo "서브셋 $COUNT개를 내려받습니다. (몇 분 걸릴 수 있습니다)"

grep -o 'https://fonts.gstatic.com[^)]*' "$TMP" | sort -u \
  | xargs -P 8 -I{} sh -c 'f="$OUT/$(basename {})"; [ -s "$f" ] || curl -sS -o "$f" {}' _ 2>/dev/null || \
grep -o 'https://fonts.gstatic.com[^)]*' "$TMP" | sort -u | while read -r url; do
  f="$OUT/$(basename "$url")"
  [ -s "$f" ] || curl -sS -o "$f" "$url"
done

# CSS의 원격 URL을 로컬 경로로 바꿉니다.
sed -E 's#https://fonts\.gstatic\.com/s/notosanskr/[^/]+/#/assets/fonts/notosanskr/#g' "$TMP" > "$CSS"

echo "완료: $(ls "$OUT" | wc -l)개 · $(du -sh "$OUT" | cut -f1)"
echo "생성: $CSS"
