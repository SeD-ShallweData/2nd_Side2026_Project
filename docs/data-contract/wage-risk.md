# 임금체불 데이터 계약

- 계약 버전: `wage-risk.v1.0`
- 기준일: 2026-08-29
- 대상: PostgreSQL 16 / `wageguard` DB / `public` schema
- 기본 소비자: 구직자 웹 UI, 근로감독관 대시보드, LLM 상담 백엔드
- 검증 기준 배치: `batches.id = 7` (`as_of_date=2026-06-01`, `target_month=2026-12-01`)

## 1. 목적과 비목적

이 문서의 목적은 **DB에 저장된 값이 무엇을 뜻하는지** 고정하는 것이다.
화면 문구·색상·카드 배치 같은 표현 규칙은 `product/docs/service-policy.md`(POL-01~POL-14)가
이미 정의했으므로 여기서 다시 쓰지 않고 POL 번호로 참조한다.

API 응답 필드의 형태는 `product/docs/api-contract.md` 4절이 정의한다. 여기서는
**DB 원본 값 → 그 응답 필드** 사이의 변환 규칙만 다룬다.

이 문서는 모델을 설명하지 않는다. 모델 성능·학습 방법은 본선 제안서 3.2.3을 본다.

## 2. ⚠️ 사용자와 감독관은 서로 다른 테이블을 본다

**이 문서에서 가장 중요한 항목이다.**

```
구직자 화면    public.safe_recommendation.판정   (v_current_safe)
                  안정신호 / 유보 / 유보_정보부족 / 배제_○○

감독관 화면    public.scored_active.risk_tier    (v_current_scored)
                  매우높음 / 높음 / 다소높음 / 일반 / 정보부족 / 이미공개
                  + risk_full + SHAP 사유 + G1~G6
```

같은 사업장에 두 값이 모두 붙어 있다. **섞어 쓰면 안 된다.**

DB 주석이 이미 이를 명시하고 있다.

> `scored_active.risk_tier` — 감독관 전용, **구직자 화면에 노출 금지(명예훼손 리스크)**
> `v_current_safe` — **구직자 화면은 위험등급 대신 이 판정만 쓴다**
> `inspector_queue.queue_priority` — `scored_active.risk_tier` 와 **다른 척도다. 같은 단어로 부르지 말 것**

세 척도(`판정`·`risk_tier`·`queue_priority`)가 각각 다른 모집단·다른 기준으로 계산된다.
용어를 공유하지 않는다.

## 3. 사용자 경로 — `safe_recommendation.판정`

### 3.1 판정 값과 변환

변환 코드: `product/src/adapters/real/MlRiskProvider.ts` 의 `VERDICT_META`(56~75행)와
`toWageRiskPublic()`(76~125행).

| `판정` | `SignalLevel` | `Confidence` | 근거 코드 |
| --- | --- | --- | --- |
| `안정신호` | `normal` | `sufficient` | `SAFE_RECOMMENDATION_STABLE` |
| `유보` | `watch` | `sufficient` | `SAFE_RECOMMENDATION_HOLD` |
| `유보_정보부족` | `unknown` | `unavailable` | `INSUFFICIENT_HISTORY` |
| `배제_임금체불공개` | `review` | `sufficient` | `OFFICIAL_WAGE_LISTING_MATCH` |
| `배제_공개체납` | `review` | `sufficient` | `INSURANCE_PAYMENT_REVIEW` |
| `배제_4대보험체납(door1)` | `review` | `sufficient` | `INSURANCE_PAYMENT_REVIEW` |

**변환 우선순위**: `배제_` 접두 판정이 `VERDICT_META` 조회보다 **먼저** 적용된다.
코드가 `verdict?.startsWith("배제_")` 로 판단하므로, 새 `배제_*` 값이 추가되면
자동으로 `review` + `INSURANCE_PAYMENT_REVIEW` 가 된다.

