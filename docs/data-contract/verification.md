# 데이터 계약 실측 검증

- 대상 DB: 운영 PostgreSQL 16 (Path B 복원본)
- 대조 대상: [`wage-risk.md`](wage-risk.md) · [`safety-risk.md`](safety-risk.md) · [`README.md`](README.md) · [`aggregation-spec.md`](aggregation-spec.md)

### 검증 회차

| 회차 | 일시 (KST) | 범위 | 결과 |
| --- | --- | --- | --- |
| 1 | **2026-08-31 16:00** | 계약 수치 · API 표시 | 수치 불일치 0 · 표시 위반 1 (9.3절) |
| 2 | **2026-09-03** | SHAP 피처 39종 대조 | 13절 |
| 3 | **2026-09-06** | 판정 규칙 반례 검사 | 14절 |
| 4 | **2026-09-09** | 피처 단위·스케일 · 집계 축 · `g5` 경계 | 15절 |

> 2~12절은 **1회차(2026-08-31)** 기록이다. 이후 회차는 13절부터 이어 적는다.

> 계약 문서에 적힌 수치가 실제 DB와 같은지(2~8절), 그리고 실제 API 응답이 계약대로
> 표시되는지(9절) 확인한 기록이다.
> 모든 항목에 **재현 명령**을 붙였다. 같은 명령으로 같은 값이 나와야 한다.
> 값이 달라졌다면 배치가 바뀐 것이므로 **계약 문서와 이 파일을 함께 갱신**한다.

---

## 1. 기준점

```
batch 7   as_of_date = 2026-06-01   target_month = 2026-12-01
          n_scored = 553,598   n_safe = 503,887   n_queue = 3,000
```

`as_of_date`(관측 기준)와 `target_month`(예측 대상)는 **다른 값이다.**
섞어 쓰지 않는다 — `wage-risk.md` 6절 참조.

## 2. 총계

| 대상 | 문서 | 실측 | |
| --- | ---: | ---: | :-: |
| `public.firms` | 639,137 | 639,137 | ✅ |
| `public.scored_active` | 3,855,848 | 3,855,848 | ✅ |
| `public.safe_recommendation` | 3,524,726 | 3,524,726 | ✅ |
| `public.inspector_queue` | 21,000 | 21,000 | ✅ |
| `industrial_safety.firm_risk_results` | 515,608 | 515,608 | ✅ |
| `public.users` / `posts` / `comments` / `reviews` | 0 | 0 | ✅ |

> ⚠️ **`firm_risk_results` 는 `public` 이 아니라 `industrial_safety` 스키마다.**
> 스키마를 빼고 조회하면 `relation does not exist` 가 난다.

마지막 행의 `0` 은 결함이 아니라 **Path B 계약**이다. 이 재구축 범위에 UGC는 포함되지 않는다.

## 3. 사용자 경로 — `safe_recommendation.판정`

최신 배치(`v_current_safe`, 503,887행)

| 판정 | 건수 | 비중 | `SignalLevel` |
| --- | ---: | ---: | --- |
| `유보` | 431,646 | 85.66% | `watch` |
| `안정신호` | 32,613 | 6.47% | `normal` |
| `배제_4대보험체납(door1)` | 20,863 | 4.14% | `review` |
| `유보_정보부족` | 17,530 | 3.48% | `unknown` |
| `배제_공개체납` | 1,102 | 0.22% | `review` |
| `배제_임금체불공개` | 133 | 0.03% | `review` |

**정합 확인**: 합계 **503,887 = `batches.n_safe`** ✅

`배제_` 3종 합계는 4.39% 다. `배제_` **접두 판정은 `VERDICT_META` 조회보다 먼저** `review` 로
확정된다 — `MlRiskProvider.ts:79`.

## 4. 감독관 경로 — `scored_active.risk_tier`

최신 배치(`v_current_scored`, 553,598행)

| tier | 건수 | 비중 | `is_prediction` |
| --- | ---: | ---: | :-: |
| `일반` | 453,377 | 81.90% | true |
| `정보부족` | 49,703 | 8.98% | **false** |
| `다소높음` | 40,301 | 7.28% | true |
| `높음` | 7,557 | 1.37% | true |
| `매우높음` | 2,519 | 0.46% | true |
| `이미공개` | 141 | 0.03% | **false** |

