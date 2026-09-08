# ML → DB 데이터 계약

> 문서 v1.0 (초안) · 작성 2026-08-31 · 대상 `db/scripts/ingest.sh` @ `main`
> 근거: `ingest.sh` 실제 코드 · `DB_설계문서` · `통합보고서 ver2 §12`
> **검토 요청: 한승석** — 검토 항목은 §13

---

## 0. 이 문서의 위치

우리 시스템의 데이터는 세 구간을 거친다.

```text
[ML 산출물] ──① ML→DB 계약── [PostgreSQL] ──② DB→화면 계약── [화면]
                 이 문서                      docs/data-contract/**
                                              (한승석 작성)
```

**이 문서는 ①을 정의한다.** ②는 이미 작성돼 있으므로, 둘이 합쳐지면 `ML → 화면` 전 구간이 문서로 연결된다.

### 0.1 이 문서가 필요한 이유

규격이 문서로 없으면 **한 사람만 "이 산출물이 들어갈 수 있는지" 판단할 수 있다.** 실제로 다음 사고가 있었다.

- **175행 소실** — ML 지시서가 정규화된 이름으로 식별키를 만들라고 했으나, 국민연금은 사업장 단위라 서로 다른 사업장 168곳이 병합돼 사라졌다. 로그에는 "적재 완료"만 남았고 행수를 세어보고서야 발견했다 (`DB_설계문서 §4.2`)
- **타입 함정** — `sido_code`를 정수로 저장하면 LightGBM이 해당 피처를 무시해 모델 성능이 조용히 붕괴한다 (`DB_설계문서 §4.4`)

두 사고 모두 **에러 없이 조용히** 발생했다. 계약과 검증기가 없으면 재발한다.

### 0.2 이 문서의 목표

ML 산출자가 여러 명이어도 각자 규격을 확인하고 제출할 수 있게 한다. 현재는 인프라 담당 한 명만 판단할 수 있어 팀 프로젝트의 취지에 맞지 않는다.

---

## 1. 계약 당사자와 범위

| | |
| --- | --- |
| **공급 측** | ML 산출자 — 학습·채점을 수행하고 CSV를 생성하는 사람 |
| **수요 측** | 적재 시스템 — `db/scripts/ingest.sh` |
| **적용 범위** | 임금체불 예측 결과 3종 |
| **적용 제외** | 산업재해 결과 — 별도 경로 사용. §12 참조 |

**공급 측은 여러 명일 수 있다.** 이 문서의 목적이 그것이다.

---

## 2. 제출물 구성

제출은 **디렉터리 하나**다. 그 안에 다음이 있어야 한다.

```text
<제출 디렉터리>/
  scored_active_full.csv          필수
  감독관_위험큐_full.csv           필수
  safe_recommendation_full.csv    필수
  manifest.json                   권장 (§6.3)
```

### 2.1 파일명 규칙

**파일명은 정확히 위와 같아야 한다.** `ingest.sh:159`가 이 세 이름을 그대로 찾는다.

```bash
for f in scored_active_full.csv 감독관_위험큐_full.csv safe_recommendation_full.csv; do
```

- 한글 파일명(`감독관_위험큐_full.csv`)을 영문으로 바꾸면 **적재가 실패한다**
- 대소문자·확장자를 바꿔도 실패한다

### 2.2 파일 형식

| 항목 | 값 |
| --- | --- |
| 형식 | CSV |
| 인코딩 | **UTF-8** (BOM 없음) |
| 헤더 | **있어야 함** (첫 줄) |
| 구분자 | 쉼표 |
| 줄바꿈 | LF 권장 |

---

## 3. 가장 중요한 규칙 3가지

이 세 가지를 어기면 **에러 없이 잘못된 데이터가 들어간다.**

### 규칙 1 — 컬럼 **순서**가 계약이다. 이름이 아니다.

적재는 이렇게 동작한다.

```sql
\copy stg_scored FROM '...' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
```

**PostgreSQL의 `HEADER true`는 첫 줄을 건너뛰기만 하고, 컬럼 이름을 대조하지 않는다.** 값은 **위치 순서대로** 들어간다.