`SignalLevel` 4종의 사용자 표기는 POL 상태 표현 정책 표를 따른다(normal=뚜렷한 이상 신호 없음,
watch=추가 확인 권장, review=우선 확인 필요, unknown=분석 자료 부족).

### 3.2 실제 분포 (2026-08-29 실측, 최신 배치)

| `판정` | 사업장 수 | 비율 |
| --- | ---: | ---: |
| `유보` | 431,646 | **85.7%** |
| `안정신호` | 32,613 | 6.5% |
| `배제_4대보험체납(door1)` | 20,863 | 4.1% |
| `유보_정보부족` | 17,530 | 3.5% |
| `배제_공개체납` | 1,102 | 0.2% |
| `배제_임금체불공개` | 133 | 0.03% |
| **합계** | **503,887** | `batches.n_safe` 와 일치 |

**⚠️ 화면 설계에 영향을 주는 사실**: 조회 대상의 **85.7%가 `유보`(watch)** 다.
대부분이 같은 상태로 나오므로 `watch` 는 변별력이 낮다. `watch` 를 경고성 시각 요소로
강조하면 거의 모든 사업장이 경고로 보인다. 화면·정보설계 담당과 협의가 필요하다.

`배제_임금체불공개` 는 133곳(0.03%)뿐이다. 공식 명단 연계는 매우 드문 경우다.

### 3.3 사용자에게 노출하지 않는 것

POL-03 금지 목록을 따른다. 추가로 이 계약에서 명시한다.

- `scored_active` 의 모든 컬럼 (`risk_full`, `risk_tier`, `n_green`, `g1~g6`, `door1_*`, `nf_*` 등)
- `inspector_queue` 의 모든 컬럼
- `배제_` 판정의 원문 문자열 (`배제_4대보험체납(door1)` 등)

`판정` 원문은 근거 코드(`INSURANCE_PAYMENT_REVIEW` 등)로 변환해 내보낸다.

## 4. 감독관 경로 — `scored_active.risk_tier`

### 4.1 등급 정의

`risk_tier_meta` 테이블이 정본이다. DB 주석:

> 위험등급 범례·툴팁용 해설표. **lift 는 ML팀 실측값이며 DB 에서 재계산 불가 — 임의로 고치지 말 것.**

| tier | label | percentile | recall_cum | lift | `is_prediction` |
| --- | --- | --- | ---: | --- | --- |
| 매우높음 | 최고위험 · 평균 대비 약 5~9배 | 0~0.005 | 0.047 | 4.7~9.3 | `true` |
| 높음 | 고위험 · 평균 대비 약 4~11배 | 0.005~0.02 | 0.221 | 4.4~11 | `true` |
| 다소높음 | 관찰 필요 · 평균 대비 약 3~4배 | 0.02~0.1 | 0.419 | 2.7~4.2 | `true` |
| 일반 | 특이신호 없음 | 0.1~1 | — | 1~1 | `true` |
| 정보부족 | 데이터 부족으로 평가 보류 | — | — | — | **`false`** |
| 이미공개 | 이미 명단공개된 곳 | — | — | — | **`false`** |

`lift` 는 화면에 `lift_low ~ lift_high` **범위로 표기**한다(DB 주석 지시).
`lift_low` = pooled 전체 회차 기준(보수적), `lift_high` = recent 2023~2026 배포대상 기준(낙관적).

### 4.2 `is_prediction = false` 의 의미

> false 면 예측이 아니라 사실·상태다(이미공개·정보부족). **위험 예측과 섞어 표시하지 말 것.**

`정보부족`과 `이미공개`는 모델 출력이 아니다. 나머지 4개와 같은 시각 언어(색·정렬·아이콘)를
쓰면 안 된다. 등급 정렬에도 포함하지 않는다.

### 4.3 백분위 모집단

DB 주석:

> 백분위 모집단은 batch 안에서 `risk_full IS NOT NULL AND 체불배제 = false` 인 행만.

