# 데이터 계약 실측 검증

- 검증일: **2026-08-31 16:00 KST**
- 대상 DB: 운영 PostgreSQL 16 (Path B 복원본)
- 대조 대상: [`wage-risk.md`](wage-risk.md) · [`safety-risk.md`](safety-risk.md) · [`README.md`](README.md)
- 결과: **수치 불일치 0건** · **표시 규칙 위반 1건** (9.3절 — 감독관 `reasons` 영문명 노출)

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

`정보부족` 8.98% 와 아래 `risk_full` NULL 8.98% 가 일치한다 — 채점 불가 행이 `정보부족` 이다.

## 5. 주의값

| 값 | 실측 | 해석 |
| --- | ---: | --- |
| `risk_calibrated` non-NULL | **0 / 3,855,848** | 전 행 NULL. 결함이 아니라 **"아직 확률로 말할 수 없다"** 는 표시 |
| `risk_full` NULL 비율 | **8.98%** | 채점 불가. **`0` 과 다르다** |
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
> | `wage_risk.grade` | `inspector_queue.queue_priority` (4.5절) |
> | `wage_risk.model_score` | `scored_active.risk_full` |
> | `industrial_safety.priority_band` | `provisional_population_priority_band` |

`grade` 값 4종과 건수는 **4.5절 표와 일치**한다 — 긴급 100 · 우선 400 · 주의 1,000 · 관찰 1,500.

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

## 10. 재현 명령

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

## 11. 불일치·미확인

**불일치: 0건.** 계약 문서에서 정정할 항목은 나오지 않았다.

**표시 검증(9절)에서 위반 1건** — 감독관 `reasons` 의 영문 원본명 노출.
계약 수치 자체의 불일치는 아니며, **화면 표기 미확정 항목**이다.

| 미확인 | 내용 |
| --- | --- |
| `valid_until` 규정 | 전 상태 `null` 로 일관되나 **계약 문서에 필드 정의가 없다.** 채울 계획이 있는지 미확정 |
| 산업재해 4상태 | 구직자 응답의 `safety_context` 는 `normal` 만 확인. 밴드별 상태는 미검증 |
| 실제 화면 | API 응답만 봤다. **렌더링된 화면 문구는 미확인** |

> 이 문서에는 **실존 사업장명·`firm_id` 를 싣지 않는다.** 저장소가 공개다.
> 응답 형태는 [`samples/`](samples/) 의 `COMPANY_DEMO_*` 합성 식별자를 쓴다.
