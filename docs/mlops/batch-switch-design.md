# ML 배치 전환 · 결과 비교 화면 설계서

| 항목 | 값 |
| --- | --- |
| 작성 | 2026-09-02 · 조윤빈 |
| 대상 | `SeD-ShallweData/2nd_Side2026_Project` `main` @ `fcbc948` (PR #19·#20 반영) |
| 검증 방식 | 저장소 코드·마이그레이션·CI·infra 스크립트를 직접 읽어 확인. 추정은 **[추정]** 으로 표시 |
| 검토자 | 한승석(ML·DB) · 권나연(migration·롤) · 정민규(인증) · 심수현(프론트) |
| 관련 문서 | `ML-DB-데이터계약.md`(승석 검토 중) · `docs/data-contract/wage-risk.md` · `db/docs/MIGRATION_OPERATIONS.md` |

> 용어는 처음 나올 때 괄호로 뜻을 적었다. 괄호 안은 음슴체다.

---

## 0. 한 장 요약

**무엇을 만드나.** ML이 만든 결과(배치)를 ① 화면에서 확인하고 ② 두 배치를 비교하고 ③ 필요하면 어느 배치를 서비스할지 고르는 기능이다.

**왜 만드나.** 지금은 새 배치를 적재하면 **즉시 서비스에 반영되고 되돌릴 수단이 없다.** 무엇이 서비스 중인지도 DB에 직접 붙어야 안다. ML 결과를 "보여주는 것"에서 "다루는 것"으로 넘어가는 마지막 조각이다.

**핵심 발견 3가지.**

| # | 발견 | 의미 |
| --- | --- | --- |
| 1 | 최신 배치 선택 규칙이 **TS 상수 1개 + DB 뷰 1개**에 있고, 규칙 문자열을 **CI 테스트와 drift 검사가 문자 그대로 단언**한다 | 규칙의 `ORDER BY`는 바꾸면 안 되고 `WHERE`만 넓혀야 한다 |
| 2 | `health/ready`가 **2026-06 배치의 행수(553,598)에 하드코딩**돼 있고 배포 스크립트가 이 응답을 기다린다 | **이 설계와 무관하게** 승석이 다음 달 배치를 넣으면 배포가 실패한다. 먼저 고쳐야 한다 |
| 3 | 팀의 보안 계약이 **웹 프로세스에 쓰기 자격증명 보유를 금지**한다(검증기+테스트로 강제) | "화면에서 전환" 버튼은 **정책 변경 합의**가 필요하다. 그 전에는 CLI 전환으로 같은 효과를 낸다 |

**단계.**

```text
Phase 0  선행 정비        readiness 하드코딩 제거 · 규칙 사용처 5곳 통일     ← 배치 추가 전 필수
Phase 1  현황 화면        읽기 전용 · migration/롤/권한 변경 없음            ← 이번 주 가능
Phase 1.5 비교 화면       읽기 전용 · 기존 테이블만으로 지표 산출             ← Phase 1 + 1주
Phase 2a 전환 (CLI)       migration 0010 + wg_ops + 스크립트               ← 나연 작업 후
Phase 2b 전환 (화면)      2a + env 정책 변경 + 실인증 RBAC                  ← 팀 합의 후
```

---

## 1. 목적과 범위

### 1.1 해결하려는 문제

| # | 문제 | 지금 어떻게 되나 (검증됨) |
| --- | --- | --- |
| P1 | 롤백 수단 부재 | 같은 `(as_of_date, model_version)`을 다시 적재하는 것만이 방법. 232MB CSV 재적재 |
| P2 | 서비스 중인 배치를 화면에서 모름 | `batches` 테이블을 psql로 봐야 함 |
| P3 | 모델 비교 불가 | 두 버전을 적재해도 비교 수단 없음 |
| P4 | 새 배치가 **즉시** 서비스됨 | 같은 기준월에 새 모델 버전을 적재하면 `ingested_at`이 늦은 쪽이 바로 서비스됨. 검토 기회 없음 |
| P5 | 담당자 1인 병목 | 위 전부가 DB 접속 권한을 가진 사람만 할 수 있음 |

### 1.2 범위 밖

- 원천 데이터 수집 자동화, 모델 재학습 자동화 → 별도 (이번 설계는 **"이미 만들어진 결과를 서비스로 넘기는 구간"** 만 다룬다)
- 화면에서 모델 파라미터 변경 → 하지 않는다. 모델은 ML 엔지니어의 산출물이고, 화면은 **선택·검증·전환**만 한다
- 구직자 화면 변경 → 없음. 이 화면은 운영자·감독관용이다

---

## 2. 현재 구현 상태 (검증 결과)

### 2.1 데이터

| 항목 | 값 | 확인 위치 |
| --- | --- | --- |
| 배치 수 | 7 (`as_of` 2025-12 ~ 2026-06, 매월) | `db/config/path_b_wage_batches.v1.json` |
| 모델 | 단일 `door1-voting-39f-v1`, sha `cbe5d951…` | 같은 파일 |
| 행수 합계 | scored 3,855,848 · queue 21,000 · safe 3,524,726 | 같은 파일 |
| 사업장 수 | 639,137 | 같은 파일 |
| 최신 배치 | `as_of 2026-06` → `target 2026-12`, scored 553,598 | `postgres.ts:61-90`, 계약 문서 |
| `batches` 컬럼 | `id, as_of_date, target_month, model_version, model_sha, ingested_at, source, n_scored, n_queue, n_safe` | `db/schema.ts:86-` |
| 활성 플래그 | **없음** — 정렬 규칙으로 암묵 결정 | 동일 |
| `ingested_at` | `now()`가 아니라 **`--canonical-timestamp` 인자값** | `ingest.sh:101,314` |

### 2.2 "최신 배치" 규칙이 사는 곳 — **5곳**

| # | 위치 | 형태 |
| --- | --- | --- |
| 1 | `product/src/server/latestBatchSql.ts` | TS 상수 `LATEST_BATCH_ORDER_SQL` |
| 2 | ↳ `adapters/real/RealCompanyRepository.ts:122` | 상수 사용 |
| 3 | ↳ `adapters/real/MlRiskProvider.ts:286` | 상수 사용 |
| 4 | ↳ `services/inspectorService.ts:161, 304` | 상수 사용 (2회) |
| 5 | **`product/src/server/postgres.ts:61-90`** `isDatabaseReady()` | **상수를 안 쓰고 같은 SQL을 손으로 적음** |
| DB | `db/migrations/0008` `v_current_batch` 뷰 | 같은 규칙. **앱은 이 뷰를 쓰지 않음** (검증: TS에서 `v_current_` 참조 0건) |

규칙 본문 (TS·DB 동일):

```sql
WHERE as_of_date IS NOT NULL
ORDER BY as_of_date DESC, ingested_at DESC, id DESC
LIMIT 1
```

### 2.3 이 규칙을 문자 그대로 단언하는 곳 — **3곳**

| 위치 | 단언 내용 | 영향 |
| --- | --- | --- |
| `services/latestBatchSelection.test.ts` | SQL에 `"ORDER BY as_of_date DESC, ingested_at DESC, id DESC LIMIT 1"` 포함 + `"WHERE as_of_date IS NOT NULL"` 포함 | ORDER BY 앞에 무엇을 끼우면 **테스트 실패** |
| `db/scripts/check-migration-drift.mjs:301` | `v_current_batch` 뷰 정의가 정규식 `ORDER BY as_of_date DESC, ingested_at DESC, id DESC`와 일치 (0008 후조건) | 뷰의 ORDER BY를 바꾸면 **drift = 불일치 → 배포 중단** |
| `.github/workflows/ci.yml:62-63` | 빈 PG16에 전체 migration 적용 후 `check:migration-drift` | 위 두 조건이 **CI에서 강제됨** |

### 2.4 DB 접근 권한

| 롤 | 성격 | 권한 | 확인 |
| --- | --- | --- | --- |
| `wg_bot` | 앱 전용 | `default_transaction_read_only=on`, `statement_timeout=15s`, 11개 관계 SELECT만 | `configure-path-b-release-bot.sql:45-75` |
| 앱 Pool | 추가 방어 | `-c default_transaction_read_only=on -c statement_timeout=15000`, `max: 6` | `postgres.ts:19-27` |
| 앱 코드 | 3중 방어 | `assertSelectOnly()`가 `insert/update/delete/…/call` 단어 포함 SQL을 **실행 전 차단** | `postgres.ts:31-39` |

**결론: 웹앱은 세 겹으로 쓰기가 막혀 있다.** 어느 하나를 푸는 설계는 하지 않는다. (왜: LLM 프롬프트 인젝션 방어가 목적이고, 이건 팀이 의도적으로 세운 계약임)

### 2.5 환경 파일 계약

| 규칙 | 근거 |
| --- | --- |
| `web.env`의 키는 **허용목록 25개**뿐. 모르는 키가 있으면 검증기가 **실패** | `validate-service-envs.py:229-257` `reject_unknown` |
| `web.env`에 `DB_PASSWORD`·`DATABASE_URL`·admin 계정 URL이 있으면 **실패** | `test_validate_service_envs.py:94-135` |
| `BOT_DATABASE_URL`은 `127.0.0.1:5433`, 사용자 `wg_bot`, DB명 일치로 **고정** | `validate_bot_url()` |
| 배포 스크립트가 `/api/health/ready` **200을 5분간 기다리고, 안 오면 실패** | `install-systemd-units.sh:944-956` |

### 2.6 인증

| 항목 | 값 |
| --- | --- |
| 역할 | `user · admin · inspector` (`authApiContract.ts:1`) |
| 상태 | **Mock** — `mockAuthUsers.ts`에 admin 계정이 코드로 존재. 나연 `0009` + 민규 실연결 전까지는 **누구나 admin 로그인 가능** |
| 헬퍼 | `requireAuthenticatedUser`, `requireUserRole(user, ["admin"])`, `assertSameOriginRequest` — 이미 있음 (`server/auth/permissions.ts`, `http.ts`) |
| 사이트 보호 | 팀 공용 Basic Auth 1개 (`proxy.ts`), `/api/health/*`만 예외 |

### 2.7 Path B (정본 재구축 절차)와의 관계

Path B는 **빈 DB에 0000~0008을 적용해 정본을 새로 만드는 절차**다(`PATH_B_REBUILD.md:3-4`). 그 검증 SQL(`assert-path-b-rebuild.sql`)은:

- 관계 ACL(권한 목록)이 "기본값 + `wg_bot` SELECT 11개"와 **정확히** 같아야 함 (`:228-290`)
- **컬럼 단위 권한이 하나라도 있으면 실패** (`:118-130`)
- migration 저널이 **정확히 0000~0008**이어야 함 (`bootstrap-path-b.sh:951`)

**이 검증은 부트스트랩 DB와 복원 검증 DB에서만 돈다.** 운영 DB에 0009 이후 forward migration(앞으로만 추가하는 마이그레이션)을 적용하는 것과는 충돌하지 않는다 — 나연의 0009도 같은 방식이다. 단, **0010은 Path B 계약을 건드리지 않도록 0009와 같은 규칙**(기존 파일 불변, 새 번호, 롤은 migration 밖에서 생성, GRANT는 롤 존재 시에만)을 따른다.

---

## 3. 충돌 지점 목록과 대응

설계 전에 "지금 코드·인프라와 부딪히는 곳"을 전부 적는다. **각 항목은 §5 이후 설계에서 반드시 대응된다.**

| # | 충돌 | 왜 문제인가 | 대응 (어디서) |
| --- | --- | --- | --- |
| C1 | `web.env` 허용목록에 새 키 추가 시 검증기 실패 | 배포 스크립트가 검증기를 먼저 돌림 | Phase 2b에서만 필요. 검증기·테스트·문서를 **같은 PR**로 (§8.6) |
| C2 | `web.env`에 쓰기 자격증명 금지 정책 | 테스트가 명시적으로 거부 | Phase 2a는 CLI로 우회, 2b는 **정책 변경 합의** 후 `wg_ops` 전용 검증 추가 (§8.6) |
| C3 | drift 검사가 `v_current_batch`의 ORDER BY 문자열을 단언 | 뷰 ORDER BY 변경 = CI 실패 | **ORDER BY는 그대로, WHERE만 확장** (§8.2) |
| C4 | `latestBatchSelection.test.ts`가 TS 상수 문자열 단언 | 동일 | 동일 방식. 테스트는 케이스 **추가**만 (§8.3) |
| C5 | `isDatabaseReady()`가 2026-06 행수 553,598에 하드코딩, 테스트도 `= 553598` 단언 | **새 배치가 최신이 되는 순간 `ready=false` → 배포 실패.** Phase 2로 다른 배치를 고정해도 동일 | **Phase 0**에서 "일관성 검사"로 교체 (§5) |
| C6 | 재적재는 `DELETE FROM batches WHERE as_of+model` → 자식 행 CASCADE | 활성 배치를 재적재하면 **플래그가 조용히 사라짐**. 이력 테이블의 FK도 걸림 | 이력에 식별 정보 **비정규화 저장** + FK `SET NULL` + `ingest.sh`에 활성 배치 보호 (§8.2, §8.5) |
| C7 | 규칙이 5곳 + DB 뷰 1곳에 있음 | 한 곳만 바꾸면 화면마다 다른 배치를 보여줌 | Phase 0에서 5번째를 상수로 통일. 뷰는 0010에서 **같은 WHERE**로 (§5, §8.2) |
| C8 | 롤 생성은 migration 밖 (`create-bot-role.sh` 패턴) | migration에 `CREATE ROLE`을 넣으면 CI 빈 DB에서 비밀번호 문제·Path B 위반 | `create-ops-role.sh` 별도 + migration은 **롤 존재 시에만 GRANT** (§8.2) |
| C9 | `risk_full`은 확률이 아님 (1:1 다운샘플, 기저율 0.026%) — DB 주석·POL-03 | 배치 간 "평균 점수" 비교는 **의미 없고 정책 위반** | 비교 지표에서 평균·확률 **제외**, 순위·분위·등급·겹침만 (§7.2) |
| C10 | `wg_bot` 15초 타임아웃, Pool 6개 | 553k×553k 조인 비교가 무거움 | 인덱스 있는 집계 우선, 무거운 지표는 `detail=1` 옵션 + 캐시 (§7.5) |

---

## 4. 설계 원칙

| 원칙 | 왜 |
| --- | --- |
| **읽기와 쓰기를 물리적으로 분리** | 읽기는 기존 `wg_bot` 경로 그대로. 쓰기는 새 롤·새 모듈·새 env 키로만. 기존 방어 3겹을 하나도 건드리지 않기 위해 |
| **규칙 문자열 불변** | ORDER BY 3단 정렬은 CI·drift·테스트가 단언한다. WHERE만 넓히면 전부 통과하고 의미도 보존된다 |
| **하위 호환 = 아무도 전환하지 않으면 지금과 동일** | migration을 적용해도 활성 배치가 0개면 기존 규칙과 정확히 같은 결과. 배포 위험을 0에 가깝게 |
| **DB가 최종 심판** | 활성 1개 보장(부분 유니크 인덱스), 전환 트랜잭션(함수), 사유 필수(CHECK)를 전부 DB 제약으로. 앱 버그가 있어도 상태가 깨지지 않게 |
| **ML 산출물의 의미를 화면이 왜곡하지 않음** | 계약 문서와 `wage-risk.md`의 표기 규칙(기준월≠예측월, `is_prediction=false`는 등급 아님, 확률 금지)을 그대로 |
| **각 단계가 독립적으로 가치 있음** | Phase 1만 해도 P2·P3 해결. Phase 2가 늦어져도 손해 없음 |

---

## 5. Phase 0 — 선행 정비

**이 단계는 설계와 무관하게 지금 필요하다.** 승석이 `--as-of 2026-07` 배치를 넣는 순간 C5가 터진다.

### 5.1 `isDatabaseReady()` 재설계 — `product/src/server/postgres.ts` (윤빈)

지금:

```ts
latest.as_of_date = DATE '2026-06-01'
AND latest.target_month = DATE '2026-12-01'
AND latest.n_scored = 553598 AND latest.n_queue = 3000 AND latest.n_safe = 503887
AND (실제 count 3종 = 기록값)
AND (industrial_safety 뷰 count) = 515608
```

왜 이렇게 돼 있었나: Path B 정본이 맞는 DB에 붙었는지 배포 시점에 확인하려는 의도. **배치가 하나뿐일 때는 옳은 설계였다.**

바꿀 것:

```ts
-- 최신 배치의 "내부 일관성"만 검사한다. 어느 배치인지는 고정하지 않는다.
SELECT
  latest.as_of_date IS NOT NULL
  AND latest.target_month = (latest.as_of_date + INTERVAL '6 months')::date
  AND latest.n_scored > 0 AND latest.n_queue > 0 AND latest.n_safe > 0
  AND (SELECT count(*) FROM scored_active       WHERE batch_id = latest.id) = latest.n_scored
  AND (SELECT count(*) FROM inspector_queue     WHERE batch_id = latest.id) = latest.n_queue
  AND (SELECT count(*) FROM safe_recommendation WHERE batch_id = latest.id) = latest.n_safe
  AND (SELECT count(*) FROM industrial_safety.v_llm_firm_safety_context) = 515608   -- 유지
  AS ready
FROM latest
```

| 항목 | 내용 |
| --- | --- |
| 유지하는 것 | 산업안전 뷰 515,608 고정 — 배치와 무관한 정본 상수라 "엉뚱한 DB" 탐지 기능은 남는다 |
| 잃는 것 | "정확히 2026-06 배치"라는 핀. 대신 `OPERATIONS.md` 배포 5단계(최신 배치 smoke test)가 사람이 확인하는 자리다 |
| `latest` CTE | **`LATEST_BATCH_ORDER_SQL` 상수를 사용**하도록 바꾼다 (C7 해소) |
| 테스트 | `postgres.readiness.test.ts`의 `toContain("= 553598")` → `toContain("+ INTERVAL '6 months'")`로 교체. `count(` 4회 단언은 유지 |
| 크기 | S |

> ⚠️ 이 변경은 `product/src/server/**`(공통 경로)라 팀장이 하되, **나연에게 사전 공유**한다. readiness의 의도를 나연이 세웠기 때문이다.

### 5.2 완료 기준

- `npm run test` 통과 (`readiness`, `latestBatchSelection` 포함)
- 로컬 PG에 `as_of 2026-07` 가짜 배치(빈 행수라도) 추가 → `ready=false`가 **행수 불일치 때문**이지 날짜 때문이 아님을 확인

---

## 6. Phase 1 — 배치 현황 화면 (읽기 전용)

### 6.1 무엇을 보여주나

`batches`는 이미 `wg_bot` SELECT 허용 목록에 있다. **권한·migration·env 변경 없음.**

```sql
SELECT id, as_of_date::text, target_month::text, model_version, model_sha,
       ingested_at::text, source, n_scored, n_queue, n_safe
  FROM public.batches
 ORDER BY as_of_date DESC NULLS LAST, ingested_at DESC, id DESC;
```

여기에 "지금 서비스 중" 1건을 **같은 상수**로 골라 표시한다. Phase 1에서는 항상 `selection_mode = "auto"`.

### 6.2 API

`GET /api/admin/batches`

```jsonc
{
  "selection_mode": "auto",          // Phase 2 이후 "pinned" 가능
  "current": {
    "id": 7, "as_of_date": "2026-06-01", "target_month": "2026-12-01",
    "model_version": "door1-voting-39f-v1", "model_sha": "cbe5d951f170527c",
    "ingested_at": "2026-08-07T06:26:00Z",
    "n_scored": 553598, "n_queue": 3000, "n_safe": 503887
  },
  "batches": [ /* 위와 같은 형태, 전체 */ ],
  "generated_at": "2026-09-02T03:00:00Z"
}
```

| 규칙 | 왜 |
| --- | --- |
| `Cache-Control: no-store` | 감독관 API와 동일 관례 (`inspector/overview/route.ts`) |
| `dynamic = "force-dynamic"` | 동일 |
| 에러는 `errorPayload()` | 동일. DB 미설정이면 `DATABASE_NOT_CONFIGURED` 503 |
| `target_month`는 **DB 컬럼 그대로** | 계산하지 않는다. ingest가 `as_of+6`으로 기록하며, 계산식을 화면에 두면 이중 정의가 된다 |

### 6.3 화면

```text
/admin/batches
┌────────────────────────────────────────────────────────────────────┐
│ ML 배치 현황                                   선택 방식: 자동(최신) │
│                                                                    │
│ 현재 서비스 중                                                     │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ 기준월 2026-06  →  예측 대상월 2026-12            ✅ 서비스 중  │ │
│ │ 모델 door1-voting-39f-v1 · sha cbe5d951 · 적재 2026-08-07     │ │
│ │ 채점 553,598 · 위험큐 3,000 · 판정 503,887                     │ │
│ └────────────────────────────────────────────────────────────────┘ │
│                                                                    │
│ 전체 배치 (7)                                          [비교하기]  │
│ ┌──┬────────┬────────┬─────────────────┬────────┬────────┬───────┐ │
│ │  │ 기준월  │ 예측월  │ 모델            │ 채점    │ 큐     │ 판정  │ │
│ ├──┼────────┼────────┼─────────────────┼────────┼────────┼───────┤ │
│ │✅│ 2026-06 │ 2026-12│ door1-…-v1 cbe5 │553,598 │ 3,000  │503,887│ │
│ │  │ 2026-05 │ 2026-11│ door1-…-v1 cbe5 │552,593 │ 3,000  │502,115│ │
│ │  │   …    │        │                 │        │        │       │ │
│ └──┴────────┴────────┴─────────────────┴────────┴────────┴───────┘ │
│ ⓘ 서비스 배치 = 기준월이 가장 늦은 것. 같으면 나중에 적재된 것.     │
└────────────────────────────────────────────────────────────────────┘
```

표시 규칙 (계약 문서·`wage-risk.md`와 일치):

| 항목 | 규칙 | 왜 |
| --- | --- | --- |
| `as_of_date` | "**기준월**" (관측창의 끝) | "적재일"·"예측월"과 혼동이 잦다 |
| `target_month` | "**예측 대상월**" | `risk_full`은 이 달의 명단공개 위험이다 |
| `ingested_at` | "적재" — 운영자가 넘긴 canonical timestamp임을 툴팁에 | `now()`가 아니다 |
| `as_of_date IS NULL` | "기준월 미확정" 배지, 서비스 후보 제외 | 규칙 자체가 제외한다 |
| `model_sha` | 앞 8자 + 툴팁 전체. **NULL이면 "지문 없음" 경고** | 비교 화면의 모드 판별에 필요 (§7.3) |
| 행수 | 천 단위 구분 | 가독성 |
| 등급·점수 | **표시하지 않음** | 배치 메타데이터 화면이다. 등급은 §7에서 집계로만 |

### 6.4 코드 위치와 관례

| 종류 | 경로 | 관례 근거 |
| --- | --- | --- |
| 페이지 | `product/src/app/admin/batches/page.tsx` | `app/inspector/page.tsx`처럼 서버 컴포넌트가 클라이언트 컴포넌트를 감쌈 |
| 컴포넌트 | `product/src/components/admin/BatchDashboard.tsx`, `AdminNav.tsx` | `components/inspector/*` 대응. `"use client"` + `fetch(..., {cache:"no-store"})` |
| 서비스 | `product/src/services/batchService.ts` | `inspectorService.ts`처럼 `queryReadOnly` 직접 사용 |
| API | `product/src/app/api/admin/batches/route.ts` | §6.2 |
| 스타일 | `globals.css`에 `.admin-page`, `.batch-*` 추가 | Tailwind 아님. 전역 CSS 클래스 관례 (`.inspector-page` 등) |
| 테스트 | `services/batchService.test.ts` (vitest, `queryReadOnly` mock) | `latestBatchSelection.test.ts` 패턴 |
| API 문서 | `product/docs/api-contract.md` §8에 "운영자용 내부 API" 항목 추가 | 감독관 API가 같은 방식으로 문서화됨 |

### 6.5 접근 제어 (Phase 1)

- 지금: 사이트 전체 Basic Auth와 동일 보호. `/inspector`와 같은 수준
- 실인증 이후: `requireUserRole(user, ["admin", "inspector"])` — 배치 메타데이터는 감독관에게도 유용하다
- **경로 `app/admin/**`은 현재 미배정.** 팀장 결정 필요 (§13)

### 6.6 작업량

| # | 작업 | 크기 | 담당 |
| --- | --- | --- | --- |
| 1 | `batchService.ts` 목록 + 현재 배치 | S | 미배정 |
| 2 | API 라우트 | S | 미배정 |
| 3 | 컴포넌트·페이지·CSS | M | 미배정 |
| 4 | 표기 검수 (기준월/예측월/미확정) | S | 민서 |
| 5 | 테스트 + api-contract 갱신 | S | 미배정 |

---

## 7. Phase 1.5 — 결과 비교 화면 (읽기 전용)

### 7.1 ML 과정과 맞물리는 지점 — 왜 이 지표들인가

ML 쪽 과정(계약 문서·`ingest.sh`·`0006`에서 확인):

```text
같은 pkl로 매월 재채점 ─→ risk_full(순위용 점수) ─→ 배치 안에서 백분위 ─→ risk_tier (0.5%/2%/10%)
                                                  └→ 상위 3,000 = inspector_queue (rank, reasons=SHAP)
                       규칙 판정 ─→ safe_recommendation.판정 (안정신호/유보/배제_…)
평가지표(recall_cum, lift)는 ML팀 실측 → risk_tier_meta 에 상수로 저장. DB에서 재계산 불가 (라벨 없음)
```

따라서 DB만으로 낼 수 있는 비교는 **라벨 없는 비교**뿐이다. 두 배치의 "정답률"은 못 내지만, **"얼마나 달라졌는가"** 는 정확히 낼 수 있다. 이것이 운영에서 실제로 필요한 질문이다 — 새 배치가 이상한지, 모델을 바꿨더니 큐가 뒤집혔는지.

### 7.2 지표 정의

| # | 지표 | 산출 | 근거 컬럼 | 해석 |
| --- | --- | --- | --- | --- |
| M0 | **비교 모드** | `model_sha` 같음·`as_of` 다름 → "월간 변화" / sha 다름·as_of 같음 → "모델 A/B" / 둘 다 다름 → **"해석 불가" 경고** | `batches` | 무엇이 원인인지 분리해야 해석이 된다 |
| M1 | 규모 | n_scored·n_queue·n_safe 차이, 사업장 커버리지(A만/B만/양쪽) | `batches`, `scored_active.firm_id` | 폐업·신규 반영 |
| M2 | 채점 불가율 | `risk_full IS NULL` 비율 | `scored_active` | 관측창 커버리지 변화 |
| M3 | 등급 분포 | tier별 건수 (6종, `is_prediction=false` 2종은 **별도 표기**) | `scored_active.risk_tier` + `risk_tier_meta` | 백분위 고정이라 비율은 거의 같음. **변화는 M4에서** |
| M4 | **등급 이동 행렬** | 같은 사업장의 A등급→B등급 6×6 교차표 | `scored_active` self-join on `firm_id` | 얼마나 많은 사업장이 등급을 넘나들었나 |
| M5 | **큐 겹침** | K∈{100, 500, 1500, 3000}에서 `|topK(A)∩topK(B)| / K` | `inspector_queue.rank` | K는 `queue_priority` 경계(긴급<100/우선<500/주의<1500)와 일치시킴 |
| M6 | 순위 상관 | 큐 공통 사업장의 `corr(rank_a, rank_b)` (스피어만) | 동일 | 1에 가까울수록 순서 보존 |
| M7 | 판정 분포·이동 | `판정` 6종 건수 + 이동 행렬 | `safe_recommendation.판정` | 구직자 화면에 직접 영향 |
| M8 | 배제 플래그 변화 | `체불배제`·`체납배제` true 건수 | `scored_active` | ⚠️ 점-인-타임 아님(현재 상태). 툴팁에 명시 |
| M9 | 사유 분포 | `reasons` unnest 상위 10 + 순위 변화 | `inspector_queue.reasons` | SHAP 사유가 뒤집히면 모델·데이터 이상 신호 |
| M10 | 참고 지표 | `risk_tier_meta`의 recall_cum·lift 범위 | 상수 | **비교값이 아니라 범례**. 두 배치가 같은 값 |

**제외하는 지표와 이유**

| 제외 | 왜 |
| --- | --- |
| `risk_full` 평균·중앙값 | 확률이 아님(C9). 순위용 점수의 평균은 해석 불가. POL-03 위반 |
| `risk_calibrated` | 전부 NULL (계약 문서·DB 주석) |
| recall·lift 재계산 | 라벨(실제 명단공개)이 DB에 없음 |
| 사업장 이름 목록 (기본 화면) | 감독관 전용 정보. 집계만 기본, 개별 목록은 §7.6 권한 하에서만 |

### 7.3 API

`GET /api/admin/batches/compare?a={id}&b={id}&detail={0|1}`

```jsonc
{
  "a": { "id": 6, "as_of_date": "2026-05-01", "model_version": "…", "model_sha": "…" },
  "b": { "id": 7, "as_of_date": "2026-06-01", "model_version": "…", "model_sha": "…" },
  "mode": "monthly_drift",            // "model_ab" | "ambiguous" | "unknown_sha"
  "scale": { "scored": [552593, 553598], "queue": [3000, 3000], "safe": [502115, 503887],
             "firms_only_a": 1204, "firms_only_b": 2209, "firms_both": 551389 },
  "null_ratio": [0.092, 0.090],
  "tier_counts": { "매우높음": [2510, 2519], "높음": [...], "…": [], "정보부족": [...], "이미공개": [...] },
  "queue_overlap": { "100": 0.81, "500": 0.86, "1500": 0.88, "3000": 0.90 },
  "queue_rank_corr": { "shared": 2700, "spearman": 0.93 },
  "verdict_counts": { "안정신호": [...], "유보": [...], "…": [] },
  "exclusion_counts": { "체불배제": [...], "체납배제": [...] },
  "top_reasons": { "a": [["…", 812], …], "b": [["…", 798], …] },
  // detail=1 일 때만
  "tier_transition": [ { "from": "높음", "to": "매우높음", "n": 41 }, … ],
  "verdict_transition": [ … ],
  "generated_at": "…", "cached": false
}
```

| 규칙 | 왜 |
| --- | --- |
| `a`·`b` 검증: 정수, 존재, `a≠b` | 400 |
| `mode` 판정에 `model_sha`가 NULL이면 `"unknown_sha"` | 승석이 `--model-sha`를 항상 넘겨야 함 → 계약 문서 Q에 추가 |
| 결과를 **메모리 캐시 10분**, 키 = `(a, b, ingested_at_a, ingested_at_b)` | 재적재되면 `ingested_at`이 바뀌어 캐시가 자연 무효화. `probeDualLlmStatus`의 60초 캐시와 같은 방식 |

### 7.4 SQL 초안 (전부 `SELECT/WITH`만 — `assertSelectOnly` 통과)

등급 이동 행렬 (M4):

```sql
WITH a AS (SELECT firm_id, risk_tier FROM public.scored_active WHERE batch_id = $1),
     b AS (SELECT firm_id, risk_tier FROM public.scored_active WHERE batch_id = $2)
SELECT COALESCE(a.risk_tier, '(없음)') AS tier_a,
       COALESCE(b.risk_tier, '(없음)') AS tier_b,
       count(*)::int AS n
  FROM a FULL OUTER JOIN b USING (firm_id)
 GROUP BY 1, 2;
```

큐 겹침 (M5) + 순위 상관 (M6):

```sql
WITH a AS (SELECT firm_id, rank FROM public.inspector_queue WHERE batch_id = $1),
     b AS (SELECT firm_id, rank FROM public.inspector_queue WHERE batch_id = $2),
     k AS (SELECT unnest(ARRAY[100, 500, 1500, 3000]) AS k)
SELECT k.k,
       (SELECT count(*) FROM a JOIN b USING (firm_id) WHERE a.rank <= k.k AND b.rank <= k.k)::int AS overlap,
       (SELECT corr(a.rank, b.rank) FROM a JOIN b USING (firm_id)) AS spearman_all,
       (SELECT count(*) FROM a JOIN b USING (firm_id))::int AS shared
  FROM k ORDER BY k.k;
```

등급 분포 (M3) — `scored_batch_tier_idx (batch_id, risk_tier)` 인덱스를 탄다:

```sql
SELECT batch_id, risk_tier, count(*)::int AS n
  FROM public.scored_active
 WHERE batch_id IN ($1, $2)
 GROUP BY 1, 2;
```

사유 상위 (M9):

```sql
SELECT q.batch_id, r AS reason, count(*)::int AS n
  FROM public.inspector_queue AS q, unnest(q.reasons) AS r
 WHERE q.batch_id IN ($1, $2)
 GROUP BY 1, 2
 ORDER BY 1, 3 DESC;
```

> 판정 이동(M7)·배제 플래그(M8)·커버리지(M1)·NULL 비율(M2)은 위와 같은 꼴이라 생략. 전체는 구현 PR에서.

### 7.5 성능 — `wg_bot` 15초 안에 들어오는가

| 쿼리 | 데이터 | 예상 | 근거 |
| --- | --- | --- | --- |
| 등급 분포 | 배치당 55만 행, 인덱스 | < 1초 | `scored_batch_tier_idx` |
| 큐 겹침·상관 | 3,000 × 3,000 | 즉시 | PK `(firm_id, batch_id)` |
| 사유 unnest | 3,000 × 수 개 | 즉시 | — |
| **등급 이동 행렬** | 55만 × 55만 해시 조인 | **1~4초 [추정]** | PK 조인. `detail=1`에서만 |
| 판정 이동 | 50만 × 50만 | 1~4초 [추정] | 동일 |

대응: `detail=0` 기본은 가벼운 지표만. `detail=1`은 캐시 필수. 실측이 10초를 넘으면 **집계를 `ingest.sh` 끝에서 미리 계산해 저장**하는 안(§8.7 후속)으로 옮긴다.

> [추정] 표시는 로컬에서 실제 배치 2개로 재야 확정된다. 이번 주 로컬 PG16에 백필 CSV 2개월치를 넣고 재는 것을 권한다.

### 7.6 화면

```text
/admin/batches/compare?a=6&b=7
┌──────────────────────────────────────────────────────────────────────┐
│ 배치 비교           A: 2026-05 (door1-…-v1)   B: 2026-06 (door1-…-v1) │
│ 모드: 월간 변화 (같은 모델, 다른 기준월)                                │
│                                                                      │
│ 규모          채점 552,593 → 553,598 (+1,005)  큐 3,000 → 3,000       │
│               사업장 A만 1,204 · B만 2,209 · 양쪽 551,389              │
│ 채점 불가율   9.2% → 9.0%                                             │
│                                                                      │
│ 위험큐 겹침   상위100 81% · 500 86% · 1500 88% · 3000 90%   ρ = 0.93  │
│               ┃ 기준선(직전 6개월 평균) 100: 78~85% ┃  ← 승석 검토 후    │
│                                                                      │
│ 등급 분포     매우높음 2,510→2,519 · 높음 … · 다소높음 … · 일반 …        │
│               [상태] 정보부족 …→… · 이미공개 …→…   (등급 아님, 회색)     │
│                                                                      │
│ 판정 분포     안정신호 … · 유보 … · 유보_정보부족 … · 배제_ … (3종)      │
│                                                                      │
│ 사유 Top 10   A: … / B: …  (순위 변동 화살표)                           │
│                                                                      │
│ [자세히 보기: 등급 이동 행렬 · 판정 이동 행렬]  ← detail=1               │
└──────────────────────────────────────────────────────────────────────┘
```

표시 규칙:

| 규칙 | 근거 |
| --- | --- |
| `정보부족`·`이미공개`는 예측 등급과 **다른 색·다른 블록** | `risk_tier_meta.is_prediction=false` — `wage-risk.md §4.2` |
| 배제 플래그에 "현재 상태(점-인-타임 아님)" 툴팁 | `v_risk_history` 주석 |
| 점수·확률 표기 없음 | POL-03, C9 |
| "기준선" 띠는 **Phase 1.5 후반**에 붙임 | 기존 7개 배치의 인접 6쌍으로 한 번 계산 → 승석이 정상 범위를 정한다 |
| 개별 사업장 목록(등급 상승 상위 등)은 `inspector`·`admin` 역할에만 | `risk_tier`는 감독관 전용(명예훼손 리스크) |

### 7.7 "기준선" — 비교 화면을 해석 가능하게 만드는 한 번의 작업

지표를 내도 "90%가 정상인가?"를 모르면 소용없다. **기존 7개 배치가 이미 답을 갖고 있다.**

```text
(2025-12, 2026-01) (2026-01, 2026-02) … (2026-05, 2026-06)  = 인접 6쌍
→ 같은 모델의 월간 변화 분포 = "정상 범위"
```

승석에게 요청할 것: 6쌍의 M2·M4·M5·M6·M7을 뽑아 **정상 띠**(예: 상위100 겹침 78~85%)를 정해달라. 화면은 이 띠를 배경으로 그린다. 새 배치가 띠 밖이면 노란 경고. **이것이 ML 엔지니어가 아닌 멤버가 "이 배치 이상한데?"를 말할 수 있게 하는 장치다.**

### 7.8 작업량

| # | 작업 | 크기 | 담당 |
| --- | --- | --- | --- |
| 1 | `batchCompareService.ts` (지표 10종, 캐시) | M | 미배정 |
| 2 | API + 입력 검증 | S | 미배정 |
| 3 | 화면 (표·행렬·띠) | M~L | 미배정 |
| 4 | 성능 실측 (로컬 2배치) | S | 윤빈 |
| 5 | 기준선 6쌍 산출·정상 띠 결정 | S | **승석** |
| 6 | 표기 검수 | S | 민서 |
| 7 | 테스트 (SQL 문자열·모드 판정·캐시 키) | S | 미배정 |

---

## 8. Phase 2 — 전환 기능

### 8.1 왜 두 갈래(2a CLI, 2b 화면)인가

| | 2a CLI | 2b 화면 |
| --- | --- | --- |
| 필요한 것 | migration 0010 + `wg_ops` 롤 + 스크립트 | 2a + `web.env` 정책 변경 + 실인증 RBAC |
| 보안 계약 변경 | **없음** (웹은 여전히 읽기 전용) | **있음** (웹이 쓰기 자격증명 보유) |
| 누가 쓰나 | VM SSH 가능한 사람 (승석·나연·윤빈) | admin 역할 로그인 사용자 |
| P5(1인 병목) 해소 | 부분 (3명) | 완전 |
| 가능 시점 | 나연 작업 후 즉시 | 팀 합의 + 민규 실연결 후 |

**2a를 먼저 한다.** 2a만으로 P1(롤백)·P4(즉시 반영) 문제가 풀리고, 2b는 그 위에 화면만 얹는다.

### 8.2 migration `0010_batch_activation.sql` (나연 담당 · 초안)

```sql
-- 0010: 서비스 배치를 운영자가 명시적으로 고정(pin)할 수 있게 한다.
--
-- 왜: 지금은 "기준월이 가장 늦은 배치"가 자동으로 서비스된다. 새 배치를 적재하면
--     검토 없이 즉시 반영되고, 되돌리려면 재적재뿐이다. 활성 플래그를 두어
--     ① 이상 배치를 이전 배치로 되돌리고 ② 새 모델을 적재만 해두고 비교 후 전환할 수 있게 한다.
-- 하위 호환: 활성 배치가 하나도 없으면 기존 규칙과 정확히 같다.
-- 규칙 문자열: v_current_batch 의 ORDER BY 는 0008 과 동일하게 유지한다 (drift 후조건).

/* ── ① 활성 플래그 ─────────────────────────────────────────── */
ALTER TABLE batches ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN batches.is_active IS
  '운영자가 고정한 서비스 배치. 최대 1개. 전부 false 면 v_current_batch 규칙(최신 기준월)이 자동 적용된다. '
  'activate_batch()/deactivate_batches() 로만 바꾼다 — 직접 UPDATE 하지 말 것.';
CREATE UNIQUE INDEX IF NOT EXISTS batches_one_active_uq ON batches (is_active) WHERE is_active;

/* ── ② 전환 이력 ───────────────────────────────────────────── */
CREATE TABLE IF NOT EXISTS batch_activations (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id           integer REFERENCES batches(id) ON DELETE SET NULL,   -- 재적재로 행이 사라져도 이력은 남긴다
  previous_batch_id  integer REFERENCES batches(id) ON DELETE SET NULL,
  as_of_date         date,                                                -- 비정규화: batch 행이 사라져도 무엇이었는지
  model_version      text NOT NULL,
  model_sha          text,
  action             text NOT NULL CHECK (action IN ('activate', 'deactivate')),
  activated_at       timestamptz NOT NULL DEFAULT now(),
  activated_by       text NOT NULL,
  reason             text NOT NULL CHECK (length(btrim(reason)) >= 5)
);
CREATE INDEX IF NOT EXISTS batch_activations_at_idx ON batch_activations (activated_at DESC);
COMMENT ON TABLE batch_activations IS '서비스 배치 전환 이력. 롤백 근거. 삭제하지 않는다.';

/* ── ③ 현재 배치 뷰 — WHERE 만 확장, ORDER BY 는 0008 그대로 ── */
CREATE OR REPLACE VIEW v_current_batch AS
SELECT * FROM batches
WHERE as_of_date IS NOT NULL
  AND (is_active OR NOT EXISTS (SELECT 1 FROM batches WHERE is_active))
ORDER BY as_of_date DESC, ingested_at DESC, id DESC
LIMIT 1;
COMMENT ON VIEW v_current_batch IS
  '서비스 배치 한 행. 고정(is_active)된 배치가 있으면 그것, 없으면 최신 기준월. 동률은 ingested_at, id 내림차순.';

/* ── ④ 전환 함수 — 트랜잭션 전체를 DB 가 책임진다 ──────────── */
CREATE OR REPLACE FUNCTION activate_batch(p_batch_id integer, p_actor text, p_reason text)
RETURNS TABLE (activated_batch_id integer, replaced_batch_id integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_row batches%ROWTYPE; v_prev integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('batch_activation'));   -- 동시 전환 직렬화
  SELECT * INTO v_row FROM batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch % 가 없습니다', p_batch_id; END IF;
  IF v_row.as_of_date IS NULL THEN RAISE EXCEPTION '기준월 미확정 배치는 활성화할 수 없습니다'; END IF;
  IF v_row.n_scored = 0 OR v_row.n_queue = 0 OR v_row.n_safe = 0 THEN
    RAISE EXCEPTION '행수가 0 인 배치는 활성화할 수 없습니다'; END IF;
  SELECT id INTO v_prev FROM batches WHERE is_active;
  IF v_prev = p_batch_id THEN RETURN QUERY SELECT p_batch_id, v_prev; RETURN; END IF;   -- 멱등
  UPDATE batches SET is_active = false WHERE is_active;
  UPDATE batches SET is_active = true  WHERE id = p_batch_id;
  INSERT INTO batch_activations (batch_id, previous_batch_id, as_of_date, model_version, model_sha,
                                 action, activated_by, reason)
  VALUES (p_batch_id, v_prev, v_row.as_of_date, v_row.model_version, v_row.model_sha,
          'activate', p_actor, p_reason);
  RETURN QUERY SELECT p_batch_id, v_prev;
END $$;

CREATE OR REPLACE FUNCTION deactivate_batches(p_actor text, p_reason text)
RETURNS integer   -- 해제된 batch_id, 없으면 NULL
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_row batches%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('batch_activation'));
  SELECT * INTO v_row FROM batches WHERE is_active FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE batches SET is_active = false WHERE id = v_row.id;
  INSERT INTO batch_activations (batch_id, previous_batch_id, as_of_date, model_version, model_sha,
                                 action, activated_by, reason)
  VALUES (NULL, v_row.id, v_row.as_of_date, v_row.model_version, v_row.model_sha,
          'deactivate', p_actor, p_reason);
  RETURN v_row.id;
END $$;

REVOKE ALL ON FUNCTION activate_batch(integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION deactivate_batches(text, text)     FROM PUBLIC;

/* ── ⑤ 권한 — 롤은 migration 밖에서 만든다. 있을 때만 GRANT (0009 와 같은 규칙) ── */
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wg_ops') THEN
    GRANT EXECUTE ON FUNCTION activate_batch(integer, text, text) TO wg_ops;
    GRANT EXECUTE ON FUNCTION deactivate_batches(text, text)     TO wg_ops;
    GRANT SELECT ON batches, batch_activations TO wg_ops;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wg_bot') THEN
    GRANT SELECT ON batch_activations TO wg_bot;   -- 이력 화면은 읽기 경로로
  END IF;
END $$;
```

설계 근거:

| 선택 | 왜 |
| --- | --- |
| `SECURITY DEFINER` 함수 | 함수가 **소유자(마이그레이션 실행 계정) 권한으로** 실행된다. `wg_ops`는 테이블에 UPDATE 권한이 **전혀 없어도** 된다. 컬럼 권한(`GRANT UPDATE (is_active)`)보다 좁다 |
| `SET search_path = public, pg_temp` | SECURITY DEFINER 함수의 표준 안전장치 (동명 객체로 가로채기 방지) |
| 어드바이저리 락 | 두 사람이 동시에 전환해도 직렬화. 부분 유니크 인덱스는 최후 방어 |
| 이력에 `as_of_date/model_version/model_sha` 복사 | C6 — 재적재로 `batches` 행이 삭제돼도 "무엇을 활성화했었는지" 남는다 |
| FK `ON DELETE SET NULL` | 이력이 재적재를 막지 않게. 막고 싶으면 `ingest.sh`에서 막는다 (§8.5) |
| `reason` 5자 이상 CHECK | 사유 필수를 앱이 아니라 DB가 강제 |
| `deactivate` 별도 | "자동 규칙으로 복귀"가 명시적 행위여야 이력에 남는다 |
| 멱등 | 같은 배치를 두 번 활성화해도 이력이 늘지 않는다 |

**drift 후조건 추가** (`check-migration-drift.mjs` `POSTCONDITION_KEYS` + SQL + `migration-drift.test.mjs`, 나연):

```js
"0010_batch_activation": Object.freeze([
  "column:public.batches.is_active",
  "index:public.batches_one_active_uq",
  "table:public.batch_activations",
  "view_definition:public.v_current_batch_honors_is_active",   // definition ~* 'is_active'
  "function:public.activate_batch",                            // 새 probe: to_regprocedure('public.activate_batch(integer,text,text)') IS NOT NULL
]),
```

> `function:` probe는 지금 없다. 나연이 추가하거나, 없으면 이 키를 빼고 뷰·컬럼·테이블 4개만으로 간다.

`db/schema.ts`도 같은 커밋에서 `isActive` 컬럼과 `batchActivations` 테이블을 추가한다 (`_journal.json` 항목 `idx: 9, tag: "0010_batch_activation"`).

### 8.3 앱 상수 변경 — `latestBatchSql.ts` (윤빈, 공통 경로)

```ts
export const LATEST_BATCH_ORDER_SQL = `WHERE as_of_date IS NOT NULL
  AND (is_active OR NOT EXISTS (SELECT 1 FROM public.batches WHERE is_active))
ORDER BY as_of_date DESC, ingested_at DESC, id DESC
LIMIT 1`;
```

| 확인 | 결과 |
| --- | --- |
| `latestBatchSelection.test.ts` | `"WHERE as_of_date IS NOT NULL"` 포함 ✅ · ORDER BY 문자열 포함 ✅ · **수정 없이 통과** |
| 추가할 테스트 | `"is_active OR NOT EXISTS"` 포함 단언 1건 — "고정 배치를 우선한다" |
| 5곳 동시 반영 | 상수라 자동. Phase 0에서 `isDatabaseReady`도 상수를 쓰게 했으므로 5/5 |
| 배포 순서 | **0010 적용 → 앱 배포.** 반대로 하면 `is_active` 컬럼이 없어 모든 배치 조회가 실패한다. 팀 규칙(배포·migration 분리, drift pending이면 배포 중단)이 이미 이 순서를 강제한다 |

### 8.4 `wg_ops` 롤 — `db/scripts/create-ops-role.sh` (나연 · `create-bot-role.sh` 복제)

```sql
CREATE ROLE wg_ops WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 2 PASSWORD :'ops_password';
ALTER ROLE wg_ops SET statement_timeout = '10s';
ALTER ROLE wg_ops SET idle_in_transaction_session_timeout = '30s';
-- default_transaction_read_only 는 켜지 않는다 (함수 실행에 쓰기 필요)
REVOKE ALL ON SCHEMA public FROM wg_ops;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM wg_ops;
GRANT CONNECT ON DATABASE :"expected_database" TO wg_ops;
GRANT USAGE ON SCHEMA public TO wg_ops;
GRANT SELECT ON batches, batch_activations TO wg_ops;
GRANT EXECUTE ON FUNCTION activate_batch(integer, text, text), deactivate_batches(text, text) TO wg_ops;
```

`wg_ops`가 할 수 있는 일의 **전부**: 배치 목록 읽기, 이력 읽기, 함수 2개 호출. 테이블 쓰기 권한 0.

### 8.5 `ingest.sh` 보호 (나연·승석 협의)

| 변경 | 왜 |
| --- | --- |
| `DELETE FROM batches …` 직전에 대상이 `is_active`면 **중단** (`--replace-active` 플래그 없이는) | C6 — 서비스 중인 배치가 조용히 갈아끼워지는 것을 막는다 |
| 적재 끝에 "현재 서비스 배치"와 **"고정 중이면 이번 적재는 자동 반영되지 않음"** 경고 출력 | 운영자가 고정 상태를 잊는 것을 막는다 |
| `ingest-cli.test.mjs`에 케이스 2개 추가 | 기존 테스트 패턴 |

```sql
-- ingest.sh 의 DELETE 직전
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM batches
              WHERE as_of_date = :'as_of_date'::date AND model_version = :'model_version'
                AND is_active)
     AND :'replace_active' <> '1' THEN
    RAISE EXCEPTION '서비스 중(is_active)인 배치입니다. 먼저 deactivate 하거나 --replace-active 를 주세요';
  END IF;
END $$;
```

> 0010 적용 전 DB에서는 `is_active` 컬럼이 없어 위 블록이 실패한다. `ingest.sh`는 0010과 **같은 PR**로 가거나, `to_regclass`로 컬럼 존재를 먼저 확인한다.

### 8.6 2a — CLI 전환 `db/scripts/activate-batch.sh` (나연)

```bash
./scripts/activate-batch.sh --batch-id 6 --by "조윤빈" --reason "2026-06 배치 큐 겹침 61% 이상치, 승석 확인 전 롤백"
./scripts/activate-batch.sh --deactivate --by "한승석" --reason "2026-06 재검증 완료, 자동 규칙 복귀"
./scripts/activate-batch.sh --status
```

- `ingest.sh`와 같은 방식으로 env 파일에서 **허용된 키만** 읽는다 (`OPS_USER`, `OPS_PASSWORD`, `DB_HOST/PORT/NAME`)
- 내부는 `SELECT * FROM activate_batch($1,$2,$3)` 한 줄
- 완료 후 `v_current_batch`를 다시 읽어 **결과를 출력**하고, `curl /api/system/status`로 앱이 같은 배치를 보는지 확인하는 안내를 찍는다

**이 시점에 P1·P4가 해결된다.** 화면 없이도 되돌릴 수 있고, 새 모델은 적재만 해두고 비교(§7) 후 전환한다.

### 8.7 2b — 화면 전환

#### 필요한 정책 변경 (C1·C2) — **팀 합의 항목**

| 안 | 내용 | 장점 | 단점 |
| --- | --- | --- | --- |
| **A. `web.env`에 `OPS_DATABASE_URL` 추가** | 검증기에 `validate_ops_url()`(사용자 `wg_ops` 고정, loopback 고정) + 허용목록 + 테스트 + `ENVIRONMENT_FILES.md` | 구현 단순. `wg_ops`는 함수 2개만 가능해 유출 시 피해 = "배치 전환"에 한정 | "웹은 읽기 전용" 원칙에 **예외** 생김 |
| B. 별도 ops 서비스 | RAG·계약 서비스처럼 독립 프로세스 + 내부 토큰. 웹은 HTTP로 요청 | 원칙 유지 | systemd unit·env·검증기·헬스 전부 신설. 학기 프로젝트 규모에 과함 |
| C. 화면 전환 포기 | 2a CLI만 | 변경 0 | P5 부분 해결에 그침 |

**권고: A.** 근거 — `wg_ops`의 권한이 함수 2개로 좁고, 함수가 검증(기준월·행수·사유)을 내장하며, 이력이 남고, RBAC로 한 번 더 막는다. 단 **나연이 반대하면 B가 아니라 C로 간다** (B는 이번 학기 범위가 아니다).

#### 앱 쪽 (A 채택 시)

| 항목 | 내용 | 왜 |
| --- | --- | --- |
| `server/postgresOps.ts` **신규** | `Pool` 별도 (`application_name: "donworry-product-ops"`, read-only 옵션 **없음**, `max: 2`). export는 `activateBatch()`, `deactivateBatches()` **두 함수뿐** — 범용 query 함수를 내보내지 않는다 | `postgres.ts`의 `assertSelectOnly`를 건드리지 않는다. 쓰기 가능한 경로가 코드 상 두 함수로 한정된다 |
| `databaseConfig.ts` | `getOpsConnectionString()` 추가. `OPS_DATABASE_URL`만 인정, 없으면 `undefined` → 전환 API는 503 `OPS_NOT_CONFIGURED` | 설정이 없으면 기능이 **없는 것처럼** 동작 |
| `POST /api/admin/batches/{id}/activate` `{reason}` | `assertSameOriginRequest` → `requireAuthenticatedUser` → `requireUserRole(["admin"])` → `activateBatch` | CSRF·인증·역할 3단. 기존 헬퍼 그대로 |
| `POST /api/admin/batches/deactivate` `{reason}` | 동일 | — |
| `GET /api/admin/batches/activations` | 읽기 경로(`wg_bot`) | 이력 화면 |
| 화면 | 현황 화면(§6.3)에 "이 배치로 전환" 버튼 + 사유 입력 모달 + 전환 후 §7 비교를 **자동으로 열어** 검증 | 전환 직후 이상을 눈으로 확인 |
| 노출 조건 | `OPS_DATABASE_URL` 설정됨 **AND** 세션 role=admin | 둘 중 하나라도 아니면 버튼 자체가 없다 |

#### 실인증 전에는 절대 켜지 않는다

Mock 인증의 admin 계정은 저장소에 공개돼 있다. 2b는 **나연 0009 적용 → 민규 실DB 연결 → mock 사용자 제거** 후에만 배포한다. 그 전에는 `OPS_DATABASE_URL`을 `web.env`에 넣지 않으면 기능이 존재하지 않는다.

### 8.8 작업량

| # | 작업 | 크기 | 담당 | 단계 |
| --- | --- | --- | --- | --- |
| 1 | migration 0010 + schema.ts + journal + drift 후조건 + 테스트 | M | **나연** | 2a |
| 2 | `create-ops-role.sh` | S | **나연** | 2a |
| 3 | `ingest.sh` 활성 배치 보호 + 테스트 | S | **나연** (승석 확인) | 2a |
| 4 | `activate-batch.sh` | S | **나연** | 2a |
| 5 | `latestBatchSql.ts` 한 줄 + 테스트 1건 | S | 윤빈 | 2a |
| 6 | `api-contract.md` §8 갱신 | S | 윤빈 | 2a |
| 7 | env 검증기·테스트·`ENVIRONMENT_FILES.md` (`OPS_DATABASE_URL`) | S | 윤빈 (나연 승인) | 2b |
| 8 | `postgresOps.ts`, `databaseConfig.ts` | S | 윤빈 | 2b |
| 9 | 전환·해제·이력 API + RBAC | M | 미배정 + **민규** | 2b |
| 10 | 전환 UI + 사유 모달 + 전환 후 비교 자동 열기 | M | 미배정 | 2b |
| 11 | 배포 시 VM `web.env`에 키 추가 + `create-ops-role.sh` 실행 | S | 윤빈 (GCP) | 2b |

---

## 9. ML 파이프라인과의 맞물림 — 월간 운영 흐름

승석 관점에서 한 달이 어떻게 흐르는지. **굵은 글씨가 이 설계로 새로 생기는 지점**이다.

```text
① 새 국민연금 파일 → 같은 pkl 로 재채점 → CSV 3종 (outputs/)
② ingest.sh --as-of 2026-07 --model-version door1-voting-39f-v1 --model-sha <sha> \
             --expect-rows S,Q,F --canonical-timestamp <ts> --expected-database wageguard
   · 행수 단언 · risk_tier 계산 · 배치 행 기록                             (기존)
   · **활성 배치 재적재 차단 · "고정 중" 경고 출력**                         (2a)
③ 자동 규칙: 고정 없음 → 2026-07 이 즉시 서비스                            (기존)
   **고정 있음 → 서비스는 그대로, 2026-07 은 대기**                          (2a)
④ **/admin/batches 에서 2026-07 확인 → /compare?a=2026-06&b=2026-07**      (1, 1.5)
   · 큐 겹침·등급 이동·판정 이동이 기준선 띠 안인지
   · 띠 밖이면 → 승석 확인 → 필요시 **activate 2026-06 (롤백)**             (2a/2b)
⑤ health/ready 는 어느 배치든 **일관성만 검사** → 배포 정상                  (0)
```

**모델을 바꿀 때** (새 pkl, `model_version` 변경):

```text
① ingest --as-of 2026-06 --model-version door1-voting-41f-v2 --model-sha <new>
   → 같은 기준월에 두 버전 공존 (UNIQUE(as_of, model) 이 허용)
② 지금은 ingested_at 이 늦은 v2 가 **즉시 서비스됨** ← P4
   2a 이후: 적재 전에 **activate v1 (고정)** → v2 적재 → 서비스 불변
③ /compare?a=v1&b=v2 → 모드 "모델 A/B" → 큐 겹침·등급 이동으로 변화 파악
④ 승석 판단 → activate v2 (또는 deactivate 로 자동 복귀 = v2 가 최신 적재라 v2 서비스)
```

**계약 문서(`ML-DB-데이터계약.md`)에 추가할 항목**

| 항목 | 내용 |
| --- | --- |
| `--model-sha` 필수화 | 비교 모드 판정(§7.2 M0)에 필요. 없으면 "지문 없음" |
| 새 모델 적재 절차 | "적재 전에 현재 배치를 고정한다" 를 §운영 절차에 명시 |
| Q12 (승석) | 기준선 띠(§7.7)를 어떤 지표·어떤 폭으로 정할지 |
| Q13 (승석) | `reasons` 상위 사유의 순위 변동을 이상 신호로 볼 기준 |

---

## 10. 파일 변경 목록 (전체)

| 경로 | 단계 | 종류 | 담당 경로 소유 |
| --- | --- | --- | --- |
| `product/src/server/postgres.ts` | 0 | 수정 | 공통(윤빈) |
| `product/src/server/postgres.readiness.test.ts` | 0 | 수정 | 공통(윤빈) |
| `product/src/app/admin/batches/page.tsx` | 1 | 신규 | **미배정** |
| `product/src/app/admin/batches/compare/page.tsx` | 1.5 | 신규 | 미배정 |
| `product/src/components/admin/*.tsx` | 1, 1.5 | 신규 | 미배정 |
| `product/src/services/batchService.ts` (+test) | 1 | 신규 | 미배정 |
| `product/src/services/batchCompareService.ts` (+test) | 1.5 | 신규 | 미배정 |
| `product/src/app/api/admin/batches/route.ts` | 1 | 신규 | 공통(윤빈) 검토 |
| `product/src/app/api/admin/batches/compare/route.ts` | 1.5 | 신규 | 동일 |
| `product/src/app/globals.css` | 1 | 추가 | 수현 경로 [추정] |
| `product/docs/api-contract.md` | 1, 2 | 수정 | 윤빈 |
| `db/migrations/0010_batch_activation.sql` | 2a | 신규 | 나연 |
| `db/migrations/meta/_journal.json`, `db/schema.ts` | 2a | 수정 | 나연 |
| `db/scripts/check-migration-drift.mjs`, `migration-drift-core.mjs` | 2a | 수정 | 나연 |
| `db/tests/migration-drift.test.mjs` | 2a | 수정 | 나연 |
| `db/scripts/create-ops-role.sh` | 2a | 신규 | 나연 |
| `db/scripts/ingest.sh`, `db/tests/ingest-cli.test.mjs` | 2a | 수정 | 나연·승석 |
| `db/scripts/activate-batch.sh` | 2a | 신규 | 나연 |
| `db/README.md`, `db/docs/MIGRATION_OPERATIONS.md` | 2a | 수정 | 나연 |
| `product/src/server/latestBatchSql.ts`, `services/latestBatchSelection.test.ts` | 2a | 수정 | 공통(윤빈) |
| `infra/scripts/validate-service-envs.py`, `infra/tests/test_validate_service_envs.py`, `infra/systemd/ENVIRONMENT_FILES.md` | 2b | 수정 | 윤빈 (나연 승인) |
| `product/src/server/postgresOps.ts`, `databaseConfig.ts` | 2b | 신규/수정 | 공통(윤빈) |
| `product/src/app/api/admin/batches/[id]/activate/route.ts` 외 2 | 2b | 신규 | 미배정 + 민규 |

**PR 묶음 제안**

```text
PR-0   Phase 0 (윤빈)                       — 작고 독립. 먼저 병합
PR-1   Phase 1 화면 + API + 문서            — migration 없음
PR-1.5 비교 화면                            — PR-1 위에
PR-2a-db  0010 + 롤 + ingest 보호 + CLI (나연)  — 0009 병합 후, 별도 번호
PR-2a-app latestBatchSql 한 줄 (윤빈)       — PR-2a-db 배포 후
PR-2b  env 정책 + ops 모듈 + 전환 API/UI    — 실인증 후
```

---

## 11. 테스트 계획

| 단계 | 테스트 | 도구 | 무엇을 막나 |
| --- | --- | --- | --- |
| 0 | readiness SQL이 날짜 상수를 포함하지 않고 `INTERVAL '6 months'`를 포함 | vitest | 하드코딩 재발 |
| 1 | `batchService`가 상수를 사용하고 NULL 기준월을 `current`에서 제외 | vitest (mock) | 규칙 이중화 |
| 1 | API 404/503 매핑 | vitest | — |
| 1.5 | `a=b`, 비정수, 존재하지 않는 id → 400 | vitest | — |
| 1.5 | 모드 판정 4분기 (같은 sha/다른 as_of 등) | vitest 순수 함수 | 해석 오류 |
| 1.5 | 캐시 키에 `ingested_at` 포함 | vitest | 재적재 후 stale |
| 1.5 | 비교 SQL 전부 `assertSelectOnly` 통과 | vitest | 쓰기 단어 혼입 |
| 2a | CI 빈 PG16: 0000~0010 적용 + drift `aligned` | ci.yml 기존 | C3 |
| 2a | 활성 0개일 때 `v_current_batch` = 0008 결과와 동일 (semantic gate 스크립트에 케이스 추가) | pg16.sh | 하위 호환 |
| 2a | 활성 2개 INSERT 시도 → 유니크 위반 | pg16.sh | 상태 깨짐 |
| 2a | `activate_batch`: 없는 id·NULL 기준월·행수 0 → 예외, 멱등 | pg16.sh | — |
| 2a | `ingest.sh` 활성 배치 재적재 → 중단, `--replace-active` → 진행 | ingest-cli.test | C6 |
| 2a | `latestBatchSelection.test.ts` 기존 4건 무수정 통과 + 1건 추가 | vitest | C4 |
| 2b | `web.env`에 `OPS_DATABASE_URL`이 `wg_bot`·admin 사용자면 실패, `wg_ops`면 통과 | unittest | C1·C2 |
| 2b | 전환 API: 비로그인 401, user 403, admin 200, cross-origin 403 | vitest | RBAC |
| 2b | `postgresOps`가 두 함수 외 export 없음 | vitest (import 검사) | 쓰기 경로 확산 |

---

## 12. 롤아웃과 롤백

| 단계 | 롤아웃 | 롤백 |
| --- | --- | --- |
| 0 | 앱 배포만 | 코드 revert |
| 1, 1.5 | 앱 배포만. 화면이 하나 늘 뿐 | 코드 revert |
| 2a | ① DB dump ② `create-ops-role.sh` ③ 0010 적용 ④ drift `aligned` 확인 ⑤ 앱 배포(상수) | ③까지: 활성 0개면 동작 동일. 앱은 이전 상수로 revert 가능(컬럼이 남아도 무해). 0010 자체 되돌림은 forward migration 0011로 |
| 2b | ① `web.env` 키 추가 + 검증기 통과 ② 앱 배포 | 키 제거 → 기능 사라짐 (코드 revert 불필요) |

---

## 13. 결정 필요 항목

| # | 항목 | 결정자 | 언제 |
| --- | --- | --- | --- |
| D1 | `app/admin/**`·`components/admin/**` 담당자 | 팀장 | Phase 1 착수 조건 |
| D2 | Phase 0을 이번 주에 넣을지 (승석 다음 적재 전) | 팀장 + 나연 | 이번 주 |
| D3 | 0010을 0009 직후 별도 PR로 낼지 | 나연 | 0009 병합 후 |
| D4 | 2b 정책 A(권고) / C | **나연** + 팀 | 회의 |
| D5 | 전환 권한 admin만 / admin+inspector | 팀 | 회의 |
| D6 | 기준선 띠 지표·폭 | **승석** | Phase 1.5 |
| D7 | `--model-sha` 필수화 | 승석 | 계약 문서 회신 |
| D8 | readiness에서 "정확한 배치 핀"을 포기하는 것 | 나연 | Phase 0 |

---

## 14. 위험

| # | 위험 | 가능성 | 완화 |
| --- | --- | --- | --- |
| R1 | 0010 적용 전 앱이 먼저 배포되어 `is_active` 없음 → 전 화면 503 | 낮음 | drift pending이면 배포 중단(기존 규칙). 체크리스트에 명시 |
| R2 | 고정을 걸어두고 잊어 새 배치가 계속 대기 | 중간 | 현황 화면 상단에 "고정 중 · n일 경과" 경고. `ingest.sh` 경고 출력. 이력에 사유 |
| R3 | 비교 쿼리가 15초 초과 | 중간 | `detail` 분리 + 캐시. 실측 후 미리계산 저장으로 전환 |
| R4 | `wg_ops` 비밀번호 유출 | 낮음 | 피해 범위 = 배치 전환 2함수. 이력 남음. 비밀번호 교체로 회수 |
| R5 | Mock admin으로 전환 버튼 접근 | — | 2b는 실인증 전 배포 금지. env 키 없으면 기능 부재 |
| R6 | `model_sha` NULL로 모드 판정 불가 | 높음(현재) | 화면 경고 + 계약 문서에 필수화 |
| R7 | 비교 화면에서 등급을 구직자 문맥으로 오해 | 중간 | 화면 상단 "감독관·운영자 전용, 구직자 화면과 무관" 고정 문구. 개별 사업장 목록은 역할 제한 |
| R8 | Path B 재구축 시 0010이 섞여 검증 실패 | 낮음 | Path B는 0008까지만 적용하는 별도 절차. 0010은 forward migration. `PATH_B_REBUILD.md`에 한 줄 추가 |
| R9 | `ingested_at`이 운영자 입력값이라 동률 정렬이 조작 가능 | 낮음 | 2a 이후엔 고정이 우선하므로 영향 축소. `--canonical-timestamp` 규칙은 기존 문서대로 |

---

## 15. 브리핑용 요약 (회의 슬라이드)

```text
무엇       ML 배치를 화면에서 보고(1) · 비교하고(1.5) · 고를 수 있게(2)

왜         새 배치가 검토 없이 즉시 서비스되고, 되돌릴 수단이 재적재뿐
           무엇이 서비스 중인지 DB 에 붙어야 알고, 모델 비교 수단이 없음

먼저       health/ready 가 2026-06 배치에 고정 → 다음 배치부터 배포 실패
           → Phase 0 로 이번 주 정리 (승석 다음 적재 전)

쉬운 이유   최신 배치 규칙이 상수 1개 — WHERE 한 줄 넓히면 5개 화면이 따라옴
           CI·drift·테스트가 규칙 문자열을 단언하므로 ORDER BY 는 안 건드림

어려운 이유 웹은 3겹으로 쓰기 차단 (LLM 인젝션 방어) → 풀지 않음
           전환은 별도 롤 wg_ops + DB 함수 2개 + 이력 테이블로
           "화면 버튼"은 env 정책 예외가 필요 → 나연 합의 후 (그 전엔 CLI)

비교 화면   라벨 없이도 "얼마나 달라졌나"는 정확히 냄
           큐 겹침·등급 이동·판정 이동·사유 변동 — 기존 7개 배치로 정상 띠를 만듦
           평균 점수·확률은 절대 안 냄 (risk_full 은 확률이 아님)

의존       나연 0009 → 0010 → wg_ops → CLI 전환   (2a)
           + 민규 실인증 → env 정책 → 화면 전환    (2b)

결정       admin 경로 담당자 · 2b 정책 A/C · 기준선 띠 (승석)
```

---

## 부록 A. 용어

| 용어 | 뜻 |
| --- | --- |
| 배치(batch) | ML이 한 번 채점해 낸 결과 묶음. `as_of_date`(기준월)+`model_version`으로 구분됨 |
| 기준월 `as_of_date` | 관측창의 마지막 달(t−6). "이 달까지의 데이터로 채점했음" |
| 예측 대상월 `target_month` | 기준월+6개월. "이 달에 명단공개될 위험을 예측함" |
| 고정(pin) / 활성 `is_active` | 운영자가 "이 배치를 서비스하라"고 명시한 상태. 없으면 자동 규칙 |
| forward migration | 기존 파일은 안 고치고 새 번호 파일만 추가하는 DB 변경 방식 |
| drift 검사 | 저장소의 migration 목록과 DB 실제 상태가 같은지 배포 전에 확인하는 것 |
| Path B | 빈 DB에 0000~0008을 적용해 정본을 새로 만드는 절차. 운영 DB 변경과 별개 |
| `wg_bot` / `wg_ops` | 앱이 DB에 접속할 때 쓰는 계정. bot=읽기 전용, ops=배치 전환 함수만 |
| SECURITY DEFINER | 함수를 호출자가 아니라 **함수 소유자 권한으로** 실행하는 PostgreSQL 옵션 |
| 부분 유니크 인덱스 | 조건(`WHERE is_active`)을 만족하는 행만 유일하게 강제하는 인덱스 → 활성 최대 1개 |
| 스피어만 상관 ρ | 두 순위 목록이 얼마나 같은 순서인지 (1=동일, 0=무관) |
| lift | 무작위 대비 몇 배 잘 맞히는지. ML팀 실측값, DB에서 재계산 불가 |
| 기준선 띠 | 과거 배치 쌍에서 계산한 "정상 변동 범위". 새 배치가 이 밖이면 경고 |

## 부록 B. 검증에 사용한 명령 (재현용)

```bash
# 규칙 사용처
grep -rn "LATEST_BATCH_ORDER_SQL" product/src --include='*.ts'
grep -rn "v_current_" product/src --include='*.ts'          # → 0건 (앱은 뷰 미사용)
# 단언 3곳
grep -n "ORDER BY as_of_date DESC" product/src/services/latestBatchSelection.test.ts
grep -n "uses_deterministic_tiebreakers" db/scripts/check-migration-drift.mjs
grep -n "= 553598" product/src/server/postgres.ts product/src/server/postgres.readiness.test.ts
# env 정책
grep -n "reject_unknown\|read-only bot URL\|DB/bootstrap credentials" infra/scripts/validate-service-envs.py infra/tests/test_validate_service_envs.py
# 배포 readiness 대기
sed -n 944,956p infra/scripts/install-systemd-units.sh
# 재적재 동작·FK
sed -n 300,304p db/scripts/ingest.sh; grep -n "batch_id_batches_id_fk" db/migrations/0000_init.sql
# Path B 검증 범위
sed -n 118,130p db/scripts/sql/assert-path-b-rebuild.sql
```