즉 `정보부족`(risk_full NULL)과 `이미공개`(체불배제 true)는 백분위 계산에서 **제외**된 뒤
사후에 라벨만 붙는다. "상위 0.5%"는 전체 553,598곳 기준이 아니다.

### 4.4 실제 분포 (2026-08-29 실측, 최신 배치)

| tier | 사업장 수 | 비율 |
| --- | ---: | ---: |
| 일반 | 453,377 | 81.9% |
| **정보부족** | **49,703** | **9.0%** |
| 다소높음 | 40,301 | 7.3% |
| 높음 | 7,557 | 1.4% |
| 매우높음 | 2,519 | 0.5% |
| 이미공개 | 141 | 0.03% |
| **합계** | **553,598** | `batches.n_scored` 와 일치 |

**정보부족이 9%(49,703곳)** 다. 이를 `일반`과 같이 취급하면 5만 곳을 "특이신호 없음"으로
잘못 표시하게 된다(POL-05 위반).

### 4.5 `queue_priority` — 또 다른 척도

`inspector_queue.queue_priority` 는 큐 top 3,000 **안에서의 순위 기반**이다.

| 값 | rank 범위 (2026-08-29 실측) | 건수 |
| --- | --- | ---: |
| 긴급 | `1 ~ 100` | 100 |
| 우선 | `101 ~ 500` | 400 |
| 주의 | `501 ~ 1500` | 1,000 |
| 관찰 | `1501 ~ 3000` | 1,500 |

> ⚠️ **DB 주석이 틀렸다.** `0006_risk_tier.sql` 의 `COMMENT ON` 은
> `긴급(rank<100)/우선(<500)/주의(<1500)` 으로 적고 있으나 실제 데이터는 경계를 포함한다
> (`rank <= 100`). 위 표가 실측 기준이며, **주석 수정이 별도로 필요하다**(11.3절).

DB 주석: **`scored_active.risk_tier` 와 다른 척도다 — 같은 단어로 부르지 말 것.**

큐 정렬은 `rank` 로 한다. `queue_priority` 나 `risk_tier` 로 정렬하지 않는다(`v_current_queue` 주석).

### 4.6 SHAP 사유 — `inspector_queue.reasons`

> SHAP 상위 3피처의 **이름**. ⚠️ **위험큐 상위 3,000곳에만 존재한다.**
> 나머지 사업장에는 위험사유가 없으며 **지어내면 안 된다**.

배열 길이는 **항상 정확히 3**이고(min=max=3), 큐 행 전원이 값을 갖는다
(21,000 / 21,000) **[실측 2026-08-31]**.

### ⚠️ 한글 라벨과 영문 원본 피처명이 섞여 있다

**절반 이상이 한글이 아니다.** 화면에 그대로 흘리면 **영문 변수명이 사용자에게 노출된다.**

| | 최신 배치(3,000행) | 전체(21,000행) |
| --- | ---: | ---: |
| distinct 피처 | **17종** | **20종** |
| 한글 라벨 | 9종 | 9종 |
| **영문 원본명** | **8종** | **11종** |

#### 전체 목록 **[실측 2026-08-31 · batch 7]**

| 한글 라벨 (9종) | 최신 | 전체 |
| --- | ---: | ---: |
| 체납액 | 2,137 | 15,200 |
| 4대보험 체납이력 | 1,166 | 7,720 |
| 고지금액 변동 | 983 | 7,288 |
| 지역 | 669 | 4,724 |
| 업력 | 108 | 747 |
| 급여수준 | 13 | 112 |
| 급여삭감 | 10 | 44 |
| 고지금액 급락 | 8 | 59 |
| 인원변동성 | 3 | 38 |