**정합 확인**: 합계 **553,598 = `batches.n_scored`** ✅

> 🔴 `risk_tier` 는 **감독관 전용**이다. 구직자 화면에 노출하지 않는다(명예훼손 리스크).
> 3절의 `판정` 과 **모집단·기준이 다르다.** 같은 단어로 부르지 않는다.

> ⚠️ **`정보부족` 과 `risk_full` NULL 은 같은 집합이 아니다** **[실측 2026-08-31]**
>
> ```
> risk_full IS NULL   49,711  =  정보부족 49,703  +  이미공개 8
> 정보부족 중 risk_full 값이 있는 행 : 0
> ```
>
> **포함 관계는 한 방향이다** — `정보부족` ⊂ `risk_full IS NULL`.
> 백분율만 보면 둘 다 8.98% 라 같아 보이지만(8.9782% vs 8.9796%),
> **`이미공개` 141행 중 8행이 채점되지 않은 상태**라 행수는 다르다.
> 5절의 NULL 8.98% 는 **49,711 기준**이다.

## 5. 주의값

| 값 | 실측 | 해석 |
| --- | ---: | --- |
| `risk_calibrated` non-NULL | **0 / 3,855,848** | 전 행 NULL. 결함이 아니라 **"아직 확률로 말할 수 없다"** 는 표시 |
| `risk_full` NULL 비율 | **8.98%** (49,711 / 553,598) | 채점 불가. **`0` 과 다르다** |
| `biz_no` 최대 재사용 | **950곳** | 마스킹 6자리라 **비고유**. 식별키로 쓰지 않는다 |

> `risk_full` 은 **확률이 아니다.** 1:1 다운샘플링 결과이므로 순위·분위·등급으로만 해석한다.

## 6. 산업재해

### 밴드 분포 — `industrial_safety.firm_risk_results` (515,608행)

| `provisional_population_priority_band` | 건수 | `SignalLevel` |
| --- | ---: | --- |
| `일반` | 464,018 | `normal` |
| `상위10%` | 25,690 | `watch` |
| `상위5%` | 20,739 | `review` |
| `상위1%` | 5,161 | `review` |

**정합 확인**: 합계 **515,608 = `firm_risk_results` 행수** ✅

> **구간은 배타적이다.** `상위5%` 는 "상위 5% 이내"가 아니라 **상위 1%를 제외한 1~5% 구간**이다.

### ⚠️ `v_firm_accident_risk` 는 0행이다

| 뷰 | 행수 |
| --- | ---: |
| `v_llm_firm_safety_context` | **515,608** |
| `v_firm_accident_risk` | **0** |

**결함이 아니라 Path B 복원 범위다.** 이 뷰는 `workplace_predictions` 와 `firm_links` 를
조인하는데 둘 다 0행이고, `pipeline_runs` 에 `workplace_prediction`·`firm_link` 실행이 없다
(있는 것은 `cell_label`·`cell_prediction`·`firm_risk`).

**앱은 `v_llm_firm_safety_context` 를 읽으므로 영향이 없다** — `MlRiskProvider.ts:208`.
**뷰가 비었다고 "산업재해 데이터가 없다"고 말하면 안 된다.**

## 7. 운영 DB에 스키마 주석이 없다

```
pg_description (public + industrial_safety) : 0건
```

저장소 마이그레이션에는 `COMMENT ON` 이 있으나 release dump 가 `--no-comments` 로
생성돼 **운영 DB에는 하나도 반영되지 않았다.** `README.md` 미해결 1번.

**이 계약 문서가 인용하는 DB 주석은 저장소 마이그레이션 기준이다.** 운영 DB를 조회해
확인하려 하면 빈 결과가 나온다.

## 8. 코드 대조 — `product/src/adapters/real/MlRiskProvider.ts`

