# 돈워리 데이터베이스

사업장 데이터(ML export)와 사용자 데이터(계정·커뮤니티·리뷰)를 담는 PostgreSQL.
이 디렉터리 하나로 자립한다 — 스키마·마이그레이션·적재 스크립트가 모두 여기 있다.

> 기존 운영 dump 없이 검증된 7개월 산출물로 새 DB를 만드는 GCP Path B 절차는
> [Path B 새 DB 재구축](docs/PATH_B_REBUILD.md)을 따른다. 일반 빠른 시작 명령을 여러 번
> 조합하지 말고, 빈 PostgreSQL 16 검증과 exact-count gate가 포함된 전용 bootstrap을 쓴다.
> 재구축 뒤 배포 정본 dump와 독립 복원 증명은
> [Path B 릴리스 게이트](docs/PATH_B_RELEASE_GATE.md)를 따른다.

## 빠른 시작

```bash
cd db
cp .env.example .env.local     # 값을 채운다 (아래 참고)
npm install
npm run up                     # Postgres 컨테이너 기동
npm run migrate                # 스키마 적용
npm run ingest -- --bundle ../_service_bundle \
    --model-version door1-voting-39f-v1 --as-of 2026-06 \
    --expect-rows 553598,3000,503887
```

Compose의 PostgreSQL 16 이미지는 multi-architecture OCI digest로 고정한다. 보안 patch를
갱신할 때는 moving tag만 바꾸지 않고 새 digest로 빈 PG16 복원 리허설과 Path B release gate를
다시 통과시킨다.

### `.env.local` 값

**이 서버는 여러 사람이 함께 쓴다.** Docker 컨테이너·볼륨·포트는 머신 전역이라,
접두사와 포트를 **사람마다 다르게** 잡아야 서로 충돌하지 않는다.

```bash
COMPOSE_PROJECT_NAME=wageguard-<본인>   # 컨테이너·볼륨 접두사
DB_PORT=5433                            # 겹치지 않는 포트
DB_NAME=wageguard
DB_USER=wageguard
DB_PASSWORD=<임의값>
DATABASE_URL=postgresql://wageguard:<DB_PASSWORD>@127.0.0.1:5433/wageguard
```

> ⚠️ **위 값은 로컬 개발용 기본값이다.** 배포 시에는 포트·비밀번호를 반드시 새로 정하고,
> DB 는 절대 `0.0.0.0` 으로 열지 않는다.

DB 는 `127.0.0.1` 에만 묶여 있다. 공용 머신이라 사내망에 열지 않는다.

배포할 때도 `0.0.0.0` 은 필요 없다.

| 배치 | DB 노출 |
| --- | --- |
| 앱·DB 같은 서버 (직접 실행) | `127.0.0.1` — 앱이 localhost 로 붙는다 |
| 앱·DB 같은 서버 (둘 다 Docker) | **포트를 안 연다.** 같은 compose 네트워크에서 `db:5432` 로 통신 |
| 앱·DB 다른 서버 | 사설망(VPC) 주소 또는 SSH 터널 |

현재 `ports:` 설정은 psql 로 들여다보기 위한 것이다. 앱을 같은 compose 에 올리면 지워도 된다.

## 스키마

두 갈래다.

### ML 산출물 (앱은 읽기만)

| 테이블 | 행수 | 내용 |
| --- | --- | --- |
| `firms` | 639,137 | 사업장 마스터. **배치 무관·누적.** 커뮤니티 글·리뷰가 이걸 참조 |
| `batches` | 7 | 적재 단위 — `as_of_date` + `model_version` + `model_sha` |
| `scored_active` | 553,598 ×배치 | 전체 점수 + 39피처 + `risk_tier` |
| `inspector_queue` | 3,000 ×배치 | 감독관 위험큐 + SHAP 위험사유 + `queue_priority` |
| `safe_recommendation` | 503,887 ×배치 | 구직자 안전추천 판정 |
| `risk_tier_meta` | 6 | 위험등급 해설표 (lift·표기 문구) |