> **결과**: 컬럼을 하나 추가하거나 순서를 바꾸면, 그 뒤 모든 값이 한 칸씩 밀려 **다른 컬럼에 조용히 들어간다.** 행수는 맞으므로 행수 단언에도 걸리지 않는다.

따라서 §4의 컬럼 순서를 정확히 지켜야 한다.

> **개선 제안** — PostgreSQL 16은 `HEADER MATCH`를 지원한다. 이걸로 바꾸면 이름 불일치를 DB가 잡아준다. 별도 과제로 제안한다(§14-1).

### 규칙 2 — 불리언은 **숫자**로 쓴다

적재 캐스팅이 이렇다.

```sql
nullif("G1_고용안정",'')::numeric::int::bool
```

| CSV 값 | 결과 |
| --- | --- |
| `0` · `1` | 정상 |
| `0.0` · `1.0` | 정상 |
| `TRUE` · `FALSE` | **캐스팅 실패 → 적재 중단** |
| `True` · `False` · `t` · `f` | 실패 |
| 빈 칸 | NULL |

**pandas에서 `bool` dtype으로 `to_csv`하면 `True`/`False`로 나간다.** 저장 전에 `astype(int)` 처리가 필요하다.

해당 컬럼은 다음과 같다.

```text
scored:  G1_고용안정 · G2_성실납부 · G3_인건비안정 · G4_인력유지 ·
         G5_업력3년 · G6_낮은변동성 · 체불배제 · 체납배제
queue:   door1_체납이력 · 이미_임금체불공개
safe:    체불배제 · 체납배제
```

> `door1_ever`는 불리언처럼 보이지만 **`::real`로 캐스팅된다.** 숫자로 써야 한다.

### 규칙 3 — 빈 칸은 NULL, **0이 아니다**

모든 수치 컬럼이 `nullif(x,'')` 처리를 거친다. 즉 빈 칸은 NULL이 된다.

`risk_full`이 특히 중요하다.

```text
risk_full = (빈 칸)  →  NULL  →  "이력 부족으로 채점 불가"
risk_full = 0        →  0     →  "위험도 0인 안전한 회사"
```

**의미가 정반대다.** 전체의 약 9.2%(50,657곳)가 NULL 대상이다. 0으로 채우면 안 된다.

> pandas의 `fillna(0)`을 저장 직전에 쓰면 안 된다.

---

## 4. 파일별 컬럼 명세

### 4.1 `scored_active_full.csv` — 54컬럼

**순서대로** 다음과 같다. 캐스팅 열은 적재 시 적용되는 변환이다.

