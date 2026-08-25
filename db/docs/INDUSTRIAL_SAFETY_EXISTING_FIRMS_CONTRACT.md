# 산업재해 existing-firms 축소 적재 계약

- 계약 버전: `industrial_safety.v1.0`
- 기준일: 2026-08-09
- 대상: PostgreSQL 16 / `industrial_safety` schema
- 기본 소비자: LLM 호출 전 검증 백엔드

## 1. 목적과 비목적

이 계약의 목적은 산업재해 산출물 전체를 DB 원장으로 복제하는 것이 아니다. 사용자 요청을
LLM에 보내기 전에 다음 사실을 fail-closed 방식으로 검증하는 작은 serving DB를 만드는 것이다.

- 요청한 사업장이 기존 `public.firms`에 존재하는가
- NPS 결과가 그 firm에 strict 방식으로 연결됐는가
- 결과 run이 검증·공표됐고 현재 publication scope인가
- 목표주와 `prediction_as_of`가 무엇인가
- 값이 검증된 사업장 사고확률이 아니라 모집단 내 연구용 우선순위임이 명시됐는가

전체 약 259,331,227개 사업장×주 역사 fact backfill은 이 계약의 범위가 아니다. 최신주 전체
NPS/KCOMWEL 원장을 복제하는 `full`도 LLM 검증 경로의 기본값이 아니다.

## 2. 적재 scope

| scope | DB에 적재하는 것 | 적재하지 않는 것 | 로컬 DB 최소 여유공간 |
| --- | --- | --- | ---: |
| `cell-validation` | `pipeline_runs`, dependencies, 셀 예측 92,140행, 두 라벨 184,280행 | 사업장 마스터·snapshot·사업장 결과 | 2 GiB |
| `existing-firms` | `cell-validation` 전체 + 검증된 `firm_risk_results` 518,806행 | 별도 사업장 마스터, KCOMWEL 원장, ambiguous/unmatched 후보 | 5 GiB |
| `full` | 최신주 NPS/KCOMWEL wide 사업장·snapshot·배분 fact | 2.59억 역사 backfill | 40 GiB |

현재 서비스 목적에는 `existing-firms`가 기본 선택이다. 셀 수준 비교만 필요하면
`cell-validation`을 선택한다. `full`은 별도 test DB 용량 실측과 승인을 받은 연구 작업에만 쓴다.

위 값은 로컬 non-sample apply를 거부하는 안전 하한이지 실제 필요량 보증이 아니다. stage
filesystem 하한은 각각 0.5 GiB, 2 GiB, 10 GiB다. 원격 DB는 loader가 DB filesystem을 직접
측정할 수 없으므로 운영자가 별도로 heap·index·WAL·temp 여유를 확인해야 한다.

현재 `existing-firms`의 계측치는 stage 약 273 MiB, 최초 permanent 증가 약 270~380 MiB다.
TEMP relation, index sort, WAL을 함께 잡은 일시 peak 추정은 약 1.0~2.1 GiB이므로 5 GiB
하한은 단일 적재에 보수적이다. 다만 PGDATA/pg_wal이 검사한 filesystem에 있고, replication
slot·archive 장애나 동시 대량 write가 없다는 조건이다. 새 firm-risk run을 계속 보존하면
run마다 약 0.2~0.3 GiB가 누적되므로 retention 정책을 별도로 둔다.

## 3. canonical 사업장 마스터

`public.firms`가 유일한 사업장 마스터다. 산업재해 loader는 이 테이블에 사업장을 INSERT,
UPDATE, DELETE하지 않는다.

```text
public.firms
    └── firm_id PK
          └── industrial_safety.firm_risk_results.firm_id FK
```

`existing-firms` 실행 시 대상 DB에서 다음 다섯 컬럼만 `firm_id` 순으로 private stage에 export한다.

```text
firm_id, name, biz_no, sido, industry
```

산업재해 원천의 이름·번호·지역·업종은 매칭 검증에만 사용한다. 별도 `workplaces` 또는 주소
원장을 만들거나 기존 firm 속성을 산업재해 값으로 덮어쓰지 않는다. 연결되지 않은 NPS/KCOMWEL
행도 `public.firms`에 자동 추가하지 않는다.

`firm_id`는 기존 규칙을 그대로 사용한다.

```text
sha1(원본 사업장명 || '|' || 마스킹 사업자번호 6자리)[:16]
```