현재 **7시점(2025-12 ~ 2026-06)** 이 적재돼 있다. `firms` 는 누적이라 한 배치보다 행이 많다.

세 CSV 는 **포함 관계**다: `scored_active ⊃ safe_recommendation ⊃ inspector_queue`.

### 🔑 식별키 — 여기가 가장 중요하다

**`사업자번호`는 식별자가 아니다.** 마스킹 6자리라 32,333개 번호가 553,598행에 재사용된다
(현재 DB 실측 최대 855곳). 번호 단독 키는 절대 금지.

| 컬럼 | 정의 | 용도 |
| --- | --- | --- |
| `firm_id` | `sha1(사업장명‖'|'‖사업자번호)[:16]` — **원본 이름** | 식별 (PK) |
| `corp_key` | `sha1(정규화(사업장명)‖'|'‖사업자번호)[:16]` | 같은 법인의 여러 사업장 묶기 |

> ⚠️ **`DB_BUILD_PROMPT §4` 와 다르다.** 프롬프트는 정규화한 이름으로 `firm_id` 를 만들라고 하지만,
> 그러면 **서로 다른 사업장이 합쳐진다.** 실측 결과 충돌 171건 중 **168건이 별개 사업장**이었다:
>
> ```
> 617810  한국쉘석유(주)      서울특별시  risk 0.163
>         한국쉘석유주식회사   부산광역시  risk 0.107
> ```
>
> 국민연금은 법인이 아니라 **사업장** 단위다. 정규화하면 실제 사업장 175곳이 사라진다.
> `(사업장명, 사업자번호)` 원본 쌍은 553,598행 전부 고유하므로 이게 올바른 식별 단위다.

`firm_id` 는 **불변이 아니다** — 사업장명이 바뀌면 달라진다(월 약 0.24%).
그래서 `firms` 에 원본 `name`·`biz_no` 를 보존한다. ML 팀이 안정 ID 를 export 에 넣으면 교체한다.

### 사용자 생성 데이터

`users` / `posts` / `comments` / `reviews` — 모두 `firm_id` 로 `firms` 를 참조한다.

> ⚠️ **익명 글도 작성자를 저장한다.** 본인 삭제·신고 처리에 필요하다.
> 익명성은 컬럼을 비우는 게 아니라 **조회 계층에서 이름을 빼는 것**으로 지킨다.

### 산업재해 ML (`industrial_safety` schema)

이 DB의 우선 목적은 산업재해 사업장 전체 이력을 보관하는 것이 아니라, **LLM 호출 전에
기존 사업장과 모델 결과의 연결·공표 상태·시간 기준을 검증하는 것**이다. 전체 약 2.59억
사업장×주 fact는 현재 범위가 아니다. 기존 임금체불 모델과 run 의미가 다르므로 결과는
`industrial_safety` schema로 격리하되, 사업장 마스터는 `public.firms`를 그대로 재사용한다.

| 객체 | 역할 |
| --- | --- |
| `pipeline_runs`, `pipeline_run_dependencies` | SHA·모델·의존성·current 공표 lineage |
| `cell_week_predictions`, `cell_label_datasets`, `cell_week_labels` | 17개 시도×10개 대업종 주별 셀 예측과 독립 라벨 계약 |
| `firm_risk_results` | `public.firms`와 strict exact/human 검증된 NPS 결과만 저장 |
| `workplaces`, `workplace_snapshots`, `workplace_predictions` 등 | `full` 호환용. 축소 scope에서는 적재하지 않음 |

적재 scope는 항상 명시한다.

| scope | 적재 범위 | 로컬 DB 최소 여유공간 | 권장 용도 |
| --- | --- | ---: | --- |
| `cell-validation` | 셀 예측 92,140 + 라벨 184,280행 | 2 GiB | 모델/API 라벨 사전 검증 |
| `existing-firms` | 위 셀 데이터 + strict 연결 515,608행 | 5 GiB | **LLM 사전검증 기본값** |
| `full` | NPS/KCOMWEL 최신주 wide 원장·snapshot·배분 결과 | 40 GiB | 별도 승인된 연구/검증 |