| # | 컬럼 | CSV 형식 | 캐스팅 | 비고 |
| ---: | --- | --- | --- | --- |
| 1 | `사업장명` | 문자열 | text | **원본 표기 그대로** |
| 2 | `사업자번호` | 문자열 | text | 마스킹 6자리. 앞자리 0 보존 |
| 3 | `시도` | 문자열 | text | |
| 4 | `업종` | 문자열 | text | |
| 5 | `n_months` | 정수 | `smallint` | |
| 6 | `G1_고용안정` | **0/1** | `bool` | 규칙 2 |
| 7 | `G2_성실납부` | **0/1** | `bool` | |
| 8 | `G3_인건비안정` | **0/1** | `bool` | |
| 9 | `G4_인력유지` | **0/1** | `bool` | |
| 10 | `G5_업력3년` | **0/1** | `bool` | |
| 11 | `G6_낮은변동성` | **0/1** | `bool` | |
| 12 | `n_green` | 정수 | `smallint` | |
| 13 | `체불배제` | **0/1** | `bool` | |
| 14 | `체납배제` | **0/1** | `bool` | |
| 15 | `risk_full` | 실수 또는 **빈 칸** | `real` | 규칙 3 |
| 16 | `turnover_avg_12m` | 실수 | `real` | |
| 17 | `turnover_avg_3m` | 실수 | `real` | |
| 18 | `turnover_max_12m` | 실수 | `real` | |
| 19 | `turnover_std_12m` | 실수 | `real` | |
| 20 | `emp_change_3m` | 실수 | `real` | |
| 21 | `emp_change_6m` | 실수 | `real` | |
| 22 | `emp_change_12m` | 실수 | `real` | |
| 23 | `salary_avg_12m` | 실수 | `real` | |
| 24 | `salary_last` | 실수 | `real` | |
| 25 | `salary_change_6m` | 실수 | `real` | |
| 26 | `salary_change_12m` | 실수 | `real` | |
| 27 | `replacement_avg_12m` | 실수 | `real` | |
| 28 | `replacement_avg_3m` | 실수 | `real` | |
| 29 | `replacement_min_12m` | 실수 | `real` | |
| 30 | `salary_drop_consecutive` | 실수 | `real` | |
| 31 | `turnover_momentum` | 실수 | `real` | |
| 32 | `zero_emp_months` | 실수 | `real` | |
| 33 | `emp_volatility` | 실수 | `real` | |
| 34 | `log_emp_count` | 실수 | `real` | |
| 35 | `firm_age_months` | 실수 | `real` | |
| 36 | `sido_code` | **문자열** | **캐스팅 없음** | 아래 경고 |
| 37 | `industry_category` | **문자열** | **캐스팅 없음** | 아래 경고 |
| 38 | `imputed_months_count` | 실수 | `real` | |
| 39 | `imputed_ratio` | 실수 | `real` | |
| 40 | `has_missing_recent_3m` | 실수 | `real` | |
| 41 | `nf_bill_last_ratio` | 실수 | `real` | |
| 42 | `nf_bill_maxdrop` | 실수 | `real` | |
| 43 | `nf_pc_slope` | 실수 | `real` | |
| 44 | `nf_pay_divergence` | 실수 | `real` | |
| 45 | `nf_bill_cv` | 실수 | `real` | |
| 46 | `nf_emp_slope` | 실수 | `real` | |
| 47 | `nf_drawdown` | 실수 | `real` | |
| 48 | `door1_ever` | 실수 | `real` | 불리언 아님 |
| 49 | `door1_n_insu` | 실수 | `real` | |
| 50 | `door1_maxamt` | 실수 | `real` | |
| 51 | `door1_maxmonths` | 실수 | `real` | |
| 52 | `door1_health` | 실수 | `real` | |
| 53 | `door1_pension` | 실수 | `real` | |
| 54 | `door1_labor` | 실수 | `real` | |

#### 36·37번 컬럼 경고

```text
sido_code          학습 시 문자열 '11' 로 입력됨
industry_category  동일
```

**적재는 이 두 컬럼을 캐스팅 없이 그대로 넣는다.** 따라서 CSV에 어떻게 쓰였는지가 그대로 DB에 남는다.

문제는 **저장 단계**다.

```python
# 위험 — pandas 가 '01' 을 정수 1 로 읽고 CSV 에 1 로 저장
df = pd.read_csv(src)

# 안전
df = pd.read_csv(src, dtype={
    'sido_code': str,
    'industry_category': str,
    '사업자번호': str,
})
```

`01`이 `1`이 되면 **학습 때와 다른 값**이 되어 LightGBM이 해당 피처를 무시한다. 에러는 나지 않는다.

#### 참고 — `industry_death_rate_2023`

`ingest.sh` 주석에 이렇게 적혀 있다.

> AGENT_GUIDE §5는 `industry_death_rate_2023`이 남아있다고 하지만 이번 export(260807)에는 실제로 없다. 추가되면 여기에 컬럼을 더한다.

**이 컬럼을 추가하려면 계약 변경 절차(§11)를 거쳐야 한다.** 임의로 넣으면 규칙 1 위반이다.

### 4.2 `감독관_위험큐_full.csv` — 10컬럼