이 키는 이름이 바뀌면 달라지는 잠정키다. 따라서 source artifact SHA와 함께 해당 실행 시점의
`public.firms` snapshot SHA를 반드시 보존한다.

## 4. strict 매칭 funnel

현재 고정 NPS source 549,558행의 acceptance 기준선은 다음과 같다. 네 결과 집합은 서로
배타적이며 합계가 source 전체와 같아야 한다.

| 결과 | 행수 | 처리 |
| --- | ---: | --- |
| `verified_exact` | **518,806** | `firm_risk_results` 적재 가능 |
| exact identity 이후 canonical 시도 또는 업종 속성 불일치 | **1,329** | 적재 금지, review 대상 |
| NPS 원천 raw-key 중복 | **382** | 적재 금지, ambiguous review 대상 |
| 기존 `public.firms` exact identity 없음 | **29,041** | 적재 금지, unknown 처리 |
| 합계 | **549,558** | NPS source 행수와 일치해야 함 |

자동승인 행은 다음 조건을 모두 만족한다.

1. source `workplace_id`가 NPS source 안에서 유일하다.
2. `(원본 workplace_name, business_registration_prefix6)`가 source 안에서 유일하다.
3. 이 원본 이름·번호로 계산한 candidate `firm_id`가 `public.firms.firm_id`와 같다.
4. source 원본 이름과 `firms.name`이 정확히 같다.
5. source 번호 앞 6자리와 `firms.biz_no`가 정확히 같다.
6. source 시도와 canonicalized `firms.sido`가 정확히 같다.
7. source 업종명과 `firms.industry`가 정확히 같다.
8. 최종 source와 target이 모두 run 안에서 1:1이다.

적재되는 고정 상태값은 다음과 같다.

```text
validation_status = verified_exact
match_method       = exact_name_masked_business_registration_sido_industry
confidence_tier    = exact_unique
```

향후 `verified_human`을 적재하려면 reviewer와 reviewed timestamp가 모두 있어야 한다. ambiguous,
unmatched, stale은 `firm_risk_results.validation_status` 값이 아니다. ambiguous/unmatched는 제한된
검토 보고서에만 남기고, stale은 안전 view가 목표주를 기준으로 파생한다.

## 5. 연결에 사용하면 안 되는 키와 방법

| 금지 대상 | 이유 |
| --- | --- |
| `biz_no` 단독 | 공개 마스킹 6자리라 비고유이며 한 번호가 다수 사업장에 재사용됨 |
| `corp_key` | 법인·표기변형 묶기용 보조키이며 사업장 identity가 아님 |
| 정규화 이름 또는 fuzzy 이름 | 서로 다른 지점·사업장을 합칠 수 있음 |
| CSV/Parquet row order | 두 파일의 물리 행 순서는 계약 키가 아니며 달라질 수 있음 |
| `source_entity_link_id` / `workplace_entity_link_id` | 중복이 있고 이름·주소 변화 시 바뀔 수 있는 후보 연결키 |
| source workplace ID 단독 cross-system join | source namespace 내부 대체키일 뿐 공식 영속 사업장 ID가 아님 |

Parquet과 display CSV는 반드시 `workplace_id`로 조인한다. 행 번호나 파일 순서로 합치면 안 된다.

## 6. 저장 grain과 의미

`firm_risk_results`의 grain은 다음과 같다.

```text
(run_id, firm_id, target_week_start)
```

source 유일성은 다음 제약으로 별도 보장한다.

```text
(run_id, source_workplace_id, target_week_start) UNIQUE
```

run은 `run_kind=firm_risk`이며 한 target week만 가질 수 있다. 현재 publication scope는 다음이다.

```text
industrial_safety.firm_risk.existing_firms.nps
```

`research_only_provisional_probability`는 재현·감사용 내부 값이다. 셀 기대 승인레코드를 배분한
시나리오 값이며 검증된 사업장 사고확률이 아니다. LLM에는 이 원값을 노출하지 않는다.

`provisional_population_priority_percentile`과 band도 같은 run·주·NPS 모집단 안에서의 상대적
점검 우선순위다. 인과효과, 법 집행 기준, 사업장 간 절대위험 비교로 해석하면 안 된다.

## 7. `public.firms` SHA snapshot과 no-op

`existing-firms`는 다음 순서를 지켜야 한다.

