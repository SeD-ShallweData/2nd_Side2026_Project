# 산업재해 데이터 계약

- 계약 버전: `safety-risk.v1.0`
- 기준일: 2026-08-29
- 대상: PostgreSQL 16 / `wageguard` DB / `industrial_safety` schema
- 기본 소비자: 구직자 웹 UI(산업안전 카드), LLM 상담 백엔드
- 검증 기준: `pipeline_runs.run_id = 3` (`v2.1.0-p0-contract`, 발행 2026-08-14)

적재 절차·매칭 funnel·권한 설정은 `db/docs/INDUSTRIAL_SAFETY_EXISTING_FIRMS_CONTRACT.md`
가 정본이다. 이 문서는 **값의 의미와 화면 변환**만 다룬다.

## 1. 이 신호가 무엇이고 무엇이 아닌가

### 무엇인가

**지역×업종×주 단위 기대 승인건수를 사업장에 배분한 잠정 점검 우선순위**다.

```
① 지역(17개 시도) × 대업종(10개) × 주 단위로
   최초요양 승인 레코드 수를 예측  (셀 단위 모델)
        ↓
② 셀 기대건수를 합계보존 방식으로 사업장에 배분
        ↓
③ 배분된 값의 전국 백분위 → 우선순위 구간(band)
```

### 무엇이 아닌가

DB 컬럼 이름 자체가 이를 명시한다. 축약하지 말고 그대로 읽어야 한다.

| 컬럼 | 실제 값 |
| --- | --- |
| `risk_value_type` | `provisional_probability_from_next_calendar_year_bounded_cell_count_allocation_not_validated` |
| `probability_status` | `research_only_bounded_target_not_workplace_identified_or_validated` |
| `calibration_status` | `bounded_cell_allocation_scenario_only` |
| `priority_reference_population` | `all_scored_workplaces_national_not_similar_workplace_peers` |
| `is_validated_workplace_probability` | `false` (전 행) |

정리하면 이렇다.

- ❌ **이 사업장의 사고 발생 확률이 아니다** (`not_validated`, `research_only`)
- ❌ **캘리브레이션된 값이 아니다** (`scenario_only`)
- ❌ **유사 업종·규모 사업장과 비교한 상대위험이 아니다** (`not_similar_workplace_peers`)
- ❌ **인과 효과가 아니다**
- ⭕ **전국 채점 대상 안에서의 잠정 점검 순서**다

DB 주석(`0004_industrial_safety.sql`):

> `provisional_population_priority_percentile` — 같은 run·주·모집단 안의 잠정 점검 우선순위.
> **유사사업장 상대위험이나 인과효과가 아니다.**

> `research_only_provisional_probability` — 셀 기대 승인레코드 배분 시나리오를 1-exp(-m)로
> 변환한 연구용 잠정값. **검증된 산재 발생확률이 아니다.**

> `validated_probability_...` — exact 사업장×주 라벨로 외부검증된 경우에만 채운다.
> **현재 NPS/KCOMWEL 전 행 NULL이며 0으로 치환하지 않는다.**

## 2. band 매핑

### 2.1 코드 변환

`product/src/adapters/real/MlRiskProvider.ts` 128~132행 `safetyLevel()`

| `provisional_population_priority_band` | `SignalLevel` |
| --- | --- |
| `상위1%` | `review` |
| `상위5%` | `review` |
| `상위10%` | `watch` |
| `일반` | `normal` |
| 그 외 / NULL | `unknown` |

### 2.2 band의 실제 경계 — ⚠️ 이름이 오해를 부른다

2026-08-29 실측. `provisional_population_priority_percentile` 기준.