`full`도 2.59억 행 역사 backfill을 허가하지 않는다. `workplace_predictions` partition과
security-barrier VIEW는 Drizzle이 전부 표현하지 못하므로 **`drizzle-kit push`를 사용하지
않고 검토된 migration만 적용**한다.

```bash
npm run migrate
```

읽기 전용 봇에는 산업재해 base table을 열지 않는다.
`v_llm_firm_safety_context`, `v_cell_api_label_comparison` 두 안전 view만 명시적으로 허용한다.
strict 매칭 funnel, 금지 키, SHA snapshot/no-op 및 운영 절차는
[existing-firms 계약](docs/INDUSTRIAL_SAFETY_EXISTING_FIRMS_CONTRACT.md)을 따른다.

## 적재 (`scripts/ingest.sh`)

```bash
./scripts/ingest.sh --bundle ../_service_bundle \
  --expected-database wageguard \
                    --model-version door1-voting-39f-v1 \
                    --as-of 2026-06 \
                    --expect-rows 553598,3000,503887
```

| 인자 | 뜻 |
| --- | --- |
| `--as-of` | 관측창의 끝(t-6) = 채점에 쓴 국민연금 파일의 마지막 달. `target_month` 는 +6개월로 자동 |
| `--model-version` | 모델 **레시피**의 이름. 날짜를 넣지 않는다 — 그건 `as_of_date` 가 맡는다 |
| `--model-sha` | 생략하면 번들의 `door1_final_model.pkl` 에서 자동 계산 |
| `--expect-rows` | ML팀이 알려준 기대 행수. 다르면 롤백한다 (엉뚱한 번들을 읽은 것) |
| `--env-file` | DB 접속 key만 읽을 env 파일. shell code로 실행하지 않는다 |

- CSV 를 **전부 TEXT 인 staging 테이블**에 `\copy` 로 벌크 적재 후 SQL 로 변환. 55만행에 약 2분.
- **멱등하다.** 같은 `(as_of_date, model_version)` 을 다시 적재하면 그 batch 만 갈아끼운다.
- **행수를 단언한다.** staging 과 적재 결과가 다르면 예외를 던지고 롤백한다.
  (조용히 버리면 데이터가 사라진 걸 아무도 모른다 — 실제로 처음에 175행을 잃었다.)
- 빈 값은 **NULL** 로. `risk_full` 은 49,703곳(9.0%)이 NULL 이다 — **0 으로 채우지 말 것.**
- 적재가 끝나면 `risk_tier` 를 **같은 트랜잭션 안에서** 계산한다(아래).

### 위험등급 두 가지 — 헷갈리기 쉽다

**이름이 비슷하지만 다른 척도다.** 한때 둘 다 '긴급' 을 썼는데 가리키는 집합이 25배 달랐다.

| 컬럼 | 범위 | 기준 | 값 |
| --- | --- | --- | --- |
| `scored_active.risk_tier` | 배치 전체 55만 곳 | 백분위 | 매우높음 / 높음 / 다소높음 / 일반 (+ 정보부족 / 이미공개) |
| `inspector_queue.queue_priority` | 큐 3,000곳 | 순위 | 긴급 / 우선 / 주의 / 관찰 |

**큐 정렬은 `rank` 로 한다.** `risk_tier` 로 큐를 정렬하면 안 된다 — 큐 3,000곳은 전부
전체 상위 0.6% 안이라 84%가 한 등급에 몰려 변별이 되지 않는다.

`risk_tier` 계산 규칙:

- 백분위 모집단 = **그 batch 안에서** `risk_full IS NOT NULL AND 체불배제 IS NOT TRUE`
  → `batch_id` 를 빼면 여러 달치가 섞여 조용히 틀어진다
- 판정 순서 = ① 이미공개(사실) → ② 정보부족 → ③ 백분위. **순서를 바꾸면 안 된다**
- 컷 = 상위 0.5% / 2% / 10%