1. registry와 승인된 다섯 source artifact를 각각 `O_NOFOLLOW` regular-file descriptor로 연다.
2. 같은 descriptor에서 SHA-256을 계산하면서 mode-0700 private stage로 복사하고, source의
   `fstat` identity/size/mtime/ctime을 복사 전후 비교한다.
3. source bundle의 directory는 mode-0500, 파일은 mode-0400으로 봉인한다. prepare와
   verify에는 원본 경로를 넘기지 않고 이 bundle의 config, `v2`, `extension` root만 넘긴다.
4. 대상 DB의 `public.firms`를 `firm_id` 순으로 별도 mode-0600 prepared directory에 export한다.
5. snapshot의 rows, bytes, SHA-256을 prepared manifest에 기록한다.
6. snapshot과 strict 결과 파일 참조를 firm-risk run의 `artifact_bundle`과 fingerprint에 포함한다.
7. DB 적재 transaction에서 `public.firms`를 잠근 뒤 snapshot과 live table을 양방향 비교한다.
8. 한 행이라도 추가·삭제·변경됐으면 적재를 중단하고 새 snapshot으로 처음부터 다시 준비한다.

봉인 대상은 `v2_cell`, `api_occurrence_bounded`, `nps_workplace`, `nps_display`,
`nps_quality`와 이들을 지정하는 registry config다. source pathname을 해시한 뒤 다시 여는
방식은 허용하지 않는다. `validate-only`는 DB나 credential을 사용하지 않는 원천 사전검사이고,
실제 rollback/apply의 prepare·verify는 반드시 private source bundle을 새로 만든다.

동일 fingerprint 재실행은 metadata와 실제 DB 행수·키셋을 다시 확인한 뒤 UPDATE 0건으로
종료한다. current run을 다시 supersede/publish하거나 timestamp를 갱신하지 않는다.

- 동일 fingerprint + 동일 물리 결과: no-op
- 동일 fingerprint + 다른 metadata/행수/키셋: 오류
- `public.firms` snapshot 또는 prepared result SHA 변경: 새 fingerprint/run
- loader/config SHA 변경인데 계약 버전이 그대로임: 재사용 거부

stage는 기본적으로 종료 시 삭제한다. `--keep-stage`에는 canonical firm snapshot, 승인 source
artifact 사본과 내부 source ID가 남으므로 접근 통제된 진단 상황 외에는 사용하지 않는다.

## 8. LLM 안전 view 계약

LLM 또는 봇은 base table 대신 다음 view만 조회한다.

```text
industrial_safety.v_llm_firm_safety_context
industrial_safety.v_cell_api_label_comparison
```

`v_llm_firm_safety_context`는 published/current firm-risk run과 검증된 firm 결과만 반환한다.
firm 조회가 0행이면 `not_verified_or_unavailable`이며 안전 또는 사고 없음으로 해석하지 않는다.
아래 숨김 목록은 이 view의 projection 계약이며 `public` schema에 이미 부여된 기존 권한과는
별개다.

| 노출 가능 | 숨김 |
| --- | --- |
| canonical `firm_id`, 이름, 시도, 업종 | source `workplace_id`와 source 이름 |
| target week, `prediction_as_of`, temporal status | 마스킹 사업자번호와 주소 |
| firm match validation/method/confidence | ambiguous 후보·evidence·reviewer identity |
| provisional priority percentile/band | `research_only_provisional_probability` 원값 |
| model/calibration/probability/risk-value 상태 | 내부 artifact path와 prepared 파일 |
| source SHA-256, published/validated 시각 | 산업재해 base table 전체 |

안전 view의 `temporal_status`는 최소 `not_yet_effective`, `current_target_week`,
`stale_target_week`를 구분한다. `pipeline_runs.is_current`는 최신 공표 run이라는 뜻이지 목표주가
오늘도 유효하다는 뜻이 아니다.

## 9. 권한 선행조건

### 파일시스템

credential-bearing rollback/apply 전에 다음 조건을 모두 만족해야 한다.

- 프로젝트 루트, `scripts`, `scripts/sql`, loader Python, config가 symlink가 아니다.
- 위 경로 어느 것도 world-writable이 아니다.
- env 파일은 symlink가 아닌 실행 사용자 소유의 mode `0600` 파일이다.
- stage parent는 실행 사용자가 쓸 수 있고 필요한 여유공간이 있다.