| 계약 문서 서술 | 코드 위치 | |
| --- | --- | :-: |
| 임금체불은 `public.scored_active`·`safe_recommendation` **직접 조회** (뷰 아님) | `:259` `:261` LEFT JOIN | ✅ |
| 산업재해는 `v_llm_firm_safety_context` **만** 사용 | `:208` FROM | ✅ |
| `배제_` 접두가 `VERDICT_META` 조회보다 **먼저** 적용 | `:79` `startsWith("배제_")` | ✅ |
| `안정신호`→`normal` · `유보`→`watch` · `유보_정보부족`→`unknown` | `VERDICT_META` | ✅ |

## 9. 표시 검증 — 실제 API 응답

**2026-08-31 16:2x KST**, 서버 내부(`127.0.0.1:3111`)에서 **6개 판정 상태 × 2개 라우트 = 12건**
호출. 전부 HTTP 200. 인증 없으면 401.

```
구직자   GET /api/companies/{firm_id}/risk
감독관   GET /api/inspector/companies/{firm_id}
```

### 9.1 구직자 라우트 — 통과

| 검증 | 결과 |
| --- | :-: |
| `판정` → `SignalLevel` 매핑 6상태 | `배제_*`→`review` · `안정신호`→`normal` · `유보`→`watch` · `유보_정보부족`→`unknown` ✅ |
| `risk_tier`·`risk_full`·`shap_value`·`percentile`·`raw_probability` 노출 | **0건** ✅ |
| 영문 원본 피처명 노출 | **0건** ✅ |
| 기준일 `data_as_of`·`target_month` | 6상태 전부 존재 ✅ |
| `sources[]` | 6상태 전부 2건, 모두 `organization`·`as_of` 보유 ✅ |
| `valid_until` | 6상태 전부 `null` — [`samples/`](samples/) 와 일치 ✅ |
| `unknown` 이 `normal` 로 바뀌지 않음 | `유보_정보부족` → `unknown` 유지 ✅ |

### 9.2 감독관 라우트 — 원점수 처리는 적절

`model_score` 로 원점수가 나가지만 **확률로 오해되지 않도록 방어돼 있다.**

```json
"grade": "긴급",
"model_score": 0.990447,
"score_interpretation": "relative_model_score_not_probability",
"rank": 1
```

`limitations[]` 3개가 함께 나간다 —
*"모델 원점수는 실제 임금체불 확률이 아니며 순위·분위·등급으로만 해석합니다."* 등 ✅

> ⚠️ **API 키 이름이 DB 컬럼과 다르다.** 문자열 검사로 점검할 때 놓치기 쉽다.
>
> | API 키 | DB 컬럼 |
> | --- | --- |
> | `wage_risk.grade` | `inspector_queue.queue_priority` (wage-risk.md 4.5절) |
> | `wage_risk.model_score` | `scored_active.risk_full` |
> | `industrial_safety.priority_band` | `provisional_population_priority_band` |

`grade` 값 4종과 건수는 [**`wage-risk.md` 4.5절**](wage-risk.md) 표와 일치한다 — 긴급 100 · 우선 400 · 주의 1,000 · 관찰 1,500.

### 9.3 🔴 위반 1건 — 감독관 `reasons` 에 영문 원본명이 그대로 나간다

큐 1순위 사업장의 실제 응답:

```json
"reasons": ["체납액", "imputed_months_count", "door1_maxmonths"]
```

**3개 중 2개가 영문 원본 피처명이다.** 감독관 화면에 그대로 표시되면
`imputed_months_count` 라는 변수명을 사람이 읽게 된다.

[`wage-risk.md` 4.6절](wage-risk.md)의 표시 규칙 1번 —
*"영문 원본명을 화면에 그대로 노출하지 않는다"* — 을 **API가 지키지 않고 있다.**

| 필요한 조치 | 담당 |
| --- | --- |
| 영문 11종의 정의·산출식 제공 (저장소에 없음) | 모델 담당 |
| 한글 라벨 확정 | 정보설계 담당 |
| 라벨 매핑을 API 또는 화면에 적용. 라벨 없으면 `사유 확인 필요` | 화면 담당 |

