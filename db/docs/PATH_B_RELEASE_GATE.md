# Path B release dump·독립 복원 게이트

이 절차는 검토·승인한 content fingerprint를 tracked file로 포함하는 commit에서
`bootstrap-path-b.sh`를 **새 빈 DB에 다시 실행**하고 `STATUS=validated`로 끝난 뒤 수행한다.
목적은 bootstrap DB 자체를 배포하는 것이 아니라, provenance에 결박된 custom-format
archive를 만들고 **별도의 빈 PostgreSQL 16 DB에 실제로 복원 가능한지** 증명하는 것이다.

두 스크립트 모두 DB를 생성·삭제·비우지 않는다. DB 생성은 별도 관리 절차로 수행하고,
인자로 선택한 DB가 틀리거나 비어 있지 않으면 중단한다. 실패한 복원 DB를 스크립트가
정리하지도 않는다. 실패 DB는 배포 후보에서 제외하고 다른 빈 DB로 다시 검증한다.

## PG16 클라이언트가 필수인 이유

archive를 만드는 `pg_dump`와 검증하는 `pg_restore`의 client major는 **둘 다 정확히 16**이어야
한다. 제어용 Python도 **CPython 3.12.13**이어야 한다. 예를 들어 호스트 기본 libpq가
18.6이면 그 바이너리로 archive를 만들지 않는다.
`pg_dump 18` archive가 배포 VM의 `pg_restore 16`에서 역호환된다고 보장할 수 없기 때문이다.

전용 바이너리는 호출자의 `PATH`에 넣지 않는다. 아래의 trusted launcher에 검토된 CPython,
Node, PG16 runtime directory로 명시한다. launcher가 이 directory 뒤에 `/usr/bin:/bin`만
추가하여 target 프로세스의 `PATH`를 새로 만든다.

```bash
/opt/homebrew/opt/postgresql@16/bin/pg_dump --version
/opt/homebrew/opt/postgresql@16/bin/pg_restore --version
# 둘 다 반드시 16.x
```

또는 `postgres:16-alpine`/PG16 컨테이너의 바이너리를 호출하는 전용 wrapper를 PATH에 둔다.
스크립트는 버전 문자열을 검사하고 major가 16이 아니면 DB 작업 전에 실패한다.

## 비밀·권한 경계