| 영문 원본명 (11종) | 최신 | 전체 | 설계상 피처군 |
| --- | ---: | ---: | --- |
| `door1_maxmonths` | 1,529 | 10,679 | door1(체납) |
| `imputed_months_count` | 975 | 6,475 | 결측 신호 |
| `imputed_ratio` | 834 | 5,523 | 결측 신호 |
| `industry_category` | 446 | 3,387 | 범주형 |
| `replacement_avg_12m` | 105 | 875 | 시계열 |
| `turnover_avg_12m` | 7 | 75 | 시계열 |
| `replacement_min_12m` | 5 | 40 | 시계열 |
| `turnover_std_12m` | 2 | 7 | 시계열 |
| `log_emp_count` | — | 5 | 시계열 |
| `salary_change_12m` | — | 1 | 시계열 |
| `nf_emp_slope` | — | 1 | 비정형 |

합계 검증: 최신 9,000 = 3,000 × 3 · 전체 63,000 = 21,000 × 3 ✅
`—` 는 최신 배치에 등장하지 않고 과거 배치에만 있는 피처다.

### 표시 규칙

1. **영문 원본명을 화면에 그대로 노출하지 않는다.** 사용자가 읽을 수 없는 변수명이다
2. 라벨이 없는 피처는 **`사유 확인 필요`** 로 표기한다. **의미를 지어내지 않는다**
3. `shap_value` **원값**은 POL-03에 따라 사용자·감독관 모두에게 노출하지 않는다.
   노출하는 것은 피처 **이름**뿐이다
4. 사유는 **감독관 화면 전용**이다. 구직자 화면에는 넣지 않는다

### 🔴 선행 조건 — 라벨 정의가 저장소에 없다

영문 11종의 **한글 정의가 저장소 어디에도 없다** **[실측]**.
`db/migrations/0000_init.sql:99-134` 에 컬럼 선언(타입)만 있고 `COMMENT ON` 이 없다.

**따라서 라벨화는 저장소만 보고 할 수 없다.** 모델 담당의 피처 사전이 필요하다.
추측으로 라벨을 붙이면 **감독관에게 틀린 사유를 제시**하게 된다 —
이 프로젝트가 하지 않기로 한 바로 그 일이다.

| 필요한 것 | 누구에게 |
| --- | --- |
| 영문 11종의 정의·산출식·단위 | 모델 담당 |
| 정의를 받은 뒤 화면 표기 확정 | 정보설계 담당 |

## 5. `risk_full` 을 확률로 읽지 않는다

DB 주석 원문(`0003_target_month.sql`):

> 위험점수 0~1. ⚠️ **확률이 아니다** — 양성:음성 1:1 다운샘플링으로 학습해서 "절반이 위험한
> 세상" 기준이다. 실제 기저율은 약 0.026%(146/552,500, 약 1/3,784)라 **약 1,900배 차이**가 난다.
> "체불 확률 N%" 로 말하지 말고 **순위·분위·등급으로만** 해석한다.
> NULL(약 9.2%)은 관측창 커버리지 부족으로 채점 불가이며 **0과 다르다**.
> *— 2026-08-29 실측 8.98%(49,711 / 553,598). 주석의 9.2%는 다른 배치 기준으로 보인다.*
> 예측 대상은 `batches.target_month` 시점의 명단공개다.

`risk_calibrated`:

> 캘리브레이션된 확률을 넣을 자리. **현재 전부 NULL** — 모델 문서상 캘리브레이션은 미완이며,
> 양성이 희소해 신뢰구간이 넓다. 준비되기 전까지 확률 표현을 쓰지 말 것.

**이 두 주석이 이 계약의 핵심 근거다.** `risk_calibrated` 가 비어 있는 것은 결함이 아니라
"아직 확률로 말할 수 없다"는 상태의 표시다. 채워질 때까지 확률 표현은 금지된다.

## 6. 기준일 3종

혼동하면 POL-06 위반이다.