| # | 컬럼 | CSV 형식 | 캐스팅 | 비고 |
| ---: | --- | --- | --- | --- |
| 1 | `순위` | 정수 | `int` | 1부터 시작 |
| 2 | `위험등급` | 문자열 | text | 긴급 / 우선 / 주의 / 관찰 |
| 3 | `사업장명` | 문자열 | text | |
| 4 | `사업자번호` | 문자열 | text | |
| 5 | `시도` | 문자열 | text | |
| 6 | `업종` | 문자열 | text | |
| 7 | `risk_full` | 실수 | `real` | |
| 8 | `door1_체납이력` | **0/1** | `bool` | |
| 9 | `이미_임금체불공개` | **0/1** | `bool` | |
| 10 | `핵심_위험사유` | 문자열 | **배열 변환** | 아래 |

#### 10번 `핵심_위험사유` — 구분자가 정확해야 한다

```sql
string_to_array("핵심_위험사유", ' · ')
```

구분자는 **`공백 + 가운뎃점(U+00B7) + 공백`**이다.

```text
정상  체납액 · imputed_months_count · door1_maxmonths
오류  체납액·imputed_months_count            (공백 없음 → 한 덩어리로 저장)
오류  체납액, imputed_months_count           (쉼표 → 분리 안 됨)
오류  체납액 - imputed_months_count          (하이픈 → 분리 안 됨)
```

**구분자가 틀려도 에러가 나지 않는다.** 배열 원소가 1개인 채로 저장된다.

> 이 값은 감독관 화면의 "위험 사유"로 표시된다. 상위 3,000곳에만 존재하며, 나머지 사업장에는 없다.

### 4.3 `safe_recommendation_full.csv` — 11컬럼

| # | 컬럼 | CSV 형식 | 캐스팅 | 비고 |
| ---: | --- | --- | --- | --- |
| 1 | `사업장명` | 문자열 | text | |
| 2 | `사업자번호` | 문자열 | text | |
| 3 | `시도` | 문자열 | text | |
| 4 | `업종` | 문자열 | text | |
| 5 | `n_months` | 정수 | `smallint` | |
| 6 | `n_green` | 정수 | `smallint` | |
| 7 | `risk_full` | 실수 또는 빈 칸 | `real` | |
| 8 | `체불배제` | **0/1** | `bool` | |
| 9 | `체납배제` | **0/1** | `bool` | |
| 10 | `door1_ever` | 실수 | `real` | 불리언 아님 |
| 11 | `판정` | 문자열 | text | 아래 |

#### 11번 `판정` — 허용값이 고정돼 있다

**정확히 다음 6개 중 하나여야 한다.**

```text
안정신호
유보
유보_정보부족
배제_임금체불공개
배제_공개체납
배제_4대보험체납(door1)
```

- 화면 변환 규칙이 이 문자열에 정확히 매핑돼 있다 (`docs/data-contract/wage-risk.md`)
- 새 판정값을 추가하면 화면에서 처리되지 않는다. 계약 변경 절차 필요
- 공백·괄호를 포함해 한 글자도 달라지면 안 된다

---

## 5. 파일 간 관계

세 파일은 **포함 관계**여야 한다.

```text
scored_active_full        전체 채점 대상
  ⊇ safe_recommendation   risk_full 이 있는 것만
      ⊇ 감독관_위험큐      상위 N (현재 3,000)
```

### 5.1 검증 조건

| # | 조건 |
| --- | --- |
| C1 | `safe`의 모든 `(사업장명, 사업자번호)`가 `scored`에 존재 |
| C2 | `queue`의 모든 `(사업장명, 사업자번호)`가 `scored`에 존재 |
| C3 | `queue`의 모든 `(사업장명, 사업자번호)`가 `safe`에 존재 |
| C4 | `scored` 내에서 `(사업장명, 사업자번호)` 중복 없음 |
| C5 | `queue.순위`가 1부터 연속, 중복 없음 |
| C6 | 세 파일에서 같은 사업장의 `risk_full` 값이 일치 |

참고 실측값 (`260807` 배치)

```text
scored  552,500
safe    501,843   (50,657곳은 risk_full NULL → 제외)
queue     3,000
```

### 5.2 식별키는 자동 생성된다

```sql
firm_id  = substr(sha1(사업장명 || '|' || 사업자번호), 1, 16)
corp_key = substr(sha1(정규화(사업장명) || '|' || 사업자번호), 1, 16)
```