> `product/src/**` 는 담당 경로 밖이라 **이 문서는 사실만 기록한다.** 코드는 고치지 않았다.

## 10. 복구·재적재 후 계약 확인 체크리스트

DB를 복원하거나 배치를 재적재한 뒤 **계약이 여전히 성립하는지** 확인하는 목록이다.

### 10.1 이미 자동으로 검사되는 것 — 다시 하지 않는다

`db/scripts/sql/assert-path-b-rebuild.sql`(1,214줄)이 **행수를 하드코딩해 단언**한다.
`bootstrap-path-b.sh` · `export-path-b-release.sh` · `verify-path-b-release-restore.sh`
세 곳에서 호출된다.

```
firms 639,137 · scored_active 3,855,848 · safe_recommendation 3,524,726
inspector_queue 21,000 · firm_risk_results 515,608
batch 7 (553,598 / 3,000 / 503,887) · cell 92,140 / 184,280
```

**행수가 틀리면 복구 스크립트가 이미 멈춘다.** 아래는 그 다음 단계다.

### 10.2 자동 검사되지 않는 것 — 이 체크리스트의 대상

> **행수가 맞아도 의미가 깨질 수 있다.** 예컨대 553,598행이 그대로인데 판정이 전부
> `유보` 로 쏠렸다면 위 단언은 **통과한다.** 화면은 조용히 잘못된 값을 보여준다.

| # | 확인 | 통과 기준 | 근거 절 |
| ---: | --- | --- | :-: |
| 1 | 판정 6종이 **모두 존재**하는가 | 한 종류라도 0이면 이상 | 3 |
| 2 | 판정 합계 = `batches.n_safe` | 정확히 일치 | 3 |
| 3 | `유보` 비중이 크게 변했는가 | 85.66% 대비 급변 시 조사 | 3 |
| 4 | tier 6종이 **모두 존재**하는가 | 한 종류라도 0이면 이상 | 4 |
| 5 | tier 합계 = `batches.n_scored` | 정확히 일치 | 4 |
| 6 | `risk_calibrated` 가 여전히 **전 행 NULL** | 값이 생겼다면 **확률 해석이 가능해졌다는 뜻** — 계약 문서를 고쳐야 한다 | 5 |
| 7 | `risk_full` NULL 비중 | 8.98% 대비 급변 시 조사 | 5 |
| 8 | `정보부족` ⊂ `risk_full IS NULL` 포함 관계 | **`정보부족` 중 `risk_full` 값이 있는 행 = 0.** 1행이라도 생기면 채점 로직 변경 | 4·5 |
| 9 | 밴드 4종 합계 = `firm_risk_results` 행수 | 정확히 일치 | 6 |
| 10 | `reasons` 배열 길이가 항상 3 | `min = max = 3` | wage-risk 4.6 |
| 11 | `reasons` 의 distinct 피처 목록이 늘었는가 | 새 영문명이 생기면 **라벨 없는 사유가 화면에 뜬다** | wage-risk 4.6 |
| 12 | `biz_no` 최대 재사용 수 | 950곳에서 증가 시 문서 갱신 | 5 |

### 10.3 확인 명령

11절의 재현 명령을 그대로 쓰되, 아래 두 개를 추가한다.

```sql
-- 8번: 정보부족이 risk_full NULL 에 온전히 포함되는가
select
  count(*) filter (where risk_tier = '정보부족' and risk_full is not null) as must_be_zero,
  count(*) filter (where risk_tier = '정보부족')                            as tier_null,
  count(*) filter (where risk_full is null)                                as full_null
from public.v_current_scored;
-- must_be_zero = 0 이어야 한다
-- 2026-08-31 기준: 0 / 49,703 / 49,711  (차이 8행은 '이미공개')
-- ⚠️ 두 count 가 같을 것이라고 가정하지 말 것. 백분율은 둘 다 8.98% 로 보인다

-- 10·11번: reasons 배열 길이와 피처 목록
select min(array_length(reasons,1)) as min_len,
       max(array_length(reasons,1)) as max_len,
       count(distinct r) as distinct_features
from public.inspector_queue, unnest(reasons) r
where reasons is not null;
-- min = max = 3, distinct = 20 (2026-08-31 기준)
```