| 필드 | 의미 | DB 주석 |
| --- | --- | --- |
| `batches.as_of_date` | 데이터 기준월 = 관측창의 끝(t-6) | NULL 이면 미확정이므로 **"언제 기준"이라고 말하면 안 된다** |
| `batches.target_month` | 예측 대상월(t) = `as_of_date` + 6개월 | risk_full 은 "이 달에 명단공개될 위험"이며 **현재 상태가 아니다** |
| `official_listing.as_of` | **명단 자체의 공표일** | 모델 배치일로 대신하지 않는다. 없으면 `null` |

최신 배치 기준 `as_of_date=2026-06-01`, `target_month=2026-12-01`.

**화면에 "2026-06 기준"이라고 쓰면 관측 시점을 뜻한다.** 예측 대상은 6개월 뒤다.
둘 중 무엇을 표시할지는 화면별로 지정해야 한다 — **미확정 항목**(화면 담당·정보설계 담당과 협의).

### 6.1 API 응답의 기준일 필드 — POL-11 대조 **[실측 2026-08-31]**

POL-11 은 `data_as_of` · `generated_at` · `valid_until` · `freshness` 표시를 요구한다.

| 필드 | 실제 값 | 출처 | POL-11 |
| --- | --- | --- | :-: |
| `data_as_of` | `"2026-06-01"` | `batches.as_of_date` | ✅ |
| `target_month` | `"2026-12-01"` | `batches.target_month` | — |
| `generated_at` | `"2026-08-14T15:02:34.715Z"` | `batches.ingested_at` | ✅ |
| `valid_until` | **`null`** | 하드코딩 | 🔴 |
| `freshness` | **`"unknown"`** | 하드코딩 | 🔴 |

> 🔴 **`valid_until` 이 없어 POL-11 의 유효기간 요건을 충족할 수 없다.** 11.5절 참조.

### 6.2 `sources[]` 필드 규정 **[실측 2026-08-31]**

응답에 **항상 2건**이 들어간다 — `wage` 1건, `safety` 1건. 6개 판정 상태 전부 동일했다.

| 필드 | 필수 | 예시 | 의미 |
| --- | :-: | --- | --- |
| `name` | ✅ | `국민연금 사업장 자료 및 ML 공개 판정` | **데이터명**. POL-11 의 "문서명 또는 데이터명" |
| `category` | ✅ | `wage` / `safety` | 카드 구분. **두 카드를 합산하지 않는다**(POL-06) |
| `organization` | ✅ | `돈워리 임금체불 데이터 파이프라인` | ⚠️ 아래 주의 |
| `as_of` | ✅ | `2026-06-01` (wage) · `2026-08-14T15:02:34.715Z` (safety) | 기준일. **형식이 두 가지다** |
| `document_id` | ✅ | `door1-voting-39f-v1:batch-7` | 모델·배치 식별. 재현 근거 |

> ⚠️ **`organization` 은 원출처 기관이 아니다.** `돈워리 … 데이터 파이프라인`,
> 즉 **우리 쪽 산출 주체**다. 화면에 "출처: 돈워리 …" 로 그대로 쓰면
> 사용자가 원자료 출처(국민연금 사업장 자료 등)로 오해할 수 있다.
> **원출처는 `name` 에 들어 있다.** 화면 문구는 `name` 을 우선한다.

> ⚠️ **`as_of` 형식이 통일돼 있지 않다.** wage 는 날짜(`YYYY-MM-DD`),
> safety 는 ISO 타임스탬프다. 같은 목록에 나란히 표시할 때 **날짜로 정규화**한다.

## 7. 식별키 주의

| 컬럼 | DB 주석 요지 |
| --- | --- |
| `firms.firm_id` | `sha1(사업장명|사업자번호)[:16]`. ⚠️ **불변이 아니다** — 사업장명이 바뀌면 달라진다(월 약 0.24%) |
| `firms.biz_no` | 마스킹 6자리. ⚠️ **비고유** — 한 번호가 **최대 950곳**에 재사용된다(2026-08-29 실측). 단독 식별 불가 |
| `firms.corp_key` | 표기 변형 흡수용 정규화 키. 같은 법인 묶기용이며 **식별키가 아니다** |