- source와 target은 각각 `--source-env`, `--target-env`로 **명시**한다.
- env 파일은 shell로 실행하지 않고 다음 키만 읽는다.
  `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `PGSSLMODE`, `BOT_USER`,
  target의 `BOT_PASSWORD`.
- env 파일은 symlink가 아니어야 하고, 실행 UID가 소유하며, mode가 정확히 `0600`이어야 한다.
- 비밀번호는 명령행, dump metadata, checksum, 검증 보고서에 기록하지 않는다.
- bot 비밀번호도 psql 인자가 아니라 프로세스 환경과 psql `\getenv`로 전달한다.
- release/report 디렉터리는 새 경로만 허용하고 mode `0700`, 내부 파일은 private
  `0600` 또는 검증 후 read-only `0400`/`0500`으로 만든다.
- release manifest에는 source system identifier와 database OID를 원문으로 남기지 않고 그
  identity SHA-256만 남긴다. target의 원시 system identifier와 database OID는 별도 검토
  세션에서 기록해 restore 인자로 전달하며, restore 증명에는 그 검토값이 남는다.
- source와 target의 cluster fingerprint가 같으면 DB 이름이 달라도 복원 전에 거부한다.
- source와 target의 database fingerprint도 같을 수 없다.
- confirmed export/restore는 `path-b-trusted-entry.sh`를 실행 파일로 직접 호출해야 한다.
  launcher의 `env -i` shebang이 target Bash 시작 전에 `BASH_ENV`, exported function, 상속
  `PATH`, loader 변수와 DB/BOT 환경변수를 제거한다. launcher 앞에 `bash`, `sh`, `env`를
  붙이지 않는다.
- launcher의 `--runtime-bin-dir`는 root/실행 사용자 소유이며 group/world-writable이 아닌
  절대경로여야 한다. 전용 `--home-dir`, `--tmp-dir`는 symlink가 아닌 mode `0700` private
  directory여야 하고, 전용 home에 Git/NPM/Python startup config가 있으면 거부한다.
  고정 `/usr/bin/env`, `/bin/sh`, `/bin/bash`와 OS loader는 신뢰
  호스트의 일부다.

identity 확인에는 `pg_control_system()` 조회 권한이 필요하다. source dump 계정과 target
restore 계정은 격리된 검증 환경의 관리자 계정을 사용한다. source와 target은 반드시 서로
다른 PG16 cluster/인스턴스여야 한다. 같은 cluster의 다른 DB는 독립 복원 증거로 인정하지
않는다.

## 1. 승인 fingerprint와 bootstrap 증명 준비

export는 승인 행위 자체를 수행하지 않는다. `--approved-content-fingerprint`는 다음 조건을
모두 만족해야 한다.

- contract가 `path_b_content_fingerprint.v1.2`인 일반 파일
- `--expected-git-commit`의 repository materialization에 같은 상대경로·byte 수·SHA-256으로
  기록된 tracked file
- bootstrap report의 `bootstrap-content-fingerprint.json`과 byte-exact하게 동일

Path B canonical 적재 timestamp도 tracked
`db/config/path_b_canonical_timestamp.v1.json`의 승인된 고정값이어야 한다. 현재 계약은
`2026-08-14T15:02:34.715Z`, source `approved_archive.modified_time`, archive bytes
`66,580,543,642`, Drive file ID
`1s7r3zt6mEYqI0I89dgRR4EzUh6sn4PQG`, revision
`0B7g-BxntbHDzNXJMeGkvdzhrOWtpV1h0ZmFIN1kyRC9helIwPQ`다. export는 bootstrap provenance v1.1,
packaged canonical contract, packaged source archive v1.1 contract와 repository
materialization의 path·bytes·SHA-256을 모두 대조하고, archive name/bytes/modified time과
Drive file ID/revision도 세 증명에서 exact하게 비교한다. 임의의 `now()`가 fingerprint에
들어가면 승인 commit으로 새 DB를 다시 만들었을 때
같은 bytes를 재현할 수 없으므로 거부한다. 후보 DB의 fingerprint를 검토해 repository에 승인
파일로 커밋한 뒤에는, 그 새 commit을 사용해 **또 다른 빈 DB에서 bootstrap을 처음부터 다시
실행**해야 한다. 같은 DB의 provenance만 사후 교체해서는 안 된다.

bootstrap 성공 직후 report를 수정하거나 재생성하지 말고 provenance SHA-256을 별도 채널에
기록한다.

```bash
shasum -a 256 \
  /restricted/path-b-reports/rebuild-20260826-02/path-b-bootstrap.provenance.json
# 출력의 64-hex를 RELEASE_REVIEWED_BOOTSTRAP_PROVENANCE_SHA256로 별도 보관
```

## 2. source exact 검증 후 release archive 생성

source env 예시:

```dotenv
DB_HOST=127.0.0.1
DB_PORT=5433
DB_NAME=wageguard_path_b_20260826
DB_USER=wageguard
DB_PASSWORD=<restricted-secret>
PGSSLMODE=disable
BOT_USER=wg_bot
```

실행:

```bash
cd db

./scripts/path-b-trusted-entry.sh export \
  --runtime-bin-dir /restricted/path-b-cpython-3.12.13/bin \
  --runtime-bin-dir /opt/homebrew/opt/node@22/bin \
  --runtime-bin-dir /opt/homebrew/opt/postgresql@16/bin \
  --home-dir /restricted/path-b-runtime-home \
  --tmp-dir /restricted/path-b-runtime-tmp \
  -- \
  --source-env /restricted/path-b-source.env \
  --expected-source-database wageguard_path_b_20260826 \
  --bootstrap-report /restricted/path-b-reports/rebuild-20260826-02 \
  --expected-bootstrap-provenance-sha256 RELEASE_REVIEWED_BOOTSTRAP_PROVENANCE_SHA256 \
  --expected-git-commit REVIEWED_FULL_40_HEX_COMMIT \
  --approved-content-fingerprint ./config/REVIEWED_PATH_B_CONTENT_FINGERPRINT.json \
  --output-dir /restricted/releases/path-b-20260826-01 \
  --confirm PATH_B_RELEASE_EXPORT_PG16_V1
