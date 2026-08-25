# Path B 새 DB 재구축

Path B는 폐쇄된 운영 PostgreSQL을 복원하는 절차가 아니다. 검증된 정적 산출물과 현재
migration으로 **완전히 새로운 PostgreSQL 16 DB**를 만들고, 그 DB를 새로운 정본으로
승격하는 절차다.

`scripts/bootstrap-path-b.sh`는 DB를 만들거나 지우지 않는다. 실행 전에 호출자가 별도의 빈
DB를 준비해야 한다. DB에 relation, 사용자 extension, 별도 schema가 하나라도 있으면
migration 전에 중단한다.

## 입력 계약

- `extraction-report.json`
  - `status: validated`
  - `options.include_backfill: true`
  - PostgreSQL signature와 error가 없어야 한다.
  - 보고서에 기록된 모든 regular file의 크기와 SHA-256을 실행 직전에 다시 계산한다.
- source archive 승인 contract
  - `config/path_b_source_archive.v1.json`은 owner가 62GiB 원본을 끝까지 읽어 얻은 full-stream
    SHA-256과 extraction report digest로만 만든다. 값이 오기 전에 이름이나 hash를 추정해
    생성하지 않는다.
  - archive exact contract는 이름 `shared-SeD-full-20260814.tar.gz`, bytes `66,580,543,642`,
    수정시각 `2026-08-14T15:02:34.715Z`와 동일 Drive file ID/revision을 함께 결박한다.
- 임금체불 bundle
  - `model/door1_final_model.pkl`의 전체 SHA-256이 고정값과 같아야 한다.
  - `config/path_b_wage_batches.v1.json`의 순서대로
    `backfill/outputs_202512`부터 `outputs_202606`까지 정확히 7개를 적재한다.
  - 현재 `outputs/`는 `backfill/outputs_202606/`과 같은 2026-06 자료이므로 8번째 배치로
    적재하지 않는다.
- 산업재해
  - pinned registry와 별도로 받은 `v2`, `extension` root를 명시한다.
  - scope는 항상 `existing-firms`다. 이 bootstrap에는 `full` 선택지가 없다.
- canonical rebuild clock
  - tracked `config/path_b_canonical_timestamp.v1.json` 전체 SHA-256을 commit materialization에
    결박한다.
  - timestamp는 승인 archive 수정시각 `2026-08-14T15:02:34.715Z`이며 source는
    `approved_archive.modified_time`이다.
  - archive 이름과 bytes `66,580,543,642`도 source archive contract와 exact하게 같아야 한다.
  - Drive file ID `1s7r3zt6mEYqI0I89dgRR4EzUh6sn4PQG`와 revision
    `0B7g-BxntbHDzNXJMeGkvdzhrOWtpV1h0ZmFIN1kyRC9helIwPQ`도 exact하게 고정한다.
  - bootstrap의 `--canonical-timestamp`는 이 tracked contract와 정확히 같아야 한다.
- DB env
  - `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `PGSSLMODE`,
    `BOT_USER`, `BOT_PASSWORD`만 사용한다.
  - 대상 host는 loopback으로 제한한다. 서비스가 연결되지 않은 격리 DB에서 실행한다.
  - env 파일은 shell code로 source하지 않는다.

## 사전 준비

제어용 Python은 **CPython 3.12.13**, Node는 **22.23.2**, npm은 **10.9.8**로 고정한다.
DB 의존성은 lockfile로 먼저 설치한다.

```bash
cd db
npm ci

/restricted/path-b-cpython-3.12.13/bin/python3 -m venv \
  /restricted/path-b-industrial-venv
/restricted/path-b-industrial-venv/bin/pip install \
  -r requirements-industrial-safety-loader.txt
```

새 DB는 별도 관리 절차로 생성한다. 기존 운영 DB, 이전 복원 DB, migration이 일부 적용된
DB를 재사용하지 않는다. 실패한 bootstrap DB도 삭제 후 같은 DB를 수리하지 말고 **다른 빈
DB로 다시 시작**한다.

새 DB의 고정 계약은 PostgreSQL 16, `UTF8`, libc provider, `LC_COLLATE=C`,
`LC_CTYPE=C.UTF-8`이다. 예를 들어 관리 연결에서 다음과 같이 만든다. DB명과 owner는 실제
격리 환경의 검토된 식별자로 바꾼다.

```sql
CREATE DATABASE wageguard_path_b_20260826
  WITH OWNER = wageguard
       TEMPLATE = template0
       ENCODING = 'UTF8'
       LOCALE_PROVIDER = libc
       LC_COLLATE = 'C'
       LC_CTYPE = 'C.UTF-8';