등급의 뜻(lift·표기 문구)은 `risk_tier_meta` 테이블에 있다.
**ML팀이 라벨 있는 CV 로 실측한 값이며 DB 에는 라벨이 없어 재계산할 수 없다** — 임의로 고치지 말 것.
`is_prediction = false` 인 두 행(`이미공개`·`정보부족`)은 예측이 아니라 사실·상태이므로
화면에서 위험 등급과 섞어 표시하면 안 된다.

### 여러 달을 쌓으면 — 반드시 뷰를 쓴다

과거월 백필로 **7시점(2025-12 ~ 2026-06)** 이 들어가 있다. 그래서 조회 방법이 달라진다.

```sql
-- ❌ 원본 테이블 직접 조회 — 7개월치가 다 나온다. 에러가 안 나서 조용히 틀린다
SELECT count(*) FROM scored_active WHERE risk_tier='매우높음';   -- 17,000 남짓

-- ✅ 뷰 — 현재 배치만
SELECT count(*) FROM v_current_scored WHERE risk_tier='매우높음'; -- 2,519
```

| 뷰 | 용도 |
| --- | --- |
| `v_current_scored` · `v_current_queue` · `v_current_safe` | **화면·챗봇은 이것만 쓴다** |
| `v_current_batch` | 현재 배치 메타 한 행 |
| `v_risk_history` | 사업장별 월간 추이 |

**`v_current_batch` 는 `id` 가 아니라 `as_of_date` 로 최신을 고른다.** 백필은 과거 달을 나중에
넣으므로 **`id` 가 큰 배치가 최신 달이 아니다** — 실제로 현재 배치는 `id=4` 이고 백필이 5~10이다.

### 위험도 추이 조회

```sql
SELECT as_of_date, risk_full, risk_tier, verdict, queue_rank
FROM v_risk_history WHERE firm_id = ? ORDER BY as_of_date;
```

**7개월 내내 존재하는 사업장은 74.8%** 다. 나머지는 구간이 빈다(폐업·신규 = 정상).
**선을 잇지 말고 끊어서 그린다** — 없는 데이터를 이으면 없던 추세가 생긴다.

> ⚠️ `체불배제`·`체납배제` 는 점-인-타임이 아니라 **현재 상태**다. 2026-03에 공개된 곳이
> 2025-12 출력에도 찍힌다. `risk_full` 에는 영향이 없고, 모집단 대비 0.03% 미만이라
> 등급 경계도 실질적으로 움직이지 않는다.

### 월 갱신 절차

새 국민연금 데이터가 나오면 **모델은 그대로 두고 점수만 다시 낸다**(재추론).
모델이 실제로 바뀌는 재학습은 새 임금체불 명단공개 차수가 나올 때뿐이다.

1. ML팀이 새 번들(`outputs/` 3종)을 전달한다. **재추론은 ML 쪽에서 한다** —
   채점 코드와 국민연금 원본이 이 저장소에 없다.
2. `--as-of` 를 새 달로 바꿔 적재한다. `--model-version` 은 **그대로 둔다.**
3. 적재 로그의 등급 분포에서 누적 비율이 0.5% / 2% / 10% 인지 확인한다.
4. 이전 batch 를 지울지 남길지 정한다. 남기면 위험도 추이를 그릴 수 있고, DB 는 배치당 약 330MB 늘어난다.
5. 지웠다면 `VACUUM FULL ANALYZE`.

**순위가 매달 크게 바뀌는 것은 정상이다.** 모델이 같아도 관측창이 밀리면 대부분 사업장의
피처가 바뀐다. 실측(2026-04 → 2026-06)에서 상위 100곳 유지율 20%, 큐 3,000곳 유지율 54%,
전체 순위상관 0.872였다. 최근 이상신호를 잡는 지표라 원래 최상위가 많이 흔들린다.

`batches.model_sha` 로 그걸 증명할 수 있다 — 이 값이 같으면 **모델이 아니라 데이터 때문**이다.

### `as_of_date` 가 뭔가

이 출력이 **어느 국민연금 데이터로 채점됐는지**다. 파일 생성일이 아니다.
모델은 `[t-18, t-6]` 창의 피처로 시점 `t` 를 예측하므로, 데이터가 언제 것인지 모르면
화면에 "언제 기준 위험도"인지 말할 수 없다.