`biz_no` 단독 조인 금지. `firm_id` 는 서버에서 재검증한다(POL-07).

본선 제안서 3.1.5가 **"안정 사업장 식별키 확보"** 를 보완 과제로 지목한 이유가 이것이다.

## 8. 미연결 3개 지표

POL-05-1이 정의한다. 사용자 위험카드 4개 항목 중 실연동은 **1개**뿐이다.

| 항목 | 상태 |
| --- | --- |
| 체불사업주 명단 | ✅ 실연동 (`official_listing`) |
| 이직률 (12개월) | ❌ `확인할 수 없음` |
| 고용 추이 | ❌ `확인할 수 없음` |
| 데이터 충실도 | ❌ `확인할 수 없음` |

**`scored_active` 에 이름이 비슷한 컬럼이 실제로 존재한다**(`turnover_avg_12m`,
`emp_change_12m`, `imputed_ratio` 등). 쓰면 안 된다. 모델 학습용 피처이지 출처·기준일이
검증된 공개 지표가 아니다. 내부 피처를 사용자용 값으로 변환하는 것은 POL-05-1 위반이다.

연동에 필요한 것(**미확정 — 별도 과제**):

- 출처 기관·API·공표 주기
- 기준일 정의
- `firms` 와의 매칭 키와 실패 시 상태
- `no_data`(결과 없음)와 `unavailable`(공급자 장애) 구분 기준

## 9. 조회 규칙

### 9.1 ⚠️ 주석의 지시와 현재 구현이 다르다

DB 주석은 뷰 사용을 지시하지만, **현재 Web 코드는 원본 테이블을 직접 조회한다.**

| | DB 주석의 지시 | 현재 구현 (2026-08-29 확인) |
| --- | --- | --- |
| 임금 판정 | `v_current_safe` | `public.safe_recommendation` + `latest_batch` CTE |
| 채점 | `v_current_scored` | `public.scored_active` + `latest_batch` CTE |
| 배치 | `v_current_batch` | `public.batches` + `LATEST_BATCH_ORDER_SQL` |
| 산업안전 | — | `industrial_safety.v_llm_firm_safety_context` (뷰 사용) |

근거: `product/src/adapters/real/MlRiskProvider.ts` 253~298행.
`grep -rn "v_current_" product/src --include=*.ts` 결과 0건(테스트 제외).

최신 배치 선택은 뷰 대신 `product/src/server/latestBatchSql.ts` 의 `LATEST_BATCH_ORDER_SQL`
이 담당하며, 정렬 규칙(`as_of_date DESC, ingested_at DESC, id DESC`)은 `v_current_batch` 와 동일하다.
**결과는 같지만 경로가 다르다.**

코드를 뷰 기반으로 바꿀지는 별도 과제다(11.4절). 그 전까지 이 문서는 **현재 구현을 기술한다.**

### 9.2 뷰의 설계 의도

아래는 DB 주석이 정의한 각 뷰의 용도다. 코드가 뷰를 쓰게 될 때 이 규칙을 따른다.

| 뷰 | 용도 | 주의 |
| --- | --- | --- |
| `v_current_batch` | 최신 배치 1행 | `as_of_date` 기준. 같은 기준일은 `ingested_at`, `id` 내림차순. **`id` 만으로 고르지 않는다**(백필 때문) |
| `v_current_scored` | 최신 배치 채점 | 화면·챗봇은 원본 대신 이걸 쓴다 — `batch_id` 를 빠뜨려도 안전 |
| `v_current_queue` | 최신 배치 감독관 큐 | 정렬은 `rank` 로 |
| `v_current_safe` | 최신 배치 구직자 판정 | **구직자 화면은 위험등급 대신 이 판정만** |
| `v_risk_history` | 사업장 월간 추이 | 과거 달에 없던 사업장은 **행이 없다**(폐업·신규 = 정상). **선을 잇지 말고 끊어서 그릴 것** |