| band | percentile 범위 | 사업장 수 | 실제 의미 |
| --- | --- | ---: | --- |
| `상위1%` | 0.9900 ~ 1.0000 | 5,161 | 상위 1% |
| `상위5%` | 0.9500 ~ 0.9900 | 20,739 | **상위 1~5% 구간** |
| `상위10%` | 0.9000 ~ 0.9500 | 25,690 | **상위 5~10% 구간** |
| `일반` | 0.0000 ~ 0.9000 | 464,018 | 하위 90% |
| 합계 | | **515,608** | |

**`상위5%` 는 "상위 5% 이내"가 아니라 "상위 1%를 제외한 1~5% 구간"이다.**
band는 누적이 아니라 **배타적 구간**이다. 화면 문구를 만들 때 "상위 5% 이내"로 쓰면
상위 1%를 제외한 집합을 잘못 설명하게 된다.

### 2.3 `confidence` 결정

`safetyResult()` 186행. band와 별개 규칙이다.

```
confidence = (temporal_status == "current_target_week"
              && confidence_tier ∈ {"exact_unique", "human_approved"})
             ? "sufficient" : "limited"
```

**현재 전 행이 `limited` 다.** `temporal_status` 가 `stale_target_week` 이기 때문이다(3절).

## 3. 시점 상태 — 현재 전 행 `stale_target_week`

| 필드 | 실측값 |
| --- | --- |
| `target_week_start` ~ `target_week_end` | 2026-04-20 ~ 2026-04-26 |
| `prediction_as_of` | 2026-04-19 09:00 UTC |
| `temporal_status` | `stale_target_week` |
| `published_at` | 2026-08-14 15:02:34.715 UTC |

**대상 주가 이미 지났다.** 코드가 이 경우 요약문에 다음 문장을 덧붙인다.

> 대상 기간이 지나 최신 현장 정보를 추가로 확인해야 합니다.

`temporal_status` 3분기와 각 문구는 다음과 같다.

| `temporal_status` | 덧붙는 문구 |
| --- | --- |
| `current_target_week` | 현장 안전조치를 직접 확인하세요. |
| `stale_target_week` | 대상 기간이 지나 최신 현장 정보를 추가로 확인해야 합니다. |
| `not_yet_effective` | 아직 대상 기간 전이므로 현재 상태로 해석하지 마세요. |

## 4. 사용자 응답 변환

`safetyResult()` (149~186행) → `SafetyContextPublic`

```json
{
  "availability": "ready",
  "scope": "validated_firm_context",
  "level": "normal",
  "summary": "공표된 산업안전 자료에서 우선 확인 범위가 '일반'으로 표시됐습니다. 대상 기간이 지나 최신 현장 정보를 추가로 확인해야 합니다.",
  "region": "경상북도",
  "industry": "광고 대행업",
  "target_start": "2026-04-20",
  "target_end": "2026-04-26",
  "evidence_codes": ["PUBLISHED_SAFETY_PRIORITY_BAND"],
  "evidence_items": [{
    "code": "PUBLISHED_SAFETY_PRIORITY_BAND",
    "label": "공표 우선순위 일반",
    "description": "검증된 사업장 연결과 공표된 순위 구간만 사용했으며 연구용 확률은 사용하지 않았습니다."
  }],
  "confidence": "limited",
  "disclaimer": "검증된 사업장 사고 확률이 아닙니다. 공표된 모델 결과에서 현장 확인 순서를 돕는 우선순위 구간입니다."
}
```

전체 예시는 [`samples/`](samples/) 참고.

### 4.1 `unknown` 으로 떨어지는 세 경로

```
① firm_match_validation_status ∉ {verified_exact, verified_human}   → unknown (no_data)
② safetyLevel(band) == "unknown"                                    → unknown (no_data)
③ 조회 실패 (예외)                                                   → unknown (unavailable)
```

①②는 `availability: "no_data"`, ③은 `"unavailable"` 이다. **두 상태를 같게 취급하지 않는다**(POL-05-1).