**ML 측은 `firm_id`를 만들지 않는다.** 적재 시 `사업장명`과 `사업자번호`로 계산된다.

- **`firm_id`는 원본 이름을 쓴다.** 정규화하지 않는다 — 175행 사고의 원인
- `corp_key`는 `㈜ (주) （주） 주식회사 (유) 유한회사`를 제거하고 공백을 없앤 뒤 계산한다. 같은 법인 묶기용 보조 컬럼이며 식별키가 아니다

> **`사업장명`을 정규화해서 CSV에 쓰면 안 된다.** 원본 표기를 그대로 넣어야 한다.

---

## 6. 함께 제출할 메타데이터

CSV만으로는 부족하다. 다음을 함께 제출한다.

### 6.1 적재 시 필수 인자

| 인자 | 필수 | 형식 | 의미 |
| --- | :---: | --- | --- |
| `--outputs` | 필수 | 경로 | CSV 3개가 있는 디렉터리 |
| `--model-version` | 필수 | 영숫자 | 모델 레시피 식별자 (예: `260807`) |
| `--as-of` | 필수 | `YYYY-MM` | **관측창 종료월** |
| `--canonical-timestamp` | 필수 | RFC3339 UTC | 재구축 기준 시각 |
| `--expected-database` | 필수 | 식별자 | 대상 DB 이름 |
| `--expect-rows` | 권장 | `S,Q,F` | 예상 행수 3개 |
| `--model-sha` | 권장 | 해시 | 모델 파일 SHA |

### 6.2 `--as-of`의 정확한 의미

**이 값은 "파일을 만든 날"이 아니다.**

```text
as_of        관측창 종료월 = 어느 국민연금 데이터까지 썼는가
target_month as_of + 6개월 = 예측 대상월 (자동 계산됨)
```

예를 들어 `--as-of 2026-06`이면 `target_month`는 `2026-12`가 된다.

> **이 값이 없으면 화면에 "언제 기준 위험도"인지 표시할 수 없다.** 현재 DB에서 `NULL`인 배치가 있어 데이터 계약 문서에도 "미확정"으로 남아 있다. 새 제출부터는 반드시 채운다.

### 6.3 `manifest.json` (권장)

`통합보고서 ver2 §12`가 요구하는 메타데이터다. 자가 검증 도구가 자동 생성한다.

```json
{
  "model_version": "260901",
  "model_sha256": "...",
  "as_of_date": "2026-06",
  "target_month": "2026-12",
  "code_commit": "abc1234",
  "training_start": "...",
  "training_end": "...",
  "prediction_as_of": "...",
  "preprocessing_version": "...",
  "label_definition_version": "...",
  "row_counts": { "scored": 552500, "queue": 3000, "safe": 501843 },
  "file_sha256": {
    "scored_active_full.csv": "...",
    "감독관_위험큐_full.csv": "...",
    "safe_recommendation_full.csv": "..."
  },
  "generated_at": "2026-08-31T10:00:00Z",
  "submitted_by": "..."
}
```

---

## 7. ML이 만들지 않아도 되는 것

다음은 **적재 시 자동 생성**된다. CSV에 넣지 않는다.

| 항목 | 생성 방식 |
| --- | --- |
| `firm_id` · `corp_key` | 사업장명 + 사업자번호에서 SHA-1 |
| `batch_id` | 적재 시 시퀀스 |
| `target_month` | `as_of + 6개월` |
| `risk_calibrated` | **NULL 고정** — 캘리브레이션 미적용 상태 |
| `risk_tier` | 배치 내 백분위로 계산 (아래) |
| `first_seen` · `last_seen` | `as_of_date` 기준 갱신 |
| `ingested_at` | 적재 시각 |

### 7.1 `risk_tier` 계산 규칙

```text
모집단: 이 batch 안에서 risk_full 이 있고 체불배제가 아닌 곳

pr ≤ 0.005  →  매우높음
pr ≤ 0.02   →  높음
pr ≤ 0.10   →  다소높음
그 외        →  일반

모집단 제외분
  체불배제 = TRUE  →  이미공개
  그 외            →  정보부족
```