```

고정 순서는 다음과 같다.

1. DB env를 읽거나 DB에 접속하기 전에 bootstrap `STATUS`, provenance, repository
   materialization, source archive/extraction 증명, 네 bootstrap gate와 승인 fingerprint를
   `O_NOFOLLOW`/`fstat` stable-copy하고 모든 참조 SHA-256을 검증한다.
2. 승인 fingerprint의 정확한 repository 상대경로와 SHA-256이 materialization record와
   일치하고 bootstrap fingerprint와 byte-exact한지 확인한다.
3. source PostgreSQL major와 원시 identity를 읽고 anchored bootstrap identity와 exact하게
   일치하는지 확인한다.
4. `assert-path-b-rebuild.sql` exact assertion과 migration drift `aligned`, `9/9`를 확인한다.
5. 쓰기 세션이 없는지 확인한 뒤 PG16 `REPEATABLE READ READ ONLY` keeper transaction에서
   `pg_export_snapshot()`을 호출한다.
6. 그 **동일 snapshot**으로 content fingerprint를 만들고
   `pg_dump --format=custom --no-owner --no-acl --snapshot=...`를 실행한다.
7. keeper 종료 후 content·sequence와 cluster/database identity가 export window 동안
   바뀌지 않았는지 다시 확인한다.
8. archive magic·byte length·SHA-256과 bootstrap/source gate 전부를 포함한
   `path_b_release.v1.2` manifest를 만든다.

release 출력 파일시스템은 최소 10GiB 여유 공간이 있어야 한다.

source assertion은 임금체불 7개 배치와 산업재해 existing-firms 정본을 exact하게 검사한다.
산업재해 기대값은 runs 3, dependencies 1, cell predictions 92,140, label datasets 2,
cell labels 184,280, firm results 및 LLM view 각각 515,608이며 full-scope table은 모두 0이다.

성공한 release 디렉터리:

```text
STATUS                              # validated
path-b-release.dump                 # PG16 custom archive
path-b-release.dump.sha256
path-b-release.metadata.json        # path_b_release.v1.2 manifest
approved-content-fingerprint.json
bootstrap-STATUS
bootstrap-canonical-timestamp-contract.json
bootstrap-provenance.json
bootstrap-repository-materialization.json
bootstrap-proof-validation.json
bootstrap-source-archive-contract.json
bootstrap-source-extraction-report.json
bootstrap-content-fingerprint.json
bootstrap-exact-assertion.json
bootstrap-migration-drift.json
bootstrap-extraction-verification.json
export-code-validation.json
source-content-fingerprint.json
source-path-b-assertion.json
source-migration-drift.json
```

`STATUS`가 `validated`가 아니면 archive 크기가 커 보여도 복원 입력으로 사용하지 않는다.
export stdout의 `Path B release manifest SHA256 (record out of band): ...` 64-hex도 release
directory와 분리된 승인 기록에 보관한다. restore는 이 값을 필수로 요구한다.

## 3. 이미 존재하는 빈 target에 복원하고 다시 exact 검증

target env에는 새 bot 비밀번호까지 넣는다.

```dotenv
DB_HOST=127.0.0.1
DB_PORT=5543
DB_NAME=wageguard_path_b_restorecheck_20260826
DB_USER=restore_admin
DB_PASSWORD=<restricted-target-secret>
PGSSLMODE=disable
BOT_USER=wg_bot_restorecheck
BOT_PASSWORD=<new-restricted-bot-secret>
```

target DB는 별도 절차로 미리 만든다. PostgreSQL 16 primary여야 하며 사용자 extension,
schema, public relation/routine/type가 없는 상태여야 한다.

서비스나 restore를 연결하기 전에 별도의 검토 세션에서 target 원시 identity를 기록한다.

```sql
SELECT current_database() AS database_name,
       (SELECT oid FROM pg_catalog.pg_database
        WHERE datname = current_database()) AS database_oid,
       (SELECT system_identifier FROM pg_catalog.pg_control_system()) AS system_identifier;
