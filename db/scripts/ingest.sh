#!/usr/bin/env bash
# ML export CSV → Postgres 적재.
#
#   ./scripts/ingest.sh --bundle ../_service_bundle \
#                       --expected-database wageguard \
#                       --model-version door1-voting-39f-v1 --as-of 2026-06 \
#                       --expect-rows 553598,3000,503887
#
# --as-of 는 **관측창의 끝(t-6)** = 채점에 넣은 국민연금 파일의 마지막 달이다.
# 예측 대상월(t)은 자동으로 as_of + 6개월이 된다.
#
#   [t-18 ── 관측창 13개월 ── t-6] ·· 공백 6개월 ·· t(명단공개)
#         2025-04            2026-04                2026-10
#          └── --as-of 2026-04 ──┘                    ↑ target_month 자동
#
# 매달 새 연금 파일로 재채점하면 --as-of 만 한 칸 밀면 된다(재학습 아님, 같은 pkl).
# 기준월은 재현 가능한 first_seen/last_seen에도 사용하므로 생략할 수 없다.
#
# 설계
#  - 모든 CSV 를 **전부 TEXT 인 staging 테이블**에 \copy 로 벌크 적재한 뒤 SQL 로 변환한다.
#    552,500행을 행단위 INSERT 하면 몇 분씩 걸린다. COPY 는 수 초다.
#  - 숫자 캐스팅은 변환 단계에서만 한다. 빈 문자열은 NULL 로 (0 으로 채우지 않는다).
#  - `사업자번호`·`sido_code`·`industry_category` 는 끝까지 TEXT 로 둔다.
#  - 같은 (as_of_date, model_version) 을 다시 적재하면 그 batch 만 갈아끼운다. 멱등.
#  - 적재가 끝나면 risk_tier 를 **그 batch 안에서만** 계산한다(§risk_tier).
set -euo pipefail
unset NODE_OPTIONS NODE_PATH NPM_CONFIG_USERCONFIG NPM_CONFIG_PREFIX
unset PYTHONPATH PYTHONHOME PYTHONUSERBASE PYTHONSTARTUP PYTHONINSPECT

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
CALLER_CWD="$PWD"

BUNDLE="../_service_bundle"
OUT_DIR=""
MODEL_VERSION=""
AS_OF=""
MODEL_SHA=""
EXPECT_ROWS=""
ENV_FILE="${DB_ENV_FILE:-$PROJECT_ROOT/.env.local}"
EXPECTED_DATABASE=""
EXPECTED_SYSTEM_IDENTIFIER=""
EXPECTED_DATABASE_OID=""
CANONICAL_TIMESTAMP=""

usage() {
  cat <<'USAGE'
Usage:
  scripts/ingest.sh --model-version VERSION [options]

Options:
  --bundle PATH          Service bundle root (default: ../_service_bundle)
  --outputs PATH         Directory containing the three CSV exports
  --model-version NAME   Model recipe identifier (required)
  --as-of YYYY-MM        Observation-window end month (required)
  --model-sha SHA        Model SHA prefix; inferred from the bundle when omitted
  --expect-rows S,Q,F    Expected scored, queue, and safe row counts
  --env-file PATH        Restricted DB key/value env file (never shell-sourced)
  --expected-database N  Exact PostgreSQL 16 database identity (required)
  --expected-system-identifier N  Exact PostgreSQL cluster system identifier
  --expected-database-oid N       Exact target database OID
  --canonical-timestamp RFC3339   Explicit UTC rebuild timestamp (required)
  -h, --help             Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle)        BUNDLE="$2"; shift 2 ;;
    # CSV 3종이 든 디렉터리를 직접 지정한다. 기본은 "$BUNDLE/outputs".
    # 과거월 백필(backfill/outputs_YYYYMM/)처럼 번들 구조가 아닌 폴더를 적재할 때 쓴다.
    --outputs)       OUT_DIR="$2"; shift 2 ;;
    --model-version) MODEL_VERSION="$2"; shift 2 ;;
    --as-of)         AS_OF="$2"; shift 2 ;;
    --model-sha)     MODEL_SHA="$2"; shift 2 ;;
    # ML팀이 알려준 기대 행수. 주면 다르면 롤백한다. "scored,queue,safe"
    --expect-rows)   EXPECT_ROWS="$2"; shift 2 ;;
    --env-file)      ENV_FILE="$2"; shift 2 ;;
    --expected-database) EXPECTED_DATABASE="$2"; shift 2 ;;
    --expected-system-identifier) EXPECTED_SYSTEM_IDENTIFIER="$2"; shift 2 ;;
    --expected-database-oid) EXPECTED_DATABASE_OID="$2"; shift 2 ;;
    --canonical-timestamp) CANONICAL_TIMESTAMP="$2"; shift 2 ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "알 수 없는 인자: $1" >&2; exit 1 ;;
  esac