미확정이면 생략해도 되고(NULL), 확인되면 채운다:
```sql
UPDATE batches SET as_of_date='2026-02' WHERE id=2;
```

### Python 에서 적재해도 된다

스키마는 언어 중립이다. 다만 **`사업자번호`·`sido_code`·`industry_category` 는 반드시 `str`** 로 읽어야 한다
(`dtype=str`). `sido_code` 를 int 로 읽으면 모델이 문자열 `'11'` 로 학습한 것과 어긋난다.

**스키마 변경은 반드시 마이그레이션 파일로.** 컨테이너에 직접 `ALTER TABLE` 을 치면 다른 사람 DB 와 조용히 어긋난다.
```bash
npm run generate   # schema.ts 수정 후 → migrations/ 에 SQL 생성 → 커밋
npm run migrate
```

## 산업재해 적재 (`scripts/ingest-industrial-safety.sh`)

`validate-only`는 DB에 접속하지 않고 registry의 byte 수·SHA-256·행수, 17×10 grid,
canonical 모델 상수, NULL/확률/보존식 계약을 확인한다. 기본 scope가 `full`이므로
실행 의도가 드러나도록 `--scope`를 항상 명시한다.

```bash
./scripts/ingest-industrial-safety.sh --validate-only --scope cell-validation
./scripts/ingest-industrial-safety.sh --validate-only --scope existing-firms
```

새 서버에서 artifact 루트가 registry의 기존 `/data/shared-SeD` 경로와 다르면
registry의 행수·byte·SHA 계약은 바꾸지 않고 루트만 명시적으로 override한다.

```bash
./scripts/ingest-industrial-safety.sh \
  --validate-only \
  --scope existing-firms \
  --v2-root /srv/moneyworry/artifacts/weekly_workplace_risk_v2_201512_202604 \
  --extension-root /srv/moneyworry/artifacts/weekly_workplace_risk_api_extension_v3_201512_202604
```

두 번째 명령은 고정된 NPS 원천까지 검증하지만 DB에 접속하지 않으므로 `public.firms`와의
strict funnel은 실행하지 않는다. 실제 매칭은 아래 rollback/apply 경로에서 대상 DB의
`public.firms`를 private snapshot으로 export한 뒤 수행한다.

DB 시험은 `wageguard_is_test_*` 이름의 별도 DB에서만 수행한다. test DB에도 migration과
`public.firms` 기준 데이터가 먼저 있어야 한다. env 파일은 shell로 실행하지 않고 허용된
`DB_*` 키만 읽는다.

```bash
# 셀 검증 표본을 적재·검증한 뒤 명시적으로 ROLLBACK
./scripts/ingest-industrial-safety.sh \
  --rollback \
  --scope cell-validation \
  --env-file /path/to/.env.local \
  --database wageguard_is_test_cell_01 \
  --sample-per-source 1000

# 기존 firms strict 매칭과 축소 결과를 함께 시험하고 ROLLBACK
./scripts/ingest-industrial-safety.sh \
  --rollback \
  --scope existing-firms \
  --env-file /path/to/.env.local \
  --database wageguard_is_test_existing_firms_01 \
  --sample-per-source 1000
```

운영 반영 전 선행조건은 다음과 같다.

- migration 적용 완료. `existing-firms`는 `industrial_safety.firm_risk_results`가 있어야 한다.
- 프로젝트·loader·SQL·config 경로가 symlink 또는 world-writable이 아니어야 한다.
- env 파일은 실행 사용자 소유의 mode `0600` 일반 파일이어야 한다.
- loader DB role은 `public.firms` 읽기와 필요한 `industrial_safety` DML/sequence 권한을 가져야 한다.
- `wg_bot`은 적재 role로 사용하지 않는다. 안전 view 권한은 적재·검증 후 별도로 설정한다.

loader는 다음을 하나의 검증 흐름으로 처리한다.