> **`risk_tier`(매우높음/높음/…)와 `위험등급`(긴급/우선/…)은 일부러 다르다.** 큐 3,000곳은 전부 전체 상위 0.6% 안이라 같은 척도를 쓰면 84%가 한 등급에 몰린다.

---

## 8. 금지 사항

| # | 금지 | 결과 |
| --- | --- | --- |
| 1 | 컬럼 추가·삭제·순서 변경 | 값이 밀려 조용히 오적재 |
| 2 | 불리언을 `TRUE`/`FALSE`로 저장 | 적재 실패 |
| 3 | `risk_full`의 NULL을 0으로 채우기 | 의미가 정반대 |
| 4 | `사업자번호`를 숫자로 저장 | 앞자리 0 소실 |
| 5 | `sido_code`·`industry_category`를 숫자로 저장 | 모델 성능 붕괴 |
| 6 | `사업장명`을 정규화해서 저장 | 서로 다른 사업장 병합 |
| 7 | `핵심_위험사유` 구분자 변경 | 배열 분리 실패 |
| 8 | `판정`에 정의되지 않은 값 | 화면에서 처리 불가 |
| 9 | `--as-of` 생략 또는 임의값 | 기준일 표시 불가 |
| 10 | 파일명 변경 | 적재 실패 |
| 11 | UTF-8 외 인코딩 · BOM 포함 | 한글 깨짐 |
| 12 | 세 파일의 포함 관계 위반 | 화면에서 데이터 불일치 |

---

## 9. 적재가 검증하는 것 / 검증하지 않는 것

### 9.1 `ingest.sh`가 잡아주는 것

| 검증 | 실패 시 |
| --- | --- |
| CSV 행수 = 적재 행수 | **전체 롤백** |
| `--expect-rows`와 일치 | **전체 롤백** |
| 대상 DB 신원 (이름·OID·system identifier) | 중단 |
| canonical timestamp UTC 왕복 | 중단 |
| 불리언·숫자 캐스팅 가능 여부 | 중단 |
| 파일 3개 존재 | 중단 |

### 9.2 `ingest.sh`가 잡아주지 **않는** 것

| 검증되지 않는 것 | 위험 |
| --- | --- |
| **컬럼 이름** | 순서만 맞으면 통과 |
| **컬럼 순서 자체** | 밀려도 행수는 맞음 |
| `risk_full` 값 범위 (0~1) | 이상값이 그대로 저장 |
| 파일 간 포함 관계 | 큐에 없는 회사가 들어가도 통과 |
| `(사업장명, 사업자번호)` 중복 | 마지막 값만 남음 |
| `판정` 허용값 여부 | 오타가 그대로 저장 |
| `핵심_위험사유` 구분자 | 1개 원소로 저장 |
| `사업자번호` 앞자리 0 소실 | 다른 사업장이 됨 |
| `순위` 연속성 | 빠져도 통과 |

> **이 목록이 자가 검증 도구가 채워야 할 범위다.** 적재 단계에서는 이미 늦다.

---

## 10. 제출 절차

### 10.1 현재 (수동)

```text
① CSV 3개 생성
② 자가 검증 실행 (도구 완성 후)
③ 인프라 담당에게 전달
④ VM으로 전송
⑤ ingest.sh 실행
⑥ 적재 후 검증
```

### 10.2 목표

```text
① CSV 3개 생성
② 자가 검증 → 통과해야 다음 단계
③ 제출 (지정 경로 업로드)
④ 이후 자동
```

### 10.3 적재 명령 예시

```bash
./scripts/ingest.sh \
  --outputs        ./outputs \
  --model-version  260901 \
  --as-of          2026-06 \
  --expect-rows    552500,3000,501843 \
  --canonical-timestamp 2026-08-31T00:00:00Z \
  --expected-database   wageguard \
  --env-file       ./.env.local
```

---

## 11. 계약 변경 절차

컬럼 추가·판정값 추가 등 **계약을 바꾸려면 코드도 함께 바뀌어야 한다.**