### 10.4 담당 경로 밖 — 제안 항목

이 문서는 `docs/data-contract/**` 안이라 **아래는 기록만 한다.**

| # | 제안 | 왜 | 담당 |
| ---: | --- | --- | --- |
| 1 | `assert-path-b-rebuild.sql` 에 **10.2의 1·2·4·5·6·9번 단언 추가** | 행수만 보면 의미 붕괴를 못 잡는다 | DB 담당 |
| 2 | 감독관 응답의 `score_interpretation`·`limitations` **존재를 단언하는 테스트** 추가 | 현재 **테스트 0건**. 리팩터링으로 빠져도 아무도 모른다. 원점수만 남으면 확률처럼 읽힌다 | 인프라 담당 |
| 3 | [`samples/`](samples/) 5종을 인수 테스트 fixture로 연결 | 현재 참조 **0건**. 상태별 화면 검증에 그대로 쓸 수 있다 | QA 담당 |

> 2번 보충 — 구직자 경로는 이미 보호돼 있다.
> `integrationContract.test.ts:40-49` 가 판정 6종 → `SignalLevel` 매핑을,
> `:61` 이 `risk_full|probability|percentile|shap` 비노출을 검사한다.
> **비어 있는 쪽은 감독관 경로의 방어 문구다.**

## 11. 재현 명령

서버에서 실행한다. `wg_bot`(읽기 전용)으로도 대부분 확인할 수 있다.

```sql
-- 1절 기준점
select id, as_of_date, target_month, n_scored, n_safe, n_queue
  from public.batches order by as_of_date desc limit 1;

-- 2절 총계  (firm_risk_results 는 industrial_safety 스키마)
select count(*) from public.firms;
select count(*) from industrial_safety.firm_risk_results;

-- 3절 판정 분포 + 정합
select 판정, count(*) from public.v_current_safe group by 1 order by 2 desc;

-- 4절 tier 분포 + 정합
select risk_tier, count(*) from public.v_current_scored group by 1 order by 2 desc;

-- 5절 주의값
select count(risk_calibrated), count(*) from public.scored_active;
select count(*) filter (where risk_full is null) * 100.0 / count(*) from public.v_current_scored;
select max(c) from (select count(*) c from public.firms where biz_no is not null group by biz_no) s;

-- 6절 밴드
select provisional_population_priority_band, count(*)
  from industrial_safety.firm_risk_results group by 1 order by 2 desc;
select count(*) from industrial_safety.v_firm_accident_risk;      -- 0
select count(*) from industrial_safety.v_llm_firm_safety_context; -- 515,608

-- 7절 주석
select count(*) from pg_description d
  join pg_class c on c.oid = d.objoid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('public','industrial_safety');               -- 0
```

## 12. 불일치·미확인

### 12.1 DB 수치 대조 — 불일치 0건 ✅

2~8절의 모든 수치가 운영 DB와 일치했다. **계약이 기술한 값 자체는 정확하다.**

### 12.2 그 밖에 나온 것

| 구분 | 내용 |
| --- | --- |
| 🔴 표시 규칙 위반 1건 | 감독관 `reasons` 의 영문 원본명 노출 (9.3절). 수치 불일치가 아니라 **화면 표기 미확정** |
| 🔴 정책 미충족 1건 | `valid_until`·`freshness` 하드코딩으로 POL-11 유효기간 요건 불가 ([wage-risk.md 11.5절](wage-risk.md)) |
| 🟡 문서 자체 오류 6건 | 전수 정밀검토에서 발견·정정. 그중 하나는 **DB 의미에 대한 사실 오류**였다 (4절의 `정보부족` ⊄ `risk_full NULL`) |

> 마지막 항목이 중요하다. **DB 수치를 맞게 적어도 그 수치의 의미를 잘못 서술할 수 있다.**
> 백분율이 같다는 이유로 두 집합을 같다고 단정했었다.

### 12.3 미확인 — 다음 검증 대상