1. 고정 원천 SHA 검증과 mode-0700 임시 stage 생성
2. `existing-firms`이면 `public.firms`를 `firm_id` 순으로 export하고 rows/bytes/SHA-256 고정
3. strict exact funnel과 prepared 파일·loader·registry SHA 재검증
4. TEMP TEXT staging `\copy`, 대상 `public.firms` snapshot 양방향 비교, PK/FK·행수 검증
5. 모든 gate 통과 후에만 기존 current를 supersede하고 새 run을 publish

동일 fingerprint는 DB metadata와 물리 행수를 다시 확인하고 **UPDATE 0건 no-op**으로 끝난다.
동일 fingerprint인데 snapshot·행수·물리 키셋·fact 값이 다르면 재사용하지 않고 실패한다.

운영 목적이 LLM 사전검증이면 다음 둘 중 필요한 scope만 적용한다. `existing-firms`에는
`cell-validation` 범위가 포함되므로 처음부터 사업장 조회가 필요하면 두 번째 명령 하나로 충분하다.

```bash
# 셀 수준 검증만 반영
./scripts/ingest-industrial-safety.sh \
  --apply \
  --scope cell-validation \
  --confirm-apply industrial_safety.v1.0 \
  --env-file /path/to/.env.local

# 기존 public.firms와 strict 연결된 결과까지 반영
./scripts/ingest-industrial-safety.sh \
  --apply \
  --scope existing-firms \
  --confirm-apply industrial_safety.v1.0 \
  --env-file /path/to/.env.local
```

`full`은 40 GiB DB 여유공간과 별도 test DB 실측·승인이 있을 때만 명시적으로 실행한다.

```bash
./scripts/ingest-industrial-safety.sh \
  --apply \
  --scope full \
  --confirm-apply industrial_safety.v1.0 \
  --env-file /path/to/.env.local
```

검증 SQL은 운영 DB에 바로 실행하지 말고 먼저 test DB에서 수행한다.

```bash
psql ... -f scripts/sql/assert-industrial-safety-migration.sql
psql ... -f scripts/sql/assert-industrial-safety-sample.sql
psql ... -v assert_scope=cell-validation \
  -f scripts/sql/assert-industrial-safety-reduced-sample.sql
psql ... -v assert_scope=existing-firms \
  -f scripts/sql/assert-industrial-safety-reduced-sample.sql
```

## 챗봇·LLM 에이전트용 읽기 전용 롤

```bash
echo "BOT_PASSWORD=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)" >> .env.local
./scripts/create-bot-role.sh --env-file .env.local
```

`wg_bot` 롤이 만들어진다. 접속: `psql -h 127.0.0.1 -p 5433 -U wg_bot -d wageguard`

| 접근 가능 | 접근 불가 |
| --- | --- |
| `firms`, `scored_active`, `inspector_queue`, `safe_recommendation`, `batches` | `users` (이메일·비밀번호 해시) |
| `v_posts`, `v_comments`, `v_reviews` — 신원 제거 뷰 | `posts`/`comments`/`reviews` **원본** |
| `industrial_safety.v_llm_firm_safety_context`, `v_cell_api_label_comparison` | 산업재해 base tables, source ID·연구용 확률·주소 포함 내부 view |

> 🔴 **왜 원본이 아니라 뷰인가**: 커뮤니티 원본에는 `author_id` 가 있다.
> 그게 보이면 **익명 글을 작성자와 연결할 수 있어 익명성이 깨진다.**
> 웹은 직렬화 단계에서 실명을 지우는데, DB 직접 조회가 그걸 우회하면 안 된다.
> 뷰는 `author_id` 를 아예 노출하지 않고, 익명 글의 `author_name` 은 NULL 이다.

안전장치: `default_transaction_read_only=on` · `statement_timeout=15s` ·
`idle_in_transaction_session_timeout=30s`.

**LLM 은 프롬프트 인젝션에 취약하다.** 커뮤니티 글에 "테이블을 지워라" 가 심어져 있어도
권한이 없으면 아무 일도 일어나지 않는다. 모델을 믿는 대신 DB 권한으로 막는다.