공유 서버의 현재 소유권을 확인하지 않고 재귀 `chmod`나 `chown`을 실행하지 않는다. 운영
소유자가 정확한 대상과 공동작업 정책을 확인한 뒤 권한을 교정해야 한다. 상태 확인 예시는
비밀값을 출력하지 않는 다음 명령으로 제한한다.

```bash
stat -c '%A %a %U:%G %n' . scripts scripts/sql config .env.local
find scripts config -maxdepth 2 -perm -0002 -print
```

### PostgreSQL

- 검토된 migration이 대상 DB에 먼저 적용돼 있어야 한다.
- loader role은 DB `CONNECT`, `public.firms` `SELECT`, `industrial_safety` `USAGE`, 필요한
  table DML과 sequence `USAGE` 권한을 가져야 한다.
- loader role과 migration role은 장기적으로 분리한다.
- `wg_bot`은 loader role로 사용하지 않는다.
- `PUBLIC`과 `wg_bot`에는 industrial base table/sequence 권한을 부여하지 않는다.
- migration 후 `create-bot-role.sh`를 다시 실행해 안전 view 두 개만 명시적으로 GRANT한다.
- `ALTER DEFAULT PRIVILEGES ... TO wg_bot`은 사용하지 않는다.

## 10. 운영 runbook

모든 명령은 `db` 디렉터리에서 실행한다. 예시에는 비밀번호나 접속 문자열을 넣지 않는다.

### 10.1 migration

```bash
npm run migrate
```

`drizzle-kit push`로 운영 스키마를 맞추지 않는다.

### 10.2 DB 비접속 원천 검증

```bash
./scripts/ingest-industrial-safety.sh --validate-only --scope cell-validation
./scripts/ingest-industrial-safety.sh --validate-only --scope existing-firms
```

`validate-only existing-firms`는 NPS 원천을 검증하지만 DB snapshot을 만들지 않는다. strict
518,806행 funnel은 rollback/apply 경로에서 확인한다.

### 10.3 test DB rollback 시험

```bash
./scripts/ingest-industrial-safety.sh \
  --rollback \
  --scope existing-firms \
  --env-file /path/to/.env.local \
  --database wageguard_is_test_existing_firms_01 \
  --sample-per-source 1000
```

test DB 이름은 `wageguard_is_test_*` 형식이어야 하며 migration과 canonical `public.firms`가
미리 준비돼 있어야 한다.

### 10.4 운영 축소 적재

셀 검증만 필요하면 다음을 실행한다.

```bash
./scripts/ingest-industrial-safety.sh \
  --apply \
  --scope cell-validation \
  --confirm-apply industrial_safety.v1.0 \
  --env-file /path/to/.env.local
```

firm 검증이 필요하면 다음 하나로 셀 데이터와 strict firm 결과를 함께 처리한다.

```bash
./scripts/ingest-industrial-safety.sh \
  --apply \
  --scope existing-firms \
  --confirm-apply industrial_safety.v1.0 \
  --env-file /path/to/.env.local
```

적재·검증 후 봇 권한을 다시 고정한다.

```bash
./scripts/create-bot-role.sh
```

### 10.5 full scope

다음 명령은 40 GiB DB floor, 10 GiB stage floor, 별도 test DB 실측과 운영 승인을 모두 받은
경우에만 사용한다.

```bash
./scripts/ingest-industrial-safety.sh \
  --apply \
  --scope full \
  --confirm-apply industrial_safety.v1.0 \
  --env-file /path/to/.env.local
```

이 명령도 전체 역사 backfill 승인을 의미하지 않는다.

## 11. acceptance gate

운영 current 전환 전 다음 조건이 모두 참이어야 한다.

- 고정 source bytes/SHA/행수 일치
- 셀 92,140행과 라벨 184,280행 계약 일치
- `public.firms` snapshot rows/bytes/SHA와 live table 양방향 일치
- strict funnel `518,806 + 1,329 + 382 + 29,041 = 549,558`
- verified source/target 1:1, PK/FK/unique 위반 0건
- `prediction_as_of < target_week_start` KST
- firm run metadata와 단일 target week CHECK 통과
- expected/loaded/실제 fact 행수 일치
- safe view가 unpublished/non-current run과 숨김 컬럼을 노출하지 않음
- `wg_bot`의 `industrial_safety` base table/sequence 권한 0건
- 동일 fingerprint 재실행이 물리 UPDATE 0건 no-op

한 항목이라도 실패하면 current를 전환하지 않고 전체 transaction을 rollback한다.