| 미확인 | 내용 |
| --- | --- |
| 산업재해 4상태 | 구직자 응답의 `safety_context` 는 `normal` 만 확인. 밴드별 상태 미검증 |
| 렌더링된 화면 | API 응답과 **화면 코드**는 봤으나 실제 렌더링 결과는 미확인 |
| 감독관 `reasons` 이후 | 피처 사전 확보 후 라벨 적용 결과 재검증 필요 |

> 이 문서에는 **실존 사업장명·`firm_id` 를 싣지 않는다.** 저장소가 공개다.
> 응답 형태는 [`samples/`](samples/) 의 `COMPANY_DEMO_*` 합성 식별자를 쓴다.

---

## 13. 2회차 (2026-09-03) — SHAP 피처 39종 대조

### 13.1 피처 사전과 DB 컬럼이 일치한다

```
문서 §4.6.1 피처 사전            39종
public.scored_active 컬럼        54개
  = 비피처 15 + 피처 39
문서에 있는데 DB에 없는 것        0건
```

**39종 전부 실재한다.** 재확인 2026-09-09.

### 13.2 `reasons` 에 나오는 피처는 20종뿐이다

`inspector_queue.reasons` 에 실제 등장한 피처는 20종이며, 그중 **11종이 영문 원본명**이다.
나머지 19종은 아직 상위 3에 든 적이 없다. 모델이 고정돼 있어 39종 밖은 나오지 않는다.

→ 위반 상세는 9.3절, 라벨화 요청은 `wage-risk.md` 11.6절.

---

## 14. 3회차 (2026-09-06) — 판정 규칙 반례 검사

`wage-risk.md` 3.1.1절의 규칙 6단계가 실제 데이터와 맞는지 반례를 셌다.
**모든 검사에서 반례 0건** [2026-09-06 · **2026-09-09 재확인**].

| 규칙 | 검사 내용 | 반례 |
| --- | --- | ---: |
| 1 | `체불배제` 인데 판정이 `배제_임금체불공개` 가 아닌 곳 | **0** |
| 2 | `체납배제`(체불 아님)인데 `배제_공개체납` 이 아닌 곳 | **0** |
| 3 | `door1_ever > 0`(배제 아님)인데 `배제_4대보험체납` 이 아닌 곳 | **0** |
| 4 | `안정신호` 인데 3조건을 다 만족하지 않는 곳 | **0** |
| 5 | `유보` 인데 `n_months < 8` 인 곳 | **0** |

### 14.1 규칙 우선순위 실증

두 배제 플래그가 **모두 참인 곳이 정확히 1곳** 있다.

```
 체불배제 | 체납배제 |       판정
 t        | t        | 배제_임금체불공개
```

**규칙 1이 규칙 2보다 먼저 걸린다**는 것이 실제 데이터로 확인된다.

### 14.2 `p10` 의 평가군 확정

`wage-risk.md` 3.1.1절이 「평가군 하위 10%」라고만 적어 모집단이 모호했다.
네 가지를 모두 재 보았다 [2026-09-09].

| 모집단 | 곳 | `p10` |
| --- | ---: | ---: |
| 전체 채점군 | 503,887 | 0.085733 |
| 배제 3종 제외 | 481,789 | 0.083720 |
| **배제 제외 + `n_months ≥ 8`** | **464,259** | **0.082370** |
| `안정신호` 의 실제 `risk_full` 상한 | 32,613 | **0.082370** |

**평가군 = 464,259곳**으로 확정. 마지막 두 줄이 소수점 6자리까지 일치한다.

### 14.3 🔴 감독관 큐 3,000곳에 `유보` 가 **0곳**이다

```
 배제_4대보험체납(door1)   2,067
 유보_정보부족               829
 배제_공개체납                95
 배제_임금체불공개             9
 ─────────────────────────────
 합계                      3,000

 유보                          0      ← 한 곳도 없다
 안정신호                      0
```

### 14.4 `유보` 의 위험등급 분포

```
 일반       409,164   94.8%
 다소높음    22,397    5.2%
 높음            85    0.0%
 매우높음         0    0.0%
```