```text
① 변경 요청 — 무엇을 왜 바꾸는지
② 영향 범위 확인
     ingest.sh staging 정의 · 캐스팅
     db/schema.ts · 새 migration
     docs/data-contract/**  (한승석)
     화면 표시 (심수현 · 김민서)
③ 계약 문서 갱신
④ 자가 검증 도구 갱신
⑤ 코드 PR — 위 전부를 한 PR 로
⑥ 빈 PG16 에서 전체 적재 테스트
⑦ 병합
```

**기존 migration은 수정하지 않는다.** 새 번호로 추가한다.

---

## 12. 산업재해 결과는 별도 경로

이 문서의 범위 밖이다. 다른 메커니즘을 쓴다.

```text
db/scripts/ingest-industrial-safety.sh
db/config/industrial_safety_sources.v1.json   (원본 위치 registry)
--v2-root / --extension-root                  (호출 시 override)
```

- registry는 **원본 출처 증빙**이라 수정하지 않는다
- 경로가 다르면 CLI 인자로 넘긴다
- 별도 계약 문서가 필요하면 후속 과제로 작성한다

---

## 13. 검토 요청 사항 — 한승석

이 문서는 `ingest.sh` 코드에서 규격을 역으로 추출해 작성했다. 다음은 **ML·DB 의미 판단이 필요한 항목**이라 검토를 요청한다.

### 13.1 우선 확인

| # | 항목 | 묻는 것 |
| --- | --- | --- |
| Q1 | `판정` 6종이 전부인가 | `docs/data-contract/wage-risk.md`에 정리한 6종과 일치하는지. 추가 예정 값이 있는지 |
| Q2 | `risk_full` 범위 검증을 넣어도 되는가 | 자가 검증기가 `0 ≤ x ≤ 1`을 강제해도 문제없는지. 이론상 범위를 벗어날 수 있는지 |
| Q3 | `위험등급` 4종이 고정인가 | 긴급/우선/주의/관찰 외에 다른 값이 나올 수 있는지 |
| Q4 | 세 파일의 포함 관계가 항상 성립하는가 | `queue ⊆ safe ⊆ scored`를 검증 조건으로 강제해도 되는지 |
| Q5 | `door1_ever`가 `real`인 이유 | 불리언처럼 보이는데 실수로 캐스팅된다. 의도된 것인지 |

### 13.2 판단이 필요한 것

| # | 항목 | 배경 |
| --- | --- | --- |
| Q6 | `industry_death_rate_2023` 추가 여부 | AGENT_GUIDE에는 있으나 260807 export에는 없다. 다음 배치에 넣을 계획인지 |
| Q7 | `risk_calibrated` 채울 시점 | 현재 NULL 고정. 캘리브레이션 도입 계획이 있는지 |
| Q8 | 안정 `firm_id` 도입 | 현재는 이름 기반이라 사업장명이 바뀌면 키가 달라진다(월 약 0.24%). ML 측에서 안정 일련번호를 제공할 수 있는지 |
| Q9 | `as_of_date` 소급 확정 | 기존 배치의 NULL을 채울 수 있는지. 어느 값이 맞는지 |

### 13.3 계약 문서 간 연결

| # | 항목 |
| --- | --- |
| Q10 | 이 문서(ML→DB)와 `docs/data-contract/**`(DB→화면)가 이어지는지. 중간에 정의가 끊기는 필드가 있는지 |
| Q11 | 두 문서를 하나로 합칠지, 분리 유지할지 |

---

## 14. 열린 항목

| # | 항목 | 상태 |
| --- | --- | --- |
| 1 | `HEADER MATCH`로 전환해 컬럼명 검증 | 제안 |
| 2 | `industry_death_rate_2023` 추가 여부 | Q6 |
| 3 | `risk_calibrated` 채울 시점 | Q7 |
| 4 | 안정 `firm_id` 도입 | Q8 |
| 5 | 산업재해 계약 문서 | 후속 |
| 6 | 자가 검증 도구 구현 | 다음 작업 |

---

## 부록 A. 자가 검증 체크리스트