done

[[ -z "$MODEL_VERSION" ]] && { echo "--model-version 은 필수입니다" >&2; exit 1; }
[[ "$MODEL_VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] \
  || { echo "--model-version 형식이 안전하지 않습니다" >&2; exit 1; }
if [[ -z "$AS_OF" || ! "$AS_OF" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]]; then
  echo "--as-of 형식은 YYYY-MM 입니다" >&2
  exit 1
fi
[[ "$EXPECTED_DATABASE" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
  || { echo "--expected-database 는 필수이며 안전한 DB 이름이어야 합니다" >&2; exit 1; }
[[ "$EXPECTED_SYSTEM_IDENTIFIER" =~ ^[1-9][0-9]*$ ]] \
  || { echo "--expected-system-identifier 는 양의 10진수여야 합니다" >&2; exit 1; }
[[ "$EXPECTED_DATABASE_OID" =~ ^[1-9][0-9]*$ ]] \
  || { echo "--expected-database-oid 는 양의 10진수여야 합니다" >&2; exit 1; }
[[ "$CANONICAL_TIMESTAMP" =~ ^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$ ]] \
  || { echo "--canonical-timestamp 는 밀리초와 Z가 있는 정확한 RFC3339 UTC여야 합니다" >&2; exit 1; }

EXP_S=0; EXP_Q=0; EXP_F=0
if [[ -n "$EXPECT_ROWS" ]]; then
  IFS=',' read -r EXP_S EXP_Q EXP_F <<< "$EXPECT_ROWS"
  [[ "$EXP_S" =~ ^[0-9]+$ && "$EXP_Q" =~ ^[0-9]+$ && "$EXP_F" =~ ^[0-9]+$ ]] \
    || { echo "--expect-rows 형식: scored,queue,safe (숫자 3개)" >&2; exit 1; }
fi

cd "$PROJECT_ROOT"
if [[ "$ENV_FILE" != /* ]]; then
  ENV_FILE="$CALLER_CWD/$ENV_FILE"
fi
[[ -r "$ENV_FILE" ]] || { echo "읽을 수 있는 env 파일이 없습니다: $ENV_FILE" >&2; exit 1; }
[[ ! -L "$ENV_FILE" ]] || { echo "env 파일은 symlink일 수 없습니다: $ENV_FILE" >&2; exit 1; }

# 비밀 파일을 shell code로 실행하지 않고 DB 연결에 필요한 key만 읽는다.
unset DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD PGSSLMODE PGPASSWORD
unset PGOPTIONS PGSERVICE PGSERVICEFILE PGPASSFILE PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGCONNECT_TIMEOUT
DB_HOST=""; DB_PORT=""; DB_NAME=""; DB_USER=""; DB_PASSWORD=""; PGSSLMODE=""
shopt -s extglob
while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
  line="${raw_line##+([[:space:]])}"
  [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
  if [[ "$line" =~ ^(export[[:space:]]+)?([A-Z_][A-Z0-9_]*)[[:space:]]*=(.*)$ ]]; then
    key="${BASH_REMATCH[2]}"
    value="${BASH_REMATCH[3]}"
    value="${value##+([[:space:]])}"
    value="${value%%+([[:space:]])}"
    if [[ ${#value} -ge 2 ]]; then
      if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
        value="${value:1:${#value}-2}"
      fi
    fi
    case "$key" in
      DB_HOST|DB_PORT|DB_NAME|DB_USER|DB_PASSWORD|PGSSLMODE)
        printf -v "$key" '%s' "$value"
        ;;
    esac
  fi
done < "$ENV_FILE"

DB_HOST="${DB_HOST:-127.0.0.1}"
: "${DB_PORT:?DB_PORT is required in the env file}"
: "${DB_NAME:?DB_NAME is required in the env file}"
: "${DB_USER:?DB_USER is required in the env file}"
: "${DB_PASSWORD:?DB_PASSWORD is required in the env file}"
[[ "$DB_NAME" == "$EXPECTED_DATABASE" ]] \
  || { echo "env DB_NAME이 --expected-database와 다릅니다" >&2; exit 1; }
[[ "$DB_PORT" =~ ^[0-9]+$ ]] && ((DB_PORT >= 1 && DB_PORT <= 65535)) \
  || { echo "DB_PORT가 1~65535 범위의 정수가 아닙니다" >&2; exit 1; }

OUT="${OUT_DIR:-$BUNDLE/outputs}"
[[ "$OUT" != *"'"* && "$OUT" != *'\'* && "$OUT" != *$'\n'* && "$OUT" != *$'\r'* ]] \
  || { echo "CSV 경로에는 quote, backslash, 줄바꿈을 사용할 수 없습니다" >&2; exit 1; }
for f in scored_active_full.csv 감독관_위험큐_full.csv safe_recommendation_full.csv; do
  [[ -f "$OUT/$f" ]] || { echo "파일 없음: $OUT/$f" >&2; exit 1; }
  [[ ! -L "$OUT/$f" ]] || { echo "CSV 파일은 symlink일 수 없습니다: $OUT/$f" >&2; exit 1; }
done

# .env.local 의 DB_PASSWORD 를 psql 에 넘긴다.
# 이게 없으면 ~/.pgpass 가 있는 사람만 동작하고, 새로 clone 한 사람은 비밀번호 입력을 요구받는다.
export PGPASSWORD="${DB_PASSWORD}"
[[ -n "${PGSSLMODE:-}" ]] && export PGSSLMODE
PSQL=(
  psql -X --no-psqlrc -w -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}"
  -v ON_ERROR_STOP=1 -q
  -v "expected_database=$EXPECTED_DATABASE"
  -v "expected_owner=$DB_USER"
  -v "expected_system_identifier=$EXPECTED_SYSTEM_IDENTIFIER"
  -v "expected_database_oid=$EXPECTED_DATABASE_OID"
  -v "canonical_timestamp=$CANONICAL_TIMESTAMP"
)
CONNECTED_IDENTITY="$("${PSQL[@]}" -At -c "SELECT concat_ws(chr(9), current_database(), (current_setting('server_version_num')::integer / 10000)::text, (SELECT system_identifier::text FROM pg_catalog.pg_control_system()), (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database()))")"
IFS=$'\t' read -r CONNECTED_DATABASE CONNECTED_MAJOR CONNECTED_SYSTEM_IDENTIFIER CONNECTED_DATABASE_OID <<<"$CONNECTED_IDENTITY"
[[ "$CONNECTED_DATABASE" == "$EXPECTED_DATABASE" && "$CONNECTED_MAJOR" == "16" \
   && "$CONNECTED_SYSTEM_IDENTIFIER" == "$EXPECTED_SYSTEM_IDENTIFIER" \
   && "$CONNECTED_DATABASE_OID" == "$EXPECTED_DATABASE_OID" ]] \
  || { echo "연결 대상은 지정한 PostgreSQL 16 데이터베이스가 아닙니다" >&2; exit 1; }

# 모델 지문. model_version 은 레시피 이름이라 월 갱신에도 안 바뀌므로,
# "이번 달 점수가 정말 같은 모델에서 나왔는가" 를 이 해시로 남긴다.
# 월 재추론은 매 실행 재학습하지만 학습셋·파라미터·시드가 고정이라 결정론적이다
# — 단 동일 환경(lightgbm==4.6.0 등)에서만 성립한다.
if [[ -z "$MODEL_SHA" && -f "$BUNDLE/model/door1_final_model.pkl" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    MODEL_SHA=$(sha256sum "$BUNDLE/model/door1_final_model.pkl" | cut -c1-16)
  else
    MODEL_SHA=$(shasum -a 256 "$BUNDLE/model/door1_final_model.pkl" | cut -c1-16)
  fi
fi
[[ -z "$MODEL_SHA" || "$MODEL_SHA" =~ ^[a-f0-9]{8,64}$ ]] \
  || { echo "--model-sha는 소문자 SHA-256 hex 8~64자여야 합니다" >&2; exit 1; }

echo "▶ 적재 시작"
echo "  번들       : $BUNDLE"
echo "  model_ver  : $MODEL_VERSION"
echo "  model_sha  : ${MODEL_SHA:-(pkl 없음 — 기록 안 함)}"
# 예측 대상월 = 관측 기준월 + 6개월
as_of_year="${AS_OF%-*}"
as_of_month="${AS_OF#*-}"
target_month_index=$((10#$as_of_year * 12 + 10#$as_of_month - 1 + 6))
printf -v TARGET '%04d-%02d' \
  "$((target_month_index / 12))" "$((target_month_index % 12 + 1))"

SOURCE_LABEL="$(basename "$(dirname "$OUT")")/$(basename "$OUT")"
[[ "$SOURCE_LABEL" =~ ^[A-Za-z0-9._/-]+$ ]] \
  || { echo "source label 형식이 안전하지 않습니다: $SOURCE_LABEL" >&2; exit 1; }

echo "  as_of_date : $AS_OF"
echo "  target(t)  : $TARGET   ← as_of + 6개월, 명단공개 예측 대상월"
echo "  rebuild_at : $CANONICAL_TIMESTAMP"
[[ -n "$EXPECT_ROWS" ]] && echo "  기대 행수  : scored=$EXP_S queue=$EXP_Q safe=$EXP_F"

# firm_id  = sha1(사업장명 || '|' || 사업자번호)[:16]   ← **원본 이름 그대로**
# corp_key = sha1(정규화(사업장명) || '|' || 사업자번호)[:16]
#
# 정규화를 식별키에 쓰면 서로 다른 사업장이 합쳐진다(실측 171건 충돌 중 168건이 별개 사업장).
# 국민연금은 법인이 아니라 사업장 단위이므로 원본 이름이 식별 단위다.
# 정규화 키는 "같은 법인의 여러 사업장" 을 묶는 보조 컬럼으로만 쓴다.
read -r -d '' FIRM_ID_SQL <<'SQL' || true
substr(encode(digest(nm || '|' || bn, 'sha1'), 'hex'), 1, 16)
SQL

read -r -d '' CORP_KEY_SQL <<'SQL' || true
substr(encode(digest(
  regexp_replace(
    replace(replace(replace(replace(replace(replace(
      nm, '㈜',''), '(주)',''), '（주）',''), '주식회사',''), '(유)',''), '유한회사',''),
    '\s', '', 'g')
  || '|' || bn, 'sha1'), 'hex'), 1, 16)
SQL

"${PSQL[@]}" \
  -v "as_of_date=$AS_OF-01" \
  -v "target_month=$TARGET-01" \
  -v "model_version=$MODEL_VERSION" \
  -v "model_sha=$MODEL_SHA" \
  -v "source_label=$SOURCE_LABEL" \
  -f "$SCRIPT_DIR/sql/assert-path-b-session-identity.sql" \
  -f - <<SQL
BEGIN;

-- The canonical rebuild clock is explicit data, never transaction time.  The
-- round trip also rejects impossible dates and any UTC normalization change.
CREATE TEMP TABLE stg_path_b_canonical_clock (
  canonical_timestamp timestamptz PRIMARY KEY
) ON COMMIT DROP;
INSERT INTO stg_path_b_canonical_clock (canonical_timestamp)
SELECT :'canonical_timestamp'::timestamptz
WHERE to_char(
  :'canonical_timestamp'::timestamptz AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
) = :'canonical_timestamp';
DO \$clock\$
BEGIN
  IF (SELECT count(*) FROM stg_path_b_canonical_clock) <> 1 THEN
    RAISE EXCEPTION 'canonical timestamp failed exact UTC round trip';
  END IF;
END
\$clock\$;

-- ── staging (전부 TEXT) ────────────────────────────────────
DROP TABLE IF EXISTS stg_scored, stg_queue, stg_safe;

CREATE UNLOGGED TABLE stg_scored (
  "사업장명" text, "사업자번호" text, "시도" text, "업종" text, n_months text,
  "G1_고용안정" text,"G2_성실납부" text,"G3_인건비안정" text,"G4_인력유지" text,"G5_업력3년" text,"G6_낮은변동성" text,
  n_green text, "체불배제" text, "체납배제" text, risk_full text,
  turnover_avg_12m text,turnover_avg_3m text,turnover_max_12m text,turnover_std_12m text,
  emp_change_3m text,emp_change_6m text,emp_change_12m text,
  salary_avg_12m text,salary_last text,salary_change_6m text,salary_change_12m text,
  replacement_avg_12m text,replacement_avg_3m text,replacement_min_12m text,
  salary_drop_consecutive text,turnover_momentum text,zero_emp_months text,emp_volatility text,
  log_emp_count text,firm_age_months text,sido_code text,industry_category text,
  imputed_months_count text,imputed_ratio text,has_missing_recent_3m text,
  nf_bill_last_ratio text,nf_bill_maxdrop text,nf_pc_slope text,nf_pay_divergence text,
  nf_bill_cv text,nf_emp_slope text,nf_drawdown text,
  door1_ever text,door1_n_insu text,door1_maxamt text,door1_maxmonths text,
  door1_health text,door1_pension text,door1_labor text
  -- 총 54컬럼. AGENT_GUIDE §5 는 industry_death_rate_2023 이 남아있다고 하지만
  -- 이번 export(260807)에는 실제로 없다. 추가되면 여기에 컬럼을 더한다.
);
CREATE UNLOGGED TABLE stg_queue (
  "순위" text,"위험등급" text,"사업장명" text,"사업자번호" text,"시도" text,"업종" text,
  risk_full text,"door1_체납이력" text,"이미_임금체불공개" text,"핵심_위험사유" text
);
CREATE UNLOGGED TABLE stg_safe (
  "사업장명" text,"사업자번호" text,"시도" text,"업종" text,n_months text,n_green text,
  risk_full text,"체불배제" text,"체납배제" text,door1_ever text,"판정" text
);

\copy stg_scored FROM '$OUT/scored_active_full.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy stg_queue  FROM '$OUT/감독관_위험큐_full.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy stg_safe   FROM '$OUT/safe_recommendation_full.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')

-- ── batch 확보 (같은 as_of+model 이면 재적재) ───────────────
DELETE FROM batches
 WHERE as_of_date = :'as_of_date'::date
   AND model_version = :'model_version';

INSERT INTO batches (
  as_of_date, target_month, model_version, model_sha, source,
  n_scored, n_queue, n_safe, ingested_at
)
VALUES (:'as_of_date'::date,
        :'target_month'::date,
        :'model_version',
        nullif(:'model_sha', ''),
        :'source_label', 0, 0, 0,
        (SELECT canonical_timestamp FROM stg_path_b_canonical_clock));

CREATE TEMP TABLE cur AS SELECT currval(pg_get_serial_sequence('batches','id')) AS id;

-- ── firms upsert (세 파일 합집합) ──────────────────────────
WITH src AS (
  SELECT "사업장명" AS nm, "사업자번호" AS bn, "시도" AS sd, "업종" AS ind FROM stg_scored
  UNION
  SELECT "사업장명", "사업자번호", "시도", "업종" FROM stg_queue
  UNION
  SELECT "사업장명", "사업자번호", "시도", "업종" FROM stg_safe
), keyed AS (
  SELECT DISTINCT ON ($FIRM_ID_SQL)
         $FIRM_ID_SQL AS firm_id, $CORP_KEY_SQL AS corp_key, nm, bn, sd, ind
  FROM src
  ORDER BY $FIRM_ID_SQL, nm COLLATE "C", bn COLLATE "C",
           sd COLLATE "C" NULLS LAST, ind COLLATE "C" NULLS LAST
)
INSERT INTO firms (firm_id, corp_key, name, biz_no, sido, industry, first_seen, last_seen)
SELECT firm_id, corp_key, nm, bn, sd, ind, :'as_of_date'::date, :'as_of_date'::date FROM keyed
ON CONFLICT (firm_id) DO UPDATE
  SET corp_key=EXCLUDED.corp_key, name=EXCLUDED.name, biz_no=EXCLUDED.biz_no,
      sido=EXCLUDED.sido, industry=EXCLUDED.industry,
      first_seen=least(firms.first_seen, EXCLUDED.first_seen),
      last_seen=greatest(firms.last_seen, EXCLUDED.last_seen);

-- ── scored_active ─────────────────────────────────────────
INSERT INTO scored_active
SELECT (SELECT $FIRM_ID_SQL FROM (SELECT s."사업장명" nm, s."사업자번호" bn) q), (SELECT id FROM cur),
  nullif(n_months,'')::smallint,
  nullif("G1_고용안정",'')::numeric::int::bool, nullif("G2_성실납부",'')::numeric::int::bool,
  nullif("G3_인건비안정",'')::numeric::int::bool, nullif("G4_인력유지",'')::numeric::int::bool,
  nullif("G5_업력3년",'')::numeric::int::bool, nullif("G6_낮은변동성",'')::numeric::int::bool,
  nullif(n_green,'')::smallint,
  nullif("체불배제",'')::numeric::int::bool, nullif("체납배제",'')::numeric::int::bool,
  nullif(risk_full,'')::real, NULL,
  nullif(turnover_avg_12m,'')::real,nullif(turnover_avg_3m,'')::real,nullif(turnover_max_12m,'')::real,
  nullif(turnover_std_12m,'')::real,nullif(emp_change_3m,'')::real,nullif(emp_change_6m,'')::real,
  nullif(emp_change_12m,'')::real,nullif(salary_avg_12m,'')::real,nullif(salary_last,'')::real,
  nullif(salary_change_6m,'')::real,nullif(salary_change_12m,'')::real,nullif(replacement_avg_12m,'')::real,
  nullif(replacement_avg_3m,'')::real,nullif(replacement_min_12m,'')::real,nullif(salary_drop_consecutive,'')::real,
  nullif(turnover_momentum,'')::real,nullif(zero_emp_months,'')::real,nullif(emp_volatility,'')::real,
  nullif(log_emp_count,'')::real,nullif(firm_age_months,'')::real,
  sido_code, industry_category,
  nullif(imputed_months_count,'')::real,nullif(imputed_ratio,'')::real,nullif(has_missing_recent_3m,'')::real,
  nullif(nf_bill_last_ratio,'')::real,nullif(nf_bill_maxdrop,'')::real,nullif(nf_pc_slope,'')::real,
  nullif(nf_pay_divergence,'')::real,nullif(nf_bill_cv,'')::real,nullif(nf_emp_slope,'')::real,
  nullif(nf_drawdown,'')::real,
  nullif(door1_ever,'')::real,nullif(door1_n_insu,'')::real,nullif(door1_maxamt,'')::real,
  nullif(door1_maxmonths,'')::real,nullif(door1_health,'')::real,nullif(door1_pension,'')::real,
  nullif(door1_labor,'')::real
FROM stg_scored s;

-- ── inspector_queue ───────────────────────────────────────
INSERT INTO inspector_queue
SELECT (SELECT $FIRM_ID_SQL FROM (SELECT q."사업장명" nm, q."사업자번호" bn) x), (SELECT id FROM cur),
  "순위"::int, "위험등급", nullif(risk_full,'')::real,
  nullif("door1_체납이력",'')::numeric::int::bool,
  nullif("이미_임금체불공개",'')::numeric::int::bool,
  string_to_array("핵심_위험사유", ' · ')
FROM stg_queue q;

-- ── safe_recommendation ───────────────────────────────────
INSERT INTO safe_recommendation
SELECT (SELECT $FIRM_ID_SQL FROM (SELECT f."사업장명" nm, f."사업자번호" bn) x), (SELECT id FROM cur),
  nullif(n_months,'')::smallint, nullif(n_green,'')::smallint, nullif(risk_full,'')::real,
  nullif("체불배제",'')::numeric::int::bool, nullif("체납배제",'')::numeric::int::bool,
  nullif(door1_ever,'')::real, "판정"
FROM stg_safe f;

-- ── risk_tier — 전체 분포 기준 위험등급 ────────────────────
--
-- 모집단은 **이 batch 안에서** risk_full 이 있고 아직 명단공개 안 된 곳만이다.
-- batch_id 를 빼면 지난달 데이터와 섞여 백분위가 틀어진다 — 여러 달을 쌓는 구조이므로
-- 이 조건이 빠지면 조용히 잘못된 등급이 나온다.
--
-- 판정 순서: ① 이미공개(사실) → ② 정보부족 → ③ 백분위. 순서를 바꾸면 안 된다.
-- 라벨(매우높음/높음/…)은 inspector_queue.queue_priority(긴급/우선/…)와 **일부러 다르다**.
-- 큐 3,000곳은 전부 전체 상위 0.6% 안이라 같은 척도를 쓰면 84%가 한 등급에 몰린다.
WITH pop AS (
  SELECT firm_id, PERCENT_RANK() OVER (ORDER BY risk_full DESC) AS pr
  FROM scored_active
  WHERE batch_id=(SELECT id FROM cur)
    AND risk_full IS NOT NULL
    AND "체불배제" IS NOT TRUE
)
UPDATE scored_active t SET risk_tier = CASE
    WHEN p.pr <= 0.005 THEN '매우높음'
    WHEN p.pr <= 0.02  THEN '높음'
    WHEN p.pr <= 0.10  THEN '다소높음'
    ELSE '일반' END
FROM pop p
WHERE t.batch_id=(SELECT id FROM cur) AND p.firm_id=t.firm_id;

-- 모집단에서 빠진 행 = 이미공개 이거나 정보부족. 등급이 아니라 상태다.
UPDATE scored_active SET risk_tier =
  CASE WHEN "체불배제" IS TRUE THEN '이미공개' ELSE '정보부족' END
WHERE batch_id=(SELECT id FROM cur) AND risk_tier IS NULL;

-- ── 행수 기록 ─────────────────────────────────────────────
UPDATE batches SET
  n_scored=(SELECT count(*) FROM scored_active       WHERE batch_id=(SELECT id FROM cur)),
  n_queue =(SELECT count(*) FROM inspector_queue     WHERE batch_id=(SELECT id FROM cur)),
  n_safe  =(SELECT count(*) FROM safe_recommendation WHERE batch_id=(SELECT id FROM cur))
WHERE id=(SELECT id FROM cur);

-- ── 행수 단언: staging 과 적재 결과가 다르면 롤백 ──────────
DO \$\$
DECLARE b int; s1 int; s2 int; q1 int; q2 int; f1 int; f2 int; untiered int;
BEGIN
  SELECT id INTO b FROM cur;
  SELECT count(*) INTO s1 FROM stg_scored;
  SELECT count(*) INTO s2 FROM scored_active       WHERE batch_id=b;
  SELECT count(*) INTO q1 FROM stg_queue;
  SELECT count(*) INTO q2 FROM inspector_queue     WHERE batch_id=b;
  SELECT count(*) INTO f1 FROM stg_safe;
  SELECT count(*) INTO f2 FROM safe_recommendation WHERE batch_id=b;
  IF s1<>s2 OR q1<>q2 OR f1<>f2 THEN
    RAISE EXCEPTION 'CSV 와 적재 결과의 행수가 다릅니다 — scored %/%, queue %/%, safe %/%', s2,s1,q2,q1,f2,f1;
  END IF;

  -- ML팀이 알려준 기대 행수와도 맞는지. 다르면 엉뚱한 번들을 읽은 것이다.
  IF $EXP_S > 0 AND (s2<>$EXP_S OR q2<>$EXP_Q OR f2<>$EXP_F) THEN
    RAISE EXCEPTION '기대 행수와 다릅니다 — scored %(기대 %), queue %(기대 %), safe %(기대 %)',
      s2,$EXP_S, q2,$EXP_Q, f2,$EXP_F;
  END IF;

  -- 등급이 안 매겨진 행이 남으면 안 된다. 남았다면 위 두 UPDATE 의 조건이 어긋난 것이다.
  SELECT count(*) INTO untiered FROM scored_active WHERE batch_id=b AND risk_tier IS NULL;
  IF untiered > 0 THEN
    RAISE EXCEPTION 'risk_tier 가 비어 있는 행이 % 건 남았습니다', untiered;
  END IF;
END \$\$;

DROP TABLE stg_scored, stg_queue, stg_safe;
COMMIT;

ANALYZE firms; ANALYZE scored_active; ANALYZE inspector_queue; ANALYZE safe_recommendation;
SQL

echo "✔ 적재 완료"
"${PSQL[@]}" -c "\pset border 2" -c "
SELECT id AS batch,
       coalesce(to_char(as_of_date,'YYYY-MM'),'(NULL)') AS 기준월,
       coalesce(to_char(target_month,'YYYY-MM'),'(NULL)') AS 예측대상월,
       model_version, coalesce(model_sha,'-') AS model_sha, n_scored, n_queue, n_safe
FROM batches ORDER BY id DESC LIMIT 3;"

echo
echo "▶ 위험등급 분포 (방금 적재한 batch)"
"${PSQL[@]}" -c "\pset border 2" -c "
WITH b AS (SELECT max(id) AS id FROM batches)
SELECT s.risk_tier AS 등급, count(*) AS 사업장수,
       round(100.0*count(*)/sum(count(*)) OVER (), 2) AS 비율,
       coalesce(m.label,'-') AS 표기문구
FROM scored_active s
LEFT JOIN risk_tier_meta m ON m.tier = s.risk_tier
WHERE s.batch_id=(SELECT id FROM b)
GROUP BY s.risk_tier, m.label, m.sort_order
ORDER BY m.sort_order;"