> 🔴 **`유보` 85.7% 는 「위험이 발견된 집단」이 아니다.**
> 감독관 점검 대상 3,000곳에 한 곳도 들어가지 않았고, 위험등급도 94.8%가 `일반` 이다.
> 화면 문구가 「안전 신호 미확인」·회색으로 정해진 근거다 (2026-09-08 결정 1번).

---

## 15. 4회차 (2026-09-09) — 단위·스케일 · 집계 축 · `g5`

### 15.1 피처 값 단위·범위

| 컬럼 | 실측 | 확인된 것 |
| --- | --- | --- |
| `door1_maxamt` | 소수부 0건 · 0 제외 최솟값 **1,000** · 중앙값 2,509 · 최대 1,201,620 | **단위 만원** (1,000만원 = 체납 공개 기준선) |
| `log_emp_count` | 0.0000 ~ 11.7408 | `ln(x+1)` = `log1p` |
| `nf_bill_maxdrop` · `nf_drawdown` | 0.0000 ~ 1.0000 | 소수 비율. 금액 아님 |
| `emp_change_12m` | −1.0000 ~ **289.4** | 소수 비율이나 **상한 없음** |
| `turnover_momentum` | 0.0000 ~ 401.5 | 배수 |
| `imputed_ratio` | 역산 분모 11.98 ~ 12.05 | **분모 12** |
| `door1_ever`·`door1_health`·`has_missing_recent_3m` | 2종 `0~1` | 0/1 |
| `door1_n_insu` | 4종 `0~3` | 0~3 |

### 15.2 ✅ 관측창 구조 확정 — 달력 13개 시점 · 계수기 상한 12

**2026-09-10 모델 담당 재회신으로 확정**되었고, 실측이 이를 뒷받침한다.

창 길이 `[t-18, t-6]` **13개 시점**은 세 출처가 일치한다
(`migration 0003` · 계약 문서 §6.2 · 모델 담당 회신).

계수기 상한이 12인 이유는 **컬럼마다 다르다.**

| 컬럼 | 이유 | 실측 범위 |
| --- | --- | --- |
| `n_months` | **별도 창** — 최근 12개월 green 창 `[t-17, t-6]` | 1 ~ 12 |
| `zero_emp_months` | 채점 대상은 마지막 달에 항상 활성 → 그 달은 0 불가 | 0 ~ 12 |
| `imputed_months_count` | 같은 이유 + 채점 게이트 | 0 ~ **7** |
| `salary_drop_consecutive` | 13개 시점의 인접 비교가 12번 | 0 ~ 12 |
| 평균·비율류 | 계수기가 아님. 13개 값을 씀 | — |

#### 실측이 구조를 뒷받침한다

```
n_months + imputed_months_count  =  12 (460,793곳)  또는  13 (43,094곳)
                                     imputed 최소 0      imputed 최소 1
```

green 창 12 · risk 창 13이면 이 합은 **`12 + (t-18 이 결측인가)`** 여야 한다.
**정확히 그대로다.** 어제 「일관되지 않다」고 적었던 현상이 구조로 설명된다.

#### 🔴 채점 게이트는 `n_months` 가 아니다

| 이전 이해 | 실제 |
| --- | --- |
| `n_months ≥ 6` 이면 채점 | **13개월 risk 창 관측 ≥ 6** 이면 채점 |

**`n_months = 5` 인데 채점된 915곳** [실측]

```
915곳 전부 imputed_months_count = 7  →  risk 창 관측 = 13 − 7 = 6  →  게이트 통과
그중 5개월만 green 창에 들어가 n_months = 5 로 찍힌 것
예외 0건
```

게이트를 뒤집어 보면 **`imputed ≤ 7`** 이다. 실측이 맞물린다.

```
채점군    imputed 최대 7 · 7 초과 0건
미채점    imputed 전부 NULL (보정 시도 자체가 없음)
```

### 15.3 🔴 `g5_업력3년` 경계는 38개월이다

```
 g5_업력3년 | 업력 최소 | 업력 최대 |   건수
 false      |       0.0 |      37.0 |  77,311
 true       |      38.0 |     461.0 | 426,576

배치 as_of 2026-06 − 코드 고정 기준일 2023-04 = 38개월
```

