# ML 대시보드가 비어 있을 때 — 무엇을 어디에 넣어야 하나

> 작성 2026-09-19 · 근거: `product/src/services/mlDashboardService.ts`, `db/migrations/**`,
> `db/scripts/ingest.sh`, `db/scripts/ingest-industrial-safety.sh` 실제 코드

시연 서버에서 ML 대시보드가 `사업장 데이터베이스를 읽지 못했습니다.` 만 보여준다.
이 문서는 **그 화면에 숫자가 뜨려면 무엇이 어디에 있어야 하는지**를 적는다.

---

## 1. 화면이 실제로 읽는 것

`mlDashboardService.ts` 가 읽는 관계는 다섯이다. 하나라도 없거나 권한이 없으면
전체가 `503` 이 된다 — `queryReadOnly` 가 모든 실패를 한 문구로 뭉뚱그리기 때문이다.

| 탭 | 읽는 관계 | 만드는 곳 |
| --- | --- | --- |
| 임금체불 | `public.v_region_industry_signal` | `db/migrations/0012_v_region_industry_signal.sql` |
| 임금체불 | `public.batches` | `0004` 이후 · `ingest.sh` 가 행을 넣는다 |
| 산업재해 | `industrial_safety.v_llm_firm_safety_context` | `db/migrations/0004_industrial_safety.sql` |
| 산업재해 | `public.v_current_scored` | `db/migrations/0007_current_batch_views.sql` |
| 공통 | `public.firms` | `0004`·`0005` |

읽는 계정은 **`BOT_DATABASE_URL`(= `wg_bot`, 읽기 전용 롤)** 이다.
`getDatabaseConnectionString()` 이 `BOT_DATABASE_URL` → `DATABASE_URL` 순으로 고른다.

---

## 2. 원인은 셋 중 하나다

서버에서 아래를 돌리면 어느 쪽인지 한 번에 갈린다.

```bash
# ① 무엇이 터졌는지 — 진짜 원인은 여기에만 남는다
sudo journalctl -u moneyworry-web -n 120 --no-pager \
  | grep -iE "relation|permission|denied|does not exist|error"

# ② 다섯 관계가 존재하고 wg_bot 이 읽을 수 있는가
sudo docker exec moneyworry-production-db-1 psql -U pathb_admin -d wageguard -c "
SELECT n.nspname || '.' || c.relname AS relation,
       has_table_privilege('wg_bot', c.oid, 'SELECT') AS wg_bot_can_read
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE (n.nspname, c.relname) IN (
   ('public','v_region_industry_signal'),
   ('public','v_current_scored'),
   ('public','firms'),
   ('public','batches'),
   ('industrial_safety','v_llm_firm_safety_context'))
 ORDER BY 1;"

# ③ 데이터가 실제로 들어 있는가
sudo docker exec moneyworry-production-db-1 psql -U pathb_admin -d wageguard -c "
SELECT (SELECT count(*) FROM public.batches)  AS batches,
       (SELECT count(*) FROM public.firms)    AS firms;"
```

| 증상 | 원인 | 담당 |
| --- | --- | --- |
| ②에서 **행이 빠짐** | migration 미적용. 특히 `0012` 가 최근 것이라 누락되기 쉽다 | 나연 (적용) · 승석 (정의) |
| ②에서 `wg_bot_can_read = f` | `GRANT SELECT` 누락. `0009` 주석에 *"DROP VIEW 는 GRANT 도 함께 지운다"* 는 경고가 이미 있다 | 나연 |
| ③에서 `batches = 0` | ML 산출물이 아직 적재되지 않았다 | 승석·윤빈 (아래 3절) |
| 위 셋 다 정상인데 503 | `BOT_DATABASE_URL` 미설정·오설정 | 민규 (`server/databaseConfig.ts`) · 팀장 (`/etc/moneyworry/web.env`) |

### migration 적용 상태 확인

```bash
sudo docker exec moneyworry-production-db-1 psql -U pathb_admin -d wageguard -c \
  "SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;"
```

`0012_v_region_industry_signal` 이 목록에 없으면 임금체불 탭은 절대 뜨지 않는다.

---

## 3. ML 쪽은 무엇을 어디에 내야 하나

두 갈래가 완전히 다르다. **같은 스크립트가 아니다.**

### 3-1. 임금체불 — `db/scripts/ingest.sh`

제출물은 **디렉터리 하나**이고 그 안에 CSV 3종이 있어야 한다.
규격은 `docs/mlops/ml-db-data-contract.md` 가 정한다.

```text
<제출 디렉터리>/
  scored_active_full.csv          필수
  감독관_위험큐_full.csv           필수   ← 파일 이름이 한글이다. 그대로 써야 한다
  safe_recommendation_full.csv    필수
  manifest.json                   권장
```

적재는 이렇게 부른다.

```bash
db/scripts/ingest.sh \
  --outputs <제출 디렉터리> \
  --model-version <모델 레시피 이름> \
  --as-of YYYY-MM \
  --expect-rows <scored>,<queue>,<safe> \
  --env-file <DB 키 파일> \
  --expected-database <DB 이름> \
  --canonical-timestamp <RFC3339 UTC>
```

`--expect-rows` 는 선택이 아니다. 계약 문서가 기록한 사고가 여기서 나왔다 —
식별키를 이름으로 만들어 **사업장 168곳이 조용히 병합돼 175행이 사라졌고**,
로그에는 "적재 완료" 만 남았다. 행수를 미리 적어 두면 그 사고가 즉시 드러난다.

적재가 끝나면 `public.batches` 에 행이 하나 생기고, `v_current_scored`·
`v_region_industry_signal` 이 그 배치를 가리킨다. **화면은 그때부터 뜬다.**

### 3-2. 산업재해 — `db/scripts/ingest-industrial-safety.sh`

CSV 가 아니라 **SHA 로 고정된 아티팩트 레지스트리**를 받는다.

```bash
db/scripts/ingest-industrial-safety.sh --validate-only --scope full   # 먼저 검증만
db/scripts/ingest-industrial-safety.sh --apply --confirm-apply industrial_safety.v1.0
```

`--config` 로 넘기는 레지스트리가 아티팩트 경로와 해시를 담는다.
승인 문자열(`industrial_safety.v1.0`)을 손으로 적게 한 것은 실수로 적용되는 것을
막기 위해서다.

---

## 4. 그래서 순서

1. **②를 돌려 관계와 권한부터 확인한다.** migration 누락이면 데이터를 아무리 넣어도 안 뜬다
2. 관계가 멀쩡하면 **③으로 데이터 유무를 본다**
3. `batches = 0` 이면 3-1 로 임금체불 결과를 적재한다
4. 산재 탭은 3-2 가 따로 필요하다

시연까지 시간이 없다면 **임금체불 탭 하나만 살려도 화면은 채워진다.** 산재 탭은
`v_llm_firm_safety_context` 가 없으면 그 탭만 비고 임금체불 탭은 정상 동작한다.

---

## 5. 별건 — 오류 문구가 원인을 감춘다

`product/src/server/postgres.ts` 가 모든 DB 실패를 한 문구로 바꾼다.

```ts
throw new ServiceError("DATABASE_UNAVAILABLE", "사업장 데이터베이스를 읽지 못했습니다.", 503, true);
```

화면에는 이대로 두는 것이 맞다 — 방문자에게 관계 이름을 보일 이유가 없다.
다만 **서버 로그에는 실패한 관계 이름이 남아야 한다.** 지금은 남지 않아서
①을 돌려도 아무것도 안 나올 수 있다. 시연 뒤 과제로 남긴다.