| 상태 | summary | disclaimer |
| --- | --- | --- |
| `no_data` | 공표된 산업안전 참고자료에서 이 사업장과 연결된 결과를 확인하지 못했습니다. | 자료가 없다는 사실은 안전하거나 위험하다는 뜻이 아닙니다. |
| `unavailable` | 산업안전 참고정보를 현재 불러오지 못했습니다. | 연결 오류를 자료 없음이나 안전 신호로 해석하지 마세요. |

### 4.2 사용자에게 노출하지 않는 것

`v_llm_firm_safety_context` 는 26개 컬럼이지만 응답에 나가는 것은 일부다.

| 노출 | 비노출 |
| --- | --- |
| `band` (요약문 안) | `percentile` 원값 |
| `target_week_start/end` | `research_only_provisional_probability` |
| `region`, `industry` | `run_id`, `source_sha256` |
| | `source_workplace_id`, 마스킹 사업자번호, 주소 |

DB 주석(`0005`):

> `v_llm_firm_safety_context` — LLM 호출 전 검증용 최소 조회 계층. 엄격 연결·현재 published
> run만 노출하며 **원천 ID, 사업자번호, 주소, 연구용 잠정확률은 숨긴다.**

> `research_only_provisional_probability` — ... **LLM 안전 뷰에 노출하지 않으며**
> 검증된 사업장 사고확률이 아니다.

## 5. 사업장 매칭

### 5.1 실측 — 단일 방법, 100%

| `validation_status` | `match_method` | 건수 |
| --- | --- | ---: |
| `verified_exact` | `exact_name_masked_business_registration_sido_industry` | **515,608** |

**이름·마스킹 사업자번호·시도·업종 네 가지가 전부 일치**하는 경우만 적재됐다.
`verified_human`(사람 승인)이나 다른 방법은 현재 0건이다.

### 5.2 금지된 매칭

DB 주석(`0004`):

> `firm_links` — 산재 사업장 snapshot과 기존 `public.firms` 의 후보·승인 이력.
> **prefix6 단독 또는 fuzzy 자동승인을 금지한다.**

> `business_registration_prefix6` — 공개 마스킹 번호의 앞 6자리.
> **비고유이며 단독 사업장 식별·FK·자동승인에 사용하지 않는다.**

`firms.biz_no` 는 한 번호가 최대 788곳에 재사용된다([`wage-risk.md`](wage-risk.md) 7절).

### 5.3 `validation_status` 의 범위

> `validation_status` — 사업장 **identity 연결** 검증 상태이며
> **모델 또는 사고확률의 검증 상태가 아니다.**

`verified_exact` 는 "이 결과가 이 사업장의 것이 맞다"는 뜻이지
"이 예측이 맞다"는 뜻이 아니다.

## 6. 임금체불과 합산하지 않는다

**이 프로젝트의 설계 원칙이다.** 본선 제안서 1.6:

> 두 신호는 **합산·평균하지 않고 별도 카드·별도 DB 스키마로 제공**.
> 라벨·시간 단위·통계적 의미가 달라 종합점수를 만들지 않는 것을 설계 원칙으로 확정

| | 임금체불 | 산업재해 |
| --- | --- | --- |
| 스키마 | `public` | `industrial_safety` |
| 단위 | 사업장 × 배치(월) | 지역×업종 셀 × 주 → 사업장 배분 |
| 예측 대상 | 6개월 뒤 명단공개 | 주간 최초요양 승인 레코드 수 |
| 모집단 | 국민연금 가입 사업장 | `nps_public_observed_population` |
| 검증 | LORO/GKF CV | rolling-origin pseudo-OOT (셀 단위) |

**단위도 대상도 검증 방법도 다르다.** 두 값을 더하거나 평균하면 아무 의미가 없다.
POL-02가 종합 위험점수 생성을 금지한다.

한 카드의 실패나 `unknown` 이 다른 카드를 막지 않아야 한다(POL-05-1).

## 7. 조회 규칙