`v_risk_history` 추가 주의(DB 주석): `체불배제`·`체납배제` 플래그는 **점-인-타임이 아니라
현재 상태**다. 과거 시점 그래프에 현재 플래그를 소급 적용하지 않는다.

`wg_bot` 계정은 `users`·`posts`·`comments`·`reviews` 원본에 접근 권한이 없다.
커뮤니티는 `v_posts`·`v_comments`·`v_reviews`(신원 제거)로만 읽는다.

## 10. 표현 정책 참조

중복 정의하지 않는다. `product/docs/service-policy.md` 를 따른다.

| 상황 | 정책 |
| --- | --- |
| 원시 수치 노출 | POL-03 |
| `normal` 해석 | POL-04 |
| `unknown` 해석 | POL-05 |
| 미연결 지표 | POL-05-1 |
| 명단 등재 사실 분리 | POL-06 |
| `company_id` 조회 | POL-07 |
| 기준일·출처 표시 | POL-11 |

## 11. 알려진 문제와 요청 항목

이 계약 범위 밖이지만 기록해 둔다.

### 11.1 운영 DB에 스키마 주석이 없다

이 문서의 근거가 되는 `COMMENT ON` 49건이 **저장소 migration에만 있고 운영 DB에는 0건**이다.
Path B release dump가 `--no-comments` 로 생성돼 복원 과정에서 전부 제외됐다
(`path-b-release.metadata.json` 의 `"no_comments": true`).

- 영향: 스키마를 직접 조회하는 사람·AI 에이전트가 경고를 읽지 못한다
- 조치: migration의 `COMMENT ON` 구문만 재실행하면 복원된다(데이터 변경 없음)
- 담당: `db/migrations/**` 사용자 DB 담당 · 운영 반영 인프라 담당

### 11.2 테스트 블록리스트에 `risk_tier` 가 없다

사용자 응답에 내부 필드가 섞이는지 검사하는 테스트가 두 곳 있으나,
**`risk_tier` 는 어느 목록에도 없다.**

```javascript
// product/src/services/policy.test.ts:95
["raw_probability", "percentile", "shap_value", "internal_score", "model_threshold", ...]

// product/src/services/integrationContract.test.ts:51
/risk_full|probability|percentile|shap/i
```

숫자 원점수는 막지만 **등급 라벨은 통과한다.** 사용자 입장에서 "매우높음"은 `0.9904` 보다
이해하기 쉬우므로 오히려 더 위험하다. 2절 규칙을 코드로 강제하려면 두 목록에
`risk_tier` 를 추가해야 한다.

- 담당: `product/src/**` — 공통 파일 규칙상 인프라 담당 검토 필요

### 11.3 DB 주석에 사실 오류가 있다

이 계약의 1차 근거인 `COMMENT ON` 중 **검증 가능한 수치 6건을 전수 대조한 결과 2건이 틀렸다.**

| 주석 위치 | 주석 값 | 실측 (2026-08-29) | |
| --- | --- | --- | --- |
| `0006_risk_tier.sql` `queue_priority` | `긴급(rank<100)` | `rank <= 100` | ❌ |
| `0002_bot_views.sql` `firms.biz_no` | 최대 **788곳** 재사용 | **950곳** | ❌ |
| `0003_target_month.sql` `risk_full` | NULL 약 9.2% | 8.98% | ⚠️ 근사 |
| `0002_bot_views.sql` `inspector_queue.reasons` | 상위 3,000곳에만 | 3,000 / 3,000 | ✅ |
| `0006_risk_tier.sql` 백분위 모집단 | `risk_full NOT NULL AND 체불배제=false` | 503,754 = 등급 4종 합 | ✅ |
| `0003_target_month.sql` `risk_calibrated` | 전부 NULL | 0 / 553,598 | ✅ |

**이 문서는 실측값을 쓴다.** 다만 주석을 고치지 않으면 다음에 스키마를 조회하는 사람·에이전트가
같은 오류를 반복한다.