```

생성 직후 서비스나 bootstrap을 연결하기 전에, 별도의 검토 세션에서 아래 두 원시 식별자를
기록한다. bootstrap은 실행 중 스스로 읽은 값만 신뢰하지 않고, 이때 기록한 값을
`--expected-system-identifier`와 `--expected-database-oid`로 다시 요구한다.

```sql
SELECT current_database() AS database_name,
       (SELECT oid FROM pg_catalog.pg_database
        WHERE datname = current_database()) AS database_oid,
       (SELECT system_identifier FROM pg_catalog.pg_control_system()) AS system_identifier;
```

## 실행

아래 경로는 예시다. 실제 추출 결과와 격리 DB env 경로를 인자로 전달한다.
`--report-dir`의 부모와 `--stage-parent`는 미리 만들고 해당 운영 계정만 쓸 수 있게 제한한다.
`--db-storage-target`은 PostgreSQL 데이터가 실제로 놓인 파일시스템을 가리켜야 한다. GCP VM
Docker bind mount는 `/srv/moneyworry`, 이 로컬 Colima 복원은 고정 값
`colima:/var/lib/docker`를 사용한다. 클라이언트 호스트의 `/` 여유 공간을 DB 용량으로
오인하지 않도록 생략할 수 없다.
bootstrap 시작 시 DB 파일시스템 여유 공간이 20GiB 미만이면 중단하고, 각 대형 적재 전에도
10GiB를 다시 확인한다. 임시 staging 파일시스템은 최소 4GiB가 필요하다.

Path B 정본 작업은 본체 스크립트를 `bash scripts/...`로 직접 실행하지 않는다. 반드시
`path-b-trusted-entry.sh`를 **실행 파일로 직접 호출**한다. 이 파일의 `env -i` shebang이
`BASH_ENV`, exported function, 호출자의 `PATH`, `LD_*`/`DYLD_*`, DB/BOT 환경변수를 target
Bash가 시작되기 전에 제거한다. launcher는 이어서 고정 `/bin/bash --noprofile --norc`를
실행하며, 환경에는 전용 `HOME`, `TMPDIR`, 고정 locale/timezone과 명시적으로 검토한 runtime
directory로 만든 `PATH`만 넣는다.

`--runtime-bin-dir`는 절대경로이며 root 또는 실행 사용자 소유이고 group/world-writable이
아니어야 한다. 전용 `HOME`과 `TMPDIR`는 symlink가 아닌 실행 사용자 소유 directory, 정확히
mode `0700`이어야 한다. 전용 `HOME`에는 `.gitconfig`, Git/NPM XDG config, `.npmrc`,
`.pypirc`를 두지 않는다. launcher도 이 파일들이 있으면 거부한다. macOS에서 Colima를 쓰면 Node 22·PG16 directory를
`/opt/homebrew/bin`보다 먼저 둬서 일반 Homebrew symlink가 고정 버전을 가리지 못하게 한다.
Linux에서는 검토된 Node directory와 `/usr/lib/postgresql/16/bin`을 명시한다.
`/usr/bin:/bin`은 launcher가 마지막에만 추가한다.

launcher 앞에 `bash`, `sh`, `env`를 붙이면 최초 `env -i` 경계를 우회하므로 금지한다. 고정
`/usr/bin/env`, `/bin/sh`, `/bin/bash`와 OS dynamic loader 자체는 신뢰 호스트의 일부다.

```bash
cd db

./scripts/path-b-trusted-entry.sh bootstrap \
  --runtime-bin-dir /restricted/path-b-cpython-3.12.13/bin \
  --runtime-bin-dir /opt/homebrew/opt/node@22/bin \
  --runtime-bin-dir /opt/homebrew/opt/postgresql@16/bin \
  --runtime-bin-dir /opt/homebrew/bin \
  --home-dir /restricted/path-b-runtime-home \
  --tmp-dir /restricted/path-b-runtime-tmp \
  -- \
  --env-file /restricted/path/path-b.env \
  --expected-database wageguard_path_b_20260826 \
  --expected-system-identifier REVIEWED_DECIMAL_SYSTEM_IDENTIFIER \
  --expected-database-oid REVIEWED_DECIMAL_DATABASE_OID \
  --canonical-timestamp 2026-08-14T15:02:34.715Z \
  --extraction-report /recovery/extraction-report.json \
  --wage-bundle /recovery/shared-SeD/hss/2nd_Side2026_Project/_service_bundle \
  --wage-manifest ./config/path_b_wage_batches.v1.json \
  --industrial-config ./config/industrial_safety_sources.v1.json \
  --industrial-v2-root /recovery/shared-SeD/shared/model/weekly_workplace_risk_v2_201512_202604 \
  --industrial-extension-root /recovery/shared-SeD/shared/model/weekly_workplace_risk_api_extension_v3_201512_202604 \
  --industrial-python /restricted/path-b-industrial-venv/bin/python \
  --stage-parent /restricted/path-b-stage \
  --db-storage-target /srv/moneyworry \
  --expected-git-commit REVIEWED_FULL_40_HEX_COMMIT \
  --report-dir /restricted/path-b-reports/rebuild-20260826-01 \
  --confirm PATH_B_REBUILD_FRESH_DATABASE_V1
