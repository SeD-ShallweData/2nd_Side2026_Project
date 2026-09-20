# 드리프트 검사기 후조건 커버리지

> **한 줄 요약**
> `npm run check:migration-drift` 는 이제 **0006~0013, 0018 을 모두 검사한다.**
> 2026-09-09 에 0009·0010·0011 키 28개를 등록해 공백을 메웠고,
> 2026-09-13 에 0012 키 11개를 같은 PR 에서 등록했고,
> 2026-09-14 에 K5 현장 신고 분류·상태를 검증하는 0013 키 7개를 추가했고,
> 2026-09-19 에 0018 키 11개를 추가했다.
> `0000`~`0005` 는 여전히 후조건이 없다 — 그 구간은 [수동 검증](#수동-검증-절차) 범위 밖이다.

기록 시점: 2026-09-07 · **갱신 2026-09-19** · 대상 `db/scripts/check-migration-drift.mjs`,
`db/scripts/migration-drift-core.mjs`

## 검사기가 비교하는 세 가지

배포 전 게이트(`infra/scripts/deploy-from-git.sh` 가 마지막에 호출)는 다음을 대조한다.

| # | 비교 대상 | 자동 여부 |
| --- | --- | --- |
| 1 | 저장소의 migration 목록 (`migrations/meta/_journal.json`) | **모든 migration 자동** |
| 2 | DB 원장 `drizzle.__drizzle_migrations` 의 hash·created_at | **모든 migration 자동** |
| 3 | migration 이 만들기로 한 객체가 **실제로 DB 에 있는가** | ⚠ **손으로 적은 것만** |

1·2 는 파일 해시와 원장 행을 비교하므로 migration 을 추가해도 자동으로 따라온다.
3 은 다르다. "이 migration 이 끝나면 무엇이 존재해야 하는가"를 사람이
`POSTCONDITION_KEYS` 와 `POSTCONDITIONS_SQL` 에 적어야만 검사된다.

**원장은 "했다고 적어둔 메모"일 뿐 실제로 됐다는 증거가 아니다.**
3 번이 문을 열어 실물을 확인하는 단계다.

## 현재 커버리지

| migration | 3번 후조건 검사 | 비고 |
| --- | :---: | --- |
| `0000_init` ~ `0005_existing_firms_projection` | ✗ | 애초에 없었음. 메울 계획도 없다 |
| `0006_risk_tier` | ✓ | 7개 키 |
| `0007_current_batch_views` | ✓ | 7개 키 |
| `0008_deterministic_current_batch` | ✓ | 1개 키 |
| `0009_busy_puck` | ✓ | **16개 키** — sessions·reports·feedback, users.auth_role, v_posts 재정의, 0009 가 지운 것들의 부재 |
| `0010_crazy_talos` | ✓ | **7개 키** — worksite_tips, worksite_tip_attachments |
| `0011_lumpy_proteus` | ✓ | **5개 키** — 전부 부재 확인(users.role·firm_id 와 그 제약 3종) |
| `0012_v_region_industry_signal` | ✓ | **11개 키** — 뷰 + 집계 컬럼 7종 존재, 개별 사업장 값(firm_id·risk_full·rank) **부재** |
| `0013_illegal_sir_ram` | ✓ | **7개 키** — 현장 신고 category/status 컬럼·제약·기본값·정렬 인덱스 |
| `0018_real_hitman` | ✓ | **11개 키** — user_favorite_firms 테이블·컬럼·PK·FK(cascade)·인덱스 존재 확인 |

0012 에 부재 확인을 함께 넣은 이유: 이 뷰의 규격(N6)이 *"개별 기업 점수·순위
컬럼은 넣지 않음"* 이다. `CREATE OR REPLACE VIEW` 는 컬럼을 조용히 더할 수 있으므로,
존재 확인만으로는 **개별 사업장 값이 새어 나오는 변경**을 잡지 못한다.

> **부재 확인은 반드시 존재 확인과 함께 건다** (2026-09-13 정정).
> `NOT EXISTS` 만 쓰면 **뷰 자체가 없을 때도 참**이 되어, 아직 적용하지 않은
> migration 이 "부분 적용" 으로 보인다. 운영 DB 에서 실제로 0/11 이어야 할 것이
> 3/11 로 나왔고, 멀쩡한 DB 를 `partial_schema_application — DEPLOY BLOCKED` 로
> 읽게 만들었다. 후조건은 migration 이 **끝난 뒤의 상태**를 기술해야 한다.
> `db/tests/migration-drift.test.mjs` 가 이 형태를 고정한다.

**합계 72개 키** (61+11, 0012 이전 43개). 2026-09-09 에 PostgreSQL 16 에 migration 12개를 순서대로 적용한 뒤
`POSTCONDITIONS_SQL` 을 실행해 **43/43 통과**를 실측했다. 이어서 `users.role` 을 되살려
`column_absent:public.users.role` 이 `false` 로 뒤집히는 것까지 확인했다 — 검사가 실제로
드리프트를 잡는다는 뜻이다.

0013은 Drizzle snapshot·후조건 등록 무결성·API 저장 계약까지 로컬 검사를 통과했다. 현재 Windows
환경에는 실행 중인 PostgreSQL 16이 없으므로, 실제 migration 적용과 61/61 후조건 확인은 GCP 배포 전
복원 리허설 DB에서 수행한다.

`evaluatePostconditions()` 는 `POSTCONDITION_KEYS` 에 없는 tag 에 대해 `null` 을 반환하고,
호출부가 그 결과를 `.filter(Boolean)` 으로 버린다. 즉 **미등록 migration 은 조용히
검사에서 빠진다.** 실패하지 않고, 경고도 남기지 않는다.

## 이 공백이 실제로 문제가 되는 상황

평상시에는 문제없다. 아래 세 경우에만 위험하다.

1. **덤프에서 복원한 뒤.** `infra/OPERATIONS.md` 의 롤백 절차는 `pg_restore` 를 쓴다.
   복원이 부분적으로만 성공하면 원장은 그대로인데 객체가 없을 수 있다.
   3번이 없으면 검사기는 `aligned` 를 반환하고, 앱이 런타임에 "그런 테이블 없다"로 죽는다.
2. **migration 이 중간에 실패했을 때.** 0009 는 `DROP VIEW v_posts` 후 재생성하고 권한을
   재부여한다. 반쯤 적용되면 `wg_bot` 이 SELECT 권한을 잃는다.
3. **누가 손으로 객체를 지웠을 때.**

과거에 같은 종류의 사고가 실제로 있었다. 운영 DB 가 원장에는 0000~0005 만 있는데
0006·0007 의 객체는 존재하는 `schema_ahead_of_ledger` 상태였고,
**그것을 잡아낸 것이 바로 0006·0007 에 후조건이 적혀 있었기 때문이다.**
0009·0010 에는 그 안전망이 없다.

## 수동 검증 절차

위 세 상황 중 하나를 겪은 뒤에는 아래를 **반드시** 돌린다. 읽기 전용이라 언제 돌려도 안전하다.

```bash
# VM, root
bash -c 'set -a; . /etc/moneyworry/db.env; set +a;
  PGPASSWORD="$DB_PASSWORD" psql -h 127.0.0.1 -p "${DB_PORT:-5433}" \
    -U "$DB_USER" -d "$DB_NAME" -X -q \
    -f /srv/moneyworry/repo/db/scripts/sql/verify-uncovered-postconditions.sql'
```

**기대: 23개 행이 전부 `t`.** `f` 가 하나라도 있으면 그 객체가 DB 에 없다는 뜻이므로
**배포하지 말고** `infra/OPERATIONS.md` 와 `db/docs/MIGRATION_OPERATIONS.md` 절차에 따라
복구를 먼저 한다.

`npm run check:migration-drift` 가 `aligned` 라고 해도 이 검증을 대신하지 않는다.
둘은 서로 다른 것을 본다.

## 나중에 공백을 메우려면

migration 을 더 추가하게 되면 그때 함께 하는 편이 싸다. 순서가 중요하다.

1. **먼저 라이브 DB 에서 검증한다.** `verify-uncovered-postconditions.sql` 을 돌려
   후보 키가 전부 `t` 인지 확인한다.
   → 이 단계를 건너뛰면 안 되는 이유: `evaluatePostconditions` 는 **이미 적용된**
   migration 의 후조건도 검사하고, 하나라도 false 면 `applied_schema_mismatch` →
   `DEPLOY BLOCKED` 가 된다. **키를 하나 잘못 쓰면 그 순간부터 모든 배포가 막힌다.**
2. `db/scripts/migration-drift-core.mjs` 의 `POSTCONDITION_KEYS` 에 tag 와 키 목록 추가.
3. `db/scripts/check-migration-drift.mjs` 의 `POSTCONDITIONS_SQL` 에 같은 키로
   `json_build_object(...)` 추가. **키 문자열이 2 번과 한 글자도 달라선 안 된다.**
4. `db/tests/migration-drift.test.mjs` 의 `migrations()` 태그 배열과 기본 count 갱신.
5. `cd db && npm ci && npm run test:migration-drift` 통과 확인.
6. PR → CI 가 빈 PG16 에 전체 migration 을 적용하고 새 후조건까지 검증한다.

좋은 후조건 키의 조건: **그 migration 이 적용된 뒤에만 참이고, 이후로도 계속 참**일 것.
삭제한 객체는 `..._absent:` 로 부재를 확인해 재적용 흔적을 잡는다.

## 왜 지금 미뤘는가 (2026-09-07 결정)

- 현재 DB 는 정상이다. 검사기가 `aligned` 11/11 을 보고했고, 원장 해시가 디스크
  파일과 전부 일치하는 것을 손으로 대조했다.
- 0009·0010 은 이미 적용됐고 추가로 손댈 계획이 없다.
- 스케줄 만료(2026-11-23)까지 남은 기간이 짧아, 새 migration 이 생기지 않는다면
  실익이 작다.
- 대신 이 문서와 `verify-uncovered-postconditions.sql` 로 **공백을 명시하고
  수동 대체 수단을 남긴다.**

이 결정은 "migration 을 더 만들지 않는다"는 전제 위에 있다.
**`0011` 을 만드는 순간 이 전제는 깨지므로, 그때 위 절차를 함께 수행한다.**

## 관련 문서

- [`infra/OPERATIONS.md`](../../infra/OPERATIONS.md) — 배포·롤백 순서, "배포와 migration 은 분리한다"
- [`db/docs/MIGRATION_OPERATIONS.md`](MIGRATION_OPERATIONS.md) — 원장 복구 절차
- [`infra/scripts/deploy-from-git.sh`](../../infra/scripts/deploy-from-git.sh) — 배포 마지막에 드리프트를 보고만 하고 migrate 는 하지 않는다

## 2026-09-08 추가
- 2026-09-08 결정으로 0011(users.role 컬럼 삭제)을 만들기로 함. 위 전제("migration을 더 만들지 않는다")는 깨졌으므로 0011 PR에서 "나중에 공백을 메우려면" 절차를 함께 수행한다.
- 서버 실측 2026-09-07(UTC): `verify-uncovered-postconditions.sql` 23/23 `t`, `f` 0건.


## 2026-09-09 추가 — 공백을 메웠다

0011 이 PR #40 으로 병합되면서 `db/docs/DRIFT_CHECK_COVERAGE.md` 가 예고한 "0011 을 만드는
순간 절차를 함께 수행한다"가 지켜지지 않았다. 뒤늦게 0009·0010·0011 을 한꺼번에 등록했다.

같은 일이 반복되지 않도록 `db/tests/migration-drift.test.mjs` 에 검사 두 개를 넣었다.

| 검사 | 무엇을 막나 |
| --- | --- |
| `POSTCONDITION_KEYS와 POSTCONDITIONS_SQL의 키가 정확히 같다` | 한쪽에만 키를 적어 검사가 조용히 통과하거나 모든 배포가 막히는 것 |
| `journal의 모든 migration이 등록 여부를 명시적으로 갖는다` | 0006 이후 migration 을 후조건 없이 추가하는 것. **CI 가 실패한다** |

`verify-uncovered-postconditions.sql` 은 남겨 둔다. 검사기를 못 돌리는 상황(원장 자체가
깨졌거나 node 를 쓸 수 없을 때)에서 psql 만으로 확인하는 수단으로 여전히 쓸모가 있다.
다만 이제 그 SQL 의 23개는 검사기가 자동으로 보는 것과 같은 내용이다.

## 2026-09-19 추가 — 0018 등록

0018(`user_favorite_firms` 즐겨찾기 테이블)를 만들면서 이번에는 "나중에 공백을 메우려면"
절차를 미루지 않고 같은 PR 에서 함께 수행했다.

1. 후보 키 11개(테이블 존재, `user_id`/`firm_id`/`created_at` 컬럼 존재, 복합 PK
   `(user_id, firm_id)` 존재, `users`·`firms` 로의 FK 존재, 두 FK 모두
   `ON DELETE CASCADE` 로 정의됐는지, `user_favorite_firms_user_created_idx`
   인덱스 존재)를 먼저 로컬 Docker DB(`wageguard-nayeon-db-1`)에서 raw SQL 로
   직접 실행해 **11/11 `true`** 를 확인했다.
2. FK 존재만 보고 끝내지 않고 `constraint_definition:` 키로 `ON DELETE CASCADE`
   여부까지 검사한다 — 0013 이 체크 제약 내용을 검증한 것과 같은 이유다.
   FK 이름만 맞고 삭제 동작이 `NO ACTION` 으로 잘못 만들어져도 `constraint:`
   존재 확인만으로는 못 잡는다.
3. `db/scripts/migration-drift-core.mjs` 의 `POSTCONDITION_KEYS` 와
   `db/scripts/check-migration-drift.mjs` 의 `POSTCONDITIONS_SQL` 에 같은 11개
   키를 등록했다.
4. `cd db && npm run test:migration-drift` — 12개 테스트 전부 통과. 그중
   `POSTCONDITION_KEYS와 POSTCONDITIONS_SQL의 키가 정확히 같다`,
   `journal의 모든 migration이 등록 여부를 명시적으로 갖는다` 가 0018 키 누락·
   불일치를 잡는 안전망 역할을 했다.

현재 Windows 로컬 환경에서는 `npm run check:migration-drift` 자체가 `spawnSync
psql ENOENT` 로 실패한다 — `npm run` 이 Windows `cmd.exe` 로 스크립트를 실행하는데
그 안에서 Node 의 `spawnSync('psql', …)` 가 `psql` 대역 bash wrapper(확장자 없는
shebang 스크립트)를 찾지 못하기 때문이다. 이번 후조건 내용과는 무관한 기존 환경
제약이며, 위 1번의 raw SQL 실행과 유닛 테스트로 실질적인 검증은 마쳤다.

## 2026-09-20 추가 — main 과 병합하며 0014 → 0018 로 재번호

`task/favorite-firms` 브랜치가 갈라진 뒤 main 에 대화 메모리 기능(0014~0017,
`0014_conversation_memory` 등 4개)이 먼저 병합되면서 이 브랜치의 `0014_real_hitman`
과 번호가 겹쳤다. 병합 시 `0014_real_hitman` 을 `0018_real_hitman` 으로 재번호하고
(`.sql`·`meta/00XX_snapshot.json`·`_journal.json`·`POSTCONDITION_KEYS`·
`POSTCONDITIONS_SQL` 모두), main 의 0014~0017 후조건 블록 뒤로 재배치했다.
`npm run test:migration-drift` 12개 전부 통과로 확인했다.

참고: main 의 0014~0017 은 `meta/00XX_snapshot.json` 을 남기지 않았다(수작업 SQL
작성 방식). 이 문서의 "현재 커버리지" 표는 그 네 migration 을 아직 싣지 않았는데,
이번 병합의 범위 밖이라 손대지 않았다 — 실제 후조건 등록은
`db/scripts/migration-drift-core.mjs`/`check-migration-drift.mjs` 에 이미 있다.