- 조치: `db/migrations` 의 해당 `COMMENT ON` 수정
- 담당: 사용자 DB 담당 (`db/migrations/**`)
- 함께: 11.1의 주석 재적용 작업과 묶어 처리하면 효율적이다

### 11.4 조회 방식을 코드에 맞출지 뷰에 맞출지

9.1절 참고. DB 주석은 뷰 사용을 지시하나 코드는 원본 테이블을 직접 조회한다.

| 선택지 | 영향 |
| --- | --- |
| 문서를 코드에 맞춘다 (현재) | 주석의 설계 의도가 사문화된다 |
| 코드를 뷰로 바꾼다 | `product/src/**` 변경. 공통 파일 규칙상 인프라 담당 검토 필요 |

현재는 첫 번째를 택했다. 두 번째로 갈지는 결정이 필요하다.

### 11.5 `valid_until` 이 항상 `null` 이라 POL-11 을 지킬 수 없다

**[실측 2026-08-31]** `MlRiskProvider.ts:323-324` 가 두 값을 **하드코딩**한다.

```ts
valid_until: null,
freshness: "unknown",
```

`riskService.ts:11-12` 의 `getFreshnessFromValidUntil()` 은 `validUntil === null` 이면
`"unknown"` 을 돌려준다. 따라서 **freshness 가 `current`/`expired` 로 갈 수 없다.**

POL-11 의 요구를 구조적으로 수행할 수 없다.

> *"`valid_until` 이 지난 결과에는 '자료 갱신 필요' 또는 '유효기간이 지난 결과'를 표시한다."*
> *"오래된 결과를 최신 정보처럼 표현하지 않는다."*

배치가 6개월 주기(`as_of_date` → `target_month`)인데 **유효기간 판정이 없으면
오래된 배치를 최신처럼 보여주게 된다.**

| 결정할 것 | 후보 |
| --- | --- |
| `valid_until` 산출 기준 | `target_month` 말일? 다음 배치 예정일? 고정 기간? |
| 값이 없을 때 화면 처리 | 현재는 `freshness="unknown"`. 문구가 필요한지 |

- 담당: `product/src/**` — 공통 파일 규칙상 인프라 담당 검토 필요
- 성격: **정책 미충족**이지 계약 수치 오류는 아니다

### 11.6 미확정 항목

| 항목 | 결정 필요 | 관련 담당 |
| --- | --- | --- |
| `유보` 85.7% 편중의 화면 처리 | 시각 강조 수준 | 화면 담당·정보설계 담당 |
| 화면별 기준일 표시(`as_of_date` vs `target_month`) | 화면마다 지정 | 화면 담당·정보설계 담당 |
| `reasons` 영문 원본명 **11종** 라벨화 | **선행**: 저장소에 정의 없음 → 피처 사전 확보 | 모델 담당 → 정보설계 담당 |
| 미연결 3개 지표 데이터 소스 | 8절 4개 항목 | ML·DB 검토 담당(별도 과제) |
| **`valid_until` 산출 기준** | 11.5절 — POL-11 유효기간 요건 미충족 | 인프라 담당 검토 |
| `sources[].organization` 화면 표기 | 6.2절 — 원출처가 아니라 파이프라인명 | 화면 담당·정보설계 담당 |

## 부록. 검증 방법

```bash
# 판정 분포
psql -c "select 판정, count(*) from v_current_safe group by 1 order by 2 desc;"

# 등급 분포
psql -c "select risk_tier, count(*) from v_current_scored group by 1 order by 2 desc;"

# 등급 해설표
psql -c "select * from risk_tier_meta order by sort_order;"

# 변환 코드
sed -n '55,135p' product/src/adapters/real/MlRiskProvider.ts
```

**코드가 바뀌면 이 문서도 함께 바뀌어야 한다.** 3절 표는
`MlRiskProvider.ts` 의 `VERDICT_META` 와 1:1 대응이다.