```

확인 토큰이 없거나 다르면 artifact 검사도 시작하지 않는다. `--report-dir`가 이미 있으면
덮어쓰지 않는다.

## 고정 실행 순서

1. tracked canonical timestamp contract의 timestamp·archive·Drive revision·SHA-256을
   재검증한다.
2. 추출 보고서와 모든 추출 파일을 재검증한다.
3. 21개 임금체불 CSV의 행수를 DB 변경 전에 모두 계산한다.
4. 산업재해 pinned artifact를 `validate-only existing-firms`로 검사한다.
5. 대상이 빈 PostgreSQL 16인지 read-only catalog query로 확인한다.
6. 고정 commit에서 검증·결합한 migration 0000~0008을 동일 DB 세션의 identity guard 뒤에 한
   transaction으로 적용한다.
7. migration drift가 `aligned`, `9/9`인지 확인한다.
8. canonical timestamp를 모든 mutation에 전달해 2025-12~2026-06 임금체불 7개 배치를
   manifest 순서대로 적재한다.
9. 같은 timestamp로 산업재해 `existing-firms`를 적용한다.
10. 읽기 전용 bot role을 만든다.
11. `assert-path-b-rebuild.sql`과 migration drift를 다시 통과시킨다.
12. 한 번의 repeatable-read snapshot에서 모든 정본 테이블과 sequence 상태 fingerprint를 만든다.
13. exact gate, 추출 51개 파일, canonical clock, Git commit/tree/materialization, runtime 및
    원시 DB identity를
    portable provenance로 봉인한다.

최종 exact contract는 다음과 같다.

| 대상 | 기대값 |
| --- | ---: |
| `firms` | 639,137 |
| `batches` | 7 |
| `scored_active` | 3,855,848 |
| `inspector_queue` | 21,000 |
| `safe_recommendation` | 3,524,726 |
| 최신 2026-06 배치 | 553,598 / 3,000 / 503,887 |
| 산업재해 cell predictions | 92,140 |
| 산업재해 cell labels | 184,280 |
| 산업재해 strict firm results | 518,806 |
| `users/posts/comments/reviews` | 모두 0 |

산업재해 target week는 `2026-04-20`으로 오래됐다. DB 적재 성공은 신선도를 뜻하지 않는다.
제품은 새 run 전까지 반드시 `stale`로 표시하거나 현재 위험 카드에서 숨겨야 한다.

## 성공 이후

성공한 report에는 `STATUS=validated`, SQL assertion JSON, 두 번의 migration drift JSON과 각
적재 로그가 남는다. 이 시점에도 GCP 배포 정본이 완성된 것은 아니다.

1. 후보 bootstrap의 `bootstrap-content-fingerprint.json`을 검토하고 승인본을 repository의
   tracked file로 커밋한다. 모든 canonical 적재 timestamp가 승인된 고정값이어야 하며,
   임의의 `now()`를 포함한 fingerprint는 release 입력으로 승인하지 않는다.
2. 승인 파일을 포함한 commit에서 **또 다른 새 빈 DB**를 bootstrap한다. 첫 DB의 provenance를
   사후 교체하거나 그 DB를 계속 사용하지 않는다.
3. 두 번째 report의 `path-b-bootstrap.provenance.json` SHA-256을 release directory 밖에
   기록한다. export에는 이 digest, 동일 40-hex Git commit, tracked 승인 fingerprint 경로를
   모두 전달한다.
4. export가 출력한 `path_b_release.v1.2` manifest SHA-256도 별도 기록한다.
5. 별도의 빈 PostgreSQL 16 cluster/DB를 만들고 그 원시 system identifier와 database OID를
   별도 검토 세션에서 기록한다. restore에는 이 두 값과 manifest SHA-256을 필수로 전달한다.
6. 복원 exact contract, migration drift, content와 sequence state가 모두 source와 일치한
   신규 dump만 GCP DB 복원 입력으로 사용한다.

명령, stable-copy 경계와 보관할 증명 파일의 전체 목록은
[Path B 릴리스 게이트](PATH_B_RELEASE_GATE.md)를 따른다.

bootstrap은 기존 DB를 drop하거나 실패 상태를 자동 정리하지 않는다. 자동 정리는 잘못된
대상을 지울 위험이 더 크기 때문이다.