```

```bash
./scripts/path-b-trusted-entry.sh restore \
  --runtime-bin-dir /restricted/path-b-cpython-3.12.13/bin \
  --runtime-bin-dir /opt/homebrew/opt/node@22/bin \
  --runtime-bin-dir /opt/homebrew/opt/postgresql@16/bin \
  --home-dir /restricted/path-b-runtime-home \
  --tmp-dir /restricted/path-b-runtime-tmp \
  -- \
  --release-dir /restricted/releases/path-b-20260826-01 \
  --expected-release-manifest-sha256 RELEASE_REVIEWED_MANIFEST_SHA256 \
  --target-env /restricted/path-b-restore-target.env \
  --expected-target-database wageguard_path_b_restorecheck_20260826 \
  --expected-target-system-identifier REVIEWED_DECIMAL_SYSTEM_IDENTIFIER \
  --expected-target-database-oid REVIEWED_DECIMAL_DATABASE_OID \
  --db-storage-target /srv/moneyworry \
  --report-dir /restricted/releases/path-b-20260826-01-restore-proof \
  --confirm PATH_B_RELEASE_RESTORE_EMPTY_PG16_V1
```

고정 순서는 다음과 같다.

1. env secret을 읽거나 DB에 접속하기 전에 out-of-band manifest SHA-256을 확인하고 manifest와
   정확한 18개 package input을 private `release-inputs`로 `O_NOFOLLOW`/`fstat` stable-copy한다.
   이 시점 뒤에는 원래 release directory를 다시 열지 않는다.
2. v1.2 manifest, bootstrap provenance/materialization, source archive/extraction 증명, 모든
   bootstrap/source gate와 custom archive SHA/bytes 계약을 staged copy에서 검증한다.
3. bootstrap materialization에 결박된 현재 critical restore code를 private
   `verified-repository`로 stable-copy하고 이후 SQL/common/fingerprint는 그 copy만 사용한다.
4. target PG16 원시 identity가 별도 기록값과 일치하는지 확인하고 source와 같은 cluster/DB를
   거부한 뒤 empty assertion과 storage gate를 통과시킨다.
5. restore 직전 target identity를 다시 확인한다. materialization에 결박된 session guard를
   같은 `psql` 세션의 첫 SQL로 실행하고, `pg_restore --file=- --single-transaction` SQL을 그
   세션으로 stream한다.
6. restore 직후 identity를 재확인하고 target 전용 읽기 bot role과 최소 SELECT grant를
   재구성·실로그인 검증한다.
7. 복원 DB에서 `assert-path-b-rebuild.sql`, migration drift `aligned`/`9/9`, v1.2 content와
   8개 sequence state의 source byte-exact 일치를 확인한다.
8. 마지막으로 target identity와 검증 중 critical code 불변을 다시 확인한다.

dump는 owner/ACL을 의도적으로 포함하지 않으므로 bot role·grant는 target env의 새 비밀번호로
복원 뒤 재구성한다. role 설정도 하나의 transaction에서 적용한다. 비밀번호 값은 보고서에
들어가지 않는다.

성공 보고서의 `STATUS=validated`, `release-input-validation.json`,
`verified-restore-code.json`, `restored-path-b-assertion.json`,
`restored-migration-drift.json`, `restored-content-fingerprint.json`,
`restore-verification.metadata.json`을 함께 보관한다. 이 증명과 별도 기록한 manifest SHA-256이
모두 있어야 archive를 GCP 복원 후보로 승격한다.

## 정적 검증

실제 DB를 dump하지 않고 스크립트 문법·fail-closed 경계·가짜 PG16 도구 호출을 검사한다.

```bash
/bin/sh -n scripts/path-b-trusted-entry.sh
/bin/bash -n scripts/export-path-b-release.sh
/bin/bash -n scripts/verify-path-b-release-restore.sh
node --test tests/path-b-bootstrap-static.test.mjs tests/path-b-release-gate-static.test.mjs
```