| 대상 | 용도 |
| --- | --- |
| `industrial_safety.v_llm_firm_safety_context` | **앱·LLM은 이것만 쓴다.** 26개 컬럼, 민감정보 제외 |
| `industrial_safety.v_firm_accident_risk` | 검증된 firm 링크만. tier 합산·평균 금지 |
| `industrial_safety.v_current_workplace_risk_internal` | **내부 전용.** 주소·마스킹 식별정보 포함, `wg_bot` 비공개 |
| `industrial_safety.firm_risk_results` | 원본 fact. 앱 직접 조회 금지 |

`wg_bot` 계정에 부여된 산업재해 권한은 **뷰 2개뿐**이다
(`v_llm_firm_safety_context`, `v_cell_api_label_comparison`). 원본 테이블 권한은 없다.

DB 주석(`0004`):

> `v_firm_accident_risk` — 현재 산업재해 결과 중 검증된 firm 링크만 제공한다.
> **NPS/KCOMWEL tier는 대체 모집단이며 합산·평균하지 않는다.**

## 8. 파이프라인 lineage

`pipeline_runs` 3건이 현재 published 상태다.

| run_id | run_kind | model_name | model_version |
| ---: | --- | --- | --- |
| 1 | `cell_label` | — | — |
| 2 | `cell_prediction` | `historical_rate_baseline` | `bounded_maturity_gap_baseline_v1_20260801` |
| 3 | `firm_risk` | `industrial_accident_workplace_week_allocation` | `v2.1.0-p0-contract` |

**run 2의 모델이 `historical_rate_baseline` 이다.** 본선 제안서 3.2.3에 따르면
Poisson XGBoost가 1차 지표(count deviance 1.3329)에서 단순 과거율 기준모형(1.2920)에
져서 **더 단순한 모형을 주력으로 채택**했다. 최신 기법을 쓰지 않은 것이 아니라
검증 결과로 선택한 것이다.

## 9. 알려진 제약

| # | 내용 |
| --- | --- |
| 1 | **대상 주가 지났다** — 전 행 `stale_target_week`. 주간 갱신 체계가 아직 없다 |
| 2 | **`confidence` 가 전 행 `limited`** — 1번의 직접 결과 |
| 3 | **`validated_probability` 전 행 NULL** — 사업장×주 exact 라벨이 없어 검증 불가. 채우려면 외부 라벨 확보가 선행돼야 한다 |
| 4 | **band 이름이 배타적 구간을 누적처럼 보이게 한다** — 2.2절 |
| 5 | `workplaces`·`workplace_snapshots`·`firm_links` 등 6개 테이블이 0행 — `existing-firms` scope로 적재해 사업장 마스터를 복제하지 않았다(적재 계약 2절) |

3번은 본선 제안서 3.1.5의 보완 과제다.

> 사업장×주 exact 산업재해 라벨 확보 후, 연구용 확인 우선순위를
> 검증된 확률 또는 직접 분류 모델로 발전

## 부록. 검증 방법

```bash
# band 경계와 분포
psql -c "select provisional_population_priority_band,
                min(provisional_population_priority_percentile),
                max(provisional_population_priority_percentile), count(*)
           from industrial_safety.firm_risk_results group by 1 order by 2;"

# 매칭 방법 분포
psql -c "select validation_status, match_method, count(*)
           from industrial_safety.firm_risk_results group by 1,2;"

# 계약성 컬럼 (단일 값이어야 정상)
psql -c "select distinct risk_value_type, probability_status, calibration_status,
                temporal_status, is_validated_workplace_probability
           from industrial_safety.v_llm_firm_safety_context;"

# 변환 코드
sed -n '128,190p' product/src/adapters/real/MlRiskProvider.ts
```

`is_validated_workplace_probability` 가 `true` 로 바뀌거나 `temporal_status` 가
`current_target_week` 이 되면 **이 문서를 갱신해야 한다.** 화면 문구와 `confidence` 가 함께 바뀐다.