자가 검증 도구가 확인해야 할 항목이다. 도구 완성 전에는 수동 확인용으로 쓴다.

### 파일 수준

```text
[ ] 파일 3개가 정확한 이름으로 존재
[ ] UTF-8 · BOM 없음
[ ] 헤더 존재
```

### 컬럼 수준

```text
[ ] scored 54컬럼 · queue 10컬럼 · safe 11컬럼
[ ] 컬럼 이름이 §4 와 일치
[ ] 컬럼 순서가 §4 와 일치        ← 가장 중요
```

### 값 수준

```text
[ ] 불리언 컬럼이 0/1 (TRUE/FALSE 아님)
[ ] 사업자번호가 문자열 · 앞자리 0 보존
[ ] sido_code · industry_category 가 문자열
[ ] risk_full 의 결측이 빈 칸 (0 아님)
[ ] risk_full 값이 0~1 범위
[ ] 판정이 허용 6종 중 하나
[ ] 위험등급이 허용 4종 중 하나
[ ] 핵심_위험사유 구분자가 ' · '
[ ] 순위가 1부터 연속
```

### 관계 수준

```text
[ ] safe ⊆ scored
[ ] queue ⊆ safe ⊆ scored
[ ] scored 내 (사업장명, 사업자번호) 중복 없음
[ ] 같은 사업장의 risk_full 이 세 파일에서 일치
```

### 메타데이터

```text
[ ] model_version 지정
[ ] as_of 가 관측창 종료월 (파일 생성일 아님)
[ ] expect_rows 3개 값
[ ] manifest.json 생성
```

---

## 부록 B. 근거

| 항목 | 근거 |
| --- | --- |
| 파일명·컬럼·캐스팅 | `db/scripts/ingest.sh` (실제 코드) |
| 타입 함정 | `DB_설계문서 §4.4` |
| 175행 사고 | `DB_설계문서 §4.2` |
| `risk_full` 해석 | `DB_설계문서 §9.1`, `통합보고서 ver2 §4.13` |
| 판정 6종 | `DB_설계문서 §4.3`, `docs/data-contract/wage-risk.md` |
| run manifest 항목 | `통합보고서 ver2 §12` |
| `risk_tier` 규칙 | `ingest.sh` 주석 |
| 실측 행수 | `GCP_PATH_B_DEPLOYMENT_RESULT_2026-08-28` |

---

## 부록 C. pandas 저장 예시

계약을 만족하는 저장 코드다.

```python
import pandas as pd

# 1) 읽을 때 문자열 컬럼을 명시한다
STR_COLS = {
    '사업장명': str, '사업자번호': str, '시도': str, '업종': str,
    'sido_code': str, 'industry_category': str,
}
df = pd.read_csv(src, dtype=STR_COLS)

# 2) 불리언을 0/1 로 바꾼다
BOOL_COLS = [
    'G1_고용안정', 'G2_성실납부', 'G3_인건비안정',
    'G4_인력유지', 'G5_업력3년', 'G6_낮은변동성',
    '체불배제', '체납배제',
]
for c in BOOL_COLS:
    df[c] = df[c].astype('Int64')   # NULL 을 유지하면서 정수화

# 3) risk_full 의 결측은 그대로 둔다. fillna(0) 금지
#    df['risk_full'] = df['risk_full'].fillna(0)   ← 절대 금지

# 4) 컬럼 순서를 계약대로 고정한다
df = df[SCORED_COLUMNS_IN_ORDER]

# 5) 저장
df.to_csv(dst, index=False, encoding='utf-8')
```

`na_rep`을 지정하지 않으면 pandas는 결측을 빈 칸으로 쓴다. 이것이 계약과 일치한다.

## 갱신 기록
- 2026-09-08: §3 규칙 1·§14-1의 `HEADER MATCH` 제안을 적용함. `db/scripts/ingest.sh`의 `\copy` 3곳이 `HEADER MATCH`를 사용하므로 CSV 헤더 이름이 §4 컬럼명과 다르면 적재가 즉시 실패한다. `--as-of` 누락과 형식 오류는 별도 메시지로 구분한다.