굴러가는 3년이면 36이어야 한다. 상세는 `wage-risk.md` 11.7절.

### 15.4 `n_green` 은 `g1~g6` 참 개수와 일치한다

`n_green` 0~6 전 구간에서 `g1~g6` 참 개수의 최소·최대가 `n_green` 과 같았다. **예외 0건.**

### 15.5 집계 축 검증 (`aggregation-spec.md` 근거)

| 항목 | 실측 |
| --- | --- |
| 판정 모집단 | 503,887 |
| 그 안의 `industry_category IS NULL` | **0건** |
| 비업종 값(`BIZ_NO_MISSING`·`UNKNOWN`) | 83,727 (16.62%) |
| `firms.sido` 결측 | 129곳 (0.026%) |
| `firm_id` 조인 손실 | **0건** (553,598 → 553,598) |
| 4단계 매핑 실패 | **0건** |
| 지역 × 업종 칸 | 321칸 · 합계 503,887 (등식 일치) |
| 사업장 30곳 미만 칸 | **64칸 · 649곳** (0.13%) — 낙인 위험 |

`industry_category IS NULL` 49,711곳은 `risk_full IS NULL` 과 **차집합 양쪽 0인 동일 집합**이다.

### 15.6 집계 뷰 SQL 실행 검증

`aggregation-spec.md` §7.2 의 `CREATE OR REPLACE VIEW` 를 운영 DB에서 **그대로 실행**했다.

```
BEGIN → CREATE VIEW · COMMENT · GRANT → 조회 → ROLLBACK
 집계행수 |  합계  | 등식일치
      321 | 503887 | t
종료코드 0 · 롤백 후 pg_views 조회 0건 (운영 DB 무변경)
```

### 15.7 주석 SQL 드라이런

`COMMENT ON COLUMN` 48문(피처 36 + 비피처 12)을 `COMMIT` → `ROLLBACK` 으로 바꿔 실행했다.
**48문 전부 성공 · 종료코드 0 · 실행 후 주석 수 2건(변경 없음).**

### 15.8 운영 DB 주석 현황

```
저장소 migration   51건  (0002~0008 = 49 · 0009 = 2 · 0010 = 0)
운영 DB 현재        2건  (v_posts · v_comments — 0009 로 적용된 것)
유실                49건  release dump 가 --no-comments
```

`scored_active` 는 **54컬럼 중 51개에 설명이 없다.**

---

## 16. 재현 명령 (2~4회차)

```sql
-- 판정 규칙 반례 (전부 0)
with j as (select s.*, f.판정,
       (select percentile_cont(0.10) within group (order by s2.risk_full)
          from v_current_scored s2 join v_current_safe f2 using (firm_id,batch_id)
         where s2.risk_full is not null and f2.판정 not like '배제%' and s2.n_months>=8) p10
  from v_current_scored s join v_current_safe f using (firm_id,batch_id))
select count(*) filter (where 체불배제 and 판정<>'배제_임금체불공개'),
       count(*) filter (where 판정='안정신호' and not (n_green>=5 and risk_full<=p10 and n_months>=8)),
       count(*) filter (where 판정='유보' and n_months<8) from j;

-- 관측창 길이
select n_months, count(*) from v_current_scored where imputed_months_count=0 group by 1;

-- g5 경계
select g5_업력3년, min(firm_age_months), max(firm_age_months) from v_current_scored
 where firm_age_months is not null group by 1;

-- 큐 3,000 판정 구성
select f.판정, count(*) from public.inspector_queue q
  left join v_current_safe f on f.firm_id=q.firm_id and f.batch_id=q.batch_id
 where q.batch_id=(select max(batch_id) from public.inspector_queue) group by 1;

-- 집계 축
select count(*), count(*) filter (where s.industry_category is null),
       count(*) filter (where s.industry_category in ('BIZ_NO_MISSING','UNKNOWN')),
       count(*) filter (where f.sido is null or f.sido='')
  from v_current_safe v join v_current_scored s using (firm_id,batch_id)
  join public.firms f using (firm_id);
```