`ALTER DEFAULT PRIVILEGES` 는 일부러 쓰지 않았다 — 앞으로 만들 테이블에 권한이 자동으로 붙으면
민감한 테이블이 생겼을 때 아무도 모르게 열린다. **새 테이블은 매번 명시적으로 GRANT 한다.**

## 살펴보기

```bash
npm run studio      # 브라우저 GUI
docker compose --env-file .env.local exec db psql -U wageguard -d wageguard
```

## 검색 성능 메모

`migrations/0001_extensions.sql` 이 `pg_trgm` 확장과 사업장명 GIN 인덱스를 건다.
`name LIKE '%삼성전자%'` 는 B-tree 로는 인덱스를 못 타고 전체 스캔이 되지만,
trigram GIN 으로는 **2ms** 에 끝난다. trigram 은 3글자 단위로 분해하므로 한글에도 동작한다.

측정값(7배치 · 386만행 기준):

| 쿼리 | 시간 |
| --- | --- |
| 회사명 부분일치 | 2 ms |
| 등급별 집계 (`v_current_scored`) | 4 ms |
| 사업장 1곳의 7개월 추이 | 8 ms |
| 감독관 큐 top-50 + 사유 | 36 ms |
| 지역별 안정신호 정렬 | 70 ms |
| corp_key 로 같은 법인 묶기 | 1 ms |

배치가 늘어도 조회는 느려지지 않는다. 인덱스가 전부 `(batch_id, …)` 로 시작해
지정한 배치 밖은 아예 읽지 않기 때문이다.

## 운영 메모

### 적재 후에는 VACUUM 을 돌린다

Postgres 는 행을 덮어쓰지 않는다. `UPDATE` 하면 새 버전을 쓰고 옛 버전(dead tuple)은 남는다.
적재는 `firms` 를 전 행 `UPSERT` 하고 `risk_tier` 를 전 행 `UPDATE` 하므로 매번 한 벌씩 쌓인다.
7배치 적재 후 실측으로 **3,223MB → 2,384MB**(839MB)를 회수했다(54초).

```bash
psql ... -c "VACUUM FULL ANALYZE;"
```

| | 하는 일 | 잠금 |
| --- | --- | --- |
| `VACUUM` | 죽은 행을 "재사용 가능"으로 표시. **파일 크기는 그대로** | 없음 |
| `VACUUM FULL` | 테이블을 새로 써서 OS 에 공간 반환 | 테이블 전체 |

### ⚠️ VACUUM 이 "No space left on device" 로 실패하면

```
ERROR: could not resize shared memory segment ... No space left on device
```

**디스크가 아니라 컨테이너의 `/dev/shm` 이다.** Docker 기본값이 64MB 인데 Postgres 의
병렬 워커가 여기에 공유메모리를 잡는다. `docker-compose.yml` 의 `shm_size: 1gb` 가
이걸 막는다 — 컨테이너를 새로 만들어야 적용된다(`npm run down && npm run up`).

급하면 병렬을 끄고 우회할 수 있다:

```sql
ALTER SYSTEM SET max_parallel_maintenance_workers = 0;  SELECT pg_reload_conf();
-- VACUUM FULL ANALYZE;
ALTER SYSTEM RESET max_parallel_maintenance_workers;    SELECT pg_reload_conf();
```

### DB 볼륨 위치 — 알고서 그대로 뒀다

named volume 이 Docker 기본 경로(루트 파티션)에 있다. 이 서버에서는 루트 여유가
`/data` 보다 훨씬 적지만, **배치당 약 330MB 라 수십 개월치 여유가 있어 옮기지 않았다.**

옮기려면 Docker data-root 를 바꾸거나(→ 이 머신의 **모든 사용자** 컨테이너에 영향)
bind mount 로 전환해야 하는데(→ 컨테이너 안 postgres 는 uid 999 라 권한이 꼬이고,
repo 안에 두면 `git clean` 한 번에 날아간다) 둘 다 공용 서버에서 가볍게 할 일이 아니다.

공간이 부족해지면 **옛 배치를 지우는 것**이 먼저다.

```sql
DELETE FROM batches WHERE as_of_date < DATE '2026-03-01';   -- 자식 행은 CASCADE
```
