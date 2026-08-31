# 돈워리 데이터 계약

- 계약 버전: `data-contract.v1.0`
- 기준일: 2026-08-29
- 대상: PostgreSQL 16 / `wageguard` DB
- 기본 소비자: 구직자 웹 UI, 근로감독관 대시보드, LLM 상담 백엔드, 인수 테스트
- 검증 기준 배치: `batches.id = 7` (`as_of_date=2026-06-01`, `target_month=2026-12-01`)

## 1. 목적과 비목적

### 목적

**DB에 저장된 값이 무엇을 뜻하는지 고정한다.** ML 산출물이 DB를 거쳐 화면에 도달하는 동안
의미가 변형되거나 과장되지 않도록, 각 단계의 변환 규칙을 문서로 못 박는다.

```
ML 결과  →  DB 필드  →  API 응답  →  화면
            ↑ 이 문서가 다루는 구간
```

### 비목적

이 계약은 다음을 **다루지 않는다.** 이미 다른 문서가 정의했으므로 여기서 재정의하면
서로 어긋난다.

| 다루지 않는 것 | 정본 |
| --- | --- |
| 화면 문구·색상·카드 배치 | `product/docs/service-policy.md` (POL-01~POL-14) |
| API 요청·응답 필드 형태 | `product/docs/api-contract.md` |
| 산업재해 적재 절차·매칭 funnel | `db/docs/INDUSTRIAL_SAFETY_EXISTING_FIRMS_CONTRACT.md` |
| 마이그레이션 운영 절차 | `db/docs/MIGRATION_OPERATIONS.md` |
| 모델 성능·학습 방법 | 본선 제안서 3.2.3 |

표현 정책이 필요할 때는 **POL 번호로 참조**하고 문장을 복사하지 않는다.

## 2. 문서 구성

| 문서 | 내용 | 상태 |
| --- | --- | --- |
| `README.md` | 이 문서. 계약 버전·범위·색인 | ✅ |
| [`wage-risk.md`](wage-risk.md) | 임금체불 — 사용자 경로와 감독관 경로 분리, 판정·등급 매핑, 기준일, 식별키 | ✅ |
| [`samples/`](samples/) | 상태별 API 응답 예시 5종 | ✅ |
| [`safety-risk.md`](safety-risk.md) | 산업재해 — band 매핑, `provisional`·`research_only` 취급, 셀→사업장 배분 | ✅ |

### `samples/` 구성

| 파일 | DB 상태 | `SignalLevel` | 최신 배치 비중 |
| --- | --- | --- | ---: |
| [`normal.json`](samples/normal.json) | `안정신호` | `normal` | 6.5% |
| [`watch.json`](samples/watch.json) | `유보` | `watch` | **85.7%** |
| [`unknown.json`](samples/unknown.json) | `유보_정보부족` | `unknown` | 3.5% |
| [`partial-unavailable.json`](samples/partial-unavailable.json) | 부분 장애 (HTTP 200) | `unknown` | — |
| [`error-503.json`](samples/error-503.json) | 전체 장애 (HTTP 503) | — | — |

샘플 값은 **batch 7 실제 조회 결과 기반**이며, `company_id`·`company_name` 만 합성했다
(`COMPANY_DEMO_*`). 저장소가 공개이므로 실존 사업장과 ML 판정을 연결해 두지 않는다.
각 파일의 `_snapshot` 필드에 근거 시점이 적혀 있으며, 배치가 갱신되면 값이 달라진다.

장애 샘플은 둘로 나눈다. **전체 장애는 비-200 이며 본문에 `error` 객체만 있고**,
부분 장애는 HTTP 200 에 실패한 신호만 `availability: "unavailable"` 이다.

`member-status.md` 는 3종(정상·자료 부족·오류)을 요구했으나, 실제 최다수인 `watch`(85.7%)가
누락되지 않도록 4종으로 만들었다.

## 3. 이 계약의 근거

문서 내용은 추측이 아니라 아래 세 곳에서 나왔다.

### 3.1 DB 스키마 주석 (1차 근거)

`db/migrations/*.sql` 의 `COMMENT ON` 구문 **49건**이 필드 의미의 원본이다.

| migration | 건수 | 주요 내용 |
| --- | ---: | --- |
| `0002_bot_views.sql` | 9 | `risk_full` 확률 아님, `firm_id` 가변, `biz_no` 비고유, `reasons` 범위 |
| `0003_target_month.sql` | 4 | 기준일 2종, 다운샘플링 배율 |
| `0004_industrial_safety.sql` | 19 | 산업재해 전반, `research_only`·`validated_probability` |
| `0005_existing_firms_projection.sql` | 4 | 엄격 매칭 결과만 보존, LLM 안전 뷰 |
| `0006_risk_tier.sql` | 7 | 등급 정의, **감독관 전용 명시**, `queue_priority` 척도 구분 |
| `0007_current_batch_views.sql` | 5 | 뷰 사용 규칙 |
| `0008_deterministic_current_batch.sql` | 1 | 최신 배치 결정 규칙 |

> ⚠️ **이 주석들은 운영 DB에 존재하지 않는다.** 6절 참고.

### 3.2 변환 코드

`product/src/adapters/real/MlRiskProvider.ts` (342줄)

| 위치 | 역할 |
| --- | --- |
| 56~75행 `VERDICT_META` | `판정` → `SignalLevel` 매핑 |
| 76~125행 `toWageRiskPublic()` | 사용자용 임금 응답 조립 |
| 128~132행 `safetyLevel()` | 산업재해 band → `SignalLevel` |
| 149~186행 `safetyResult()` | 산업안전 컨텍스트 조립 |

### 3.3 DB 실측 (2026-08-29)

판정 분포, 등급 분포, band 분포를 직접 조회해 문서의 표와 대조했다.
합계가 `batches.n_safe`·`n_scored` 및 `firm_risk_results` 행수와 일치함을 확인했다.

## 4. 읽어야 하는 사람

| 역할 | 무엇을 위해 |
| --- | --- |
| 화면 담당 | 위험카드 값의 의미, 4가지 상태별 화면 |
| 정보설계 담당 | `unknown` 표시 기준, `is_prediction=false` 처리 |
| QA 담당 | 인수 테스트 fixture (`samples/`) |
| RAG 담당 | LLM에 넘길 DB 컨텍스트 범위 |
| 커뮤니티 API 담당 | 해당 없음 — 커뮤니티는 ML과 무관 |
| 사용자 DB 담당 | 해당 없음 — Path B 정본과 별개 |

## 5. 유지 규칙

**코드가 바뀌면 이 문서도 바뀌어야 한다.**

`wage-risk.md` 3절의 매핑표는 `MlRiskProvider.ts` 의 `VERDICT_META` 와 1:1 대응이다.
새 `배제_*` 판정이 DB에 추가되거나 매핑 코드가 수정되면 문서를 함께 갱신한다.

검증 절차는 `wage-risk.md` 부록에 있다.

```bash
# 판정·등급·band 분포 재확인
psql -c "select 판정, count(*) from v_current_safe group by 1 order by 2 desc;"
psql -c "select risk_tier, count(*) from v_current_scored group by 1 order by 2 desc;"

# 변환 코드 대조
sed -n '55,190p' product/src/adapters/real/MlRiskProvider.ts
```

## 6. 미해결 항목

이 계약 범위 밖이지만 조치가 필요하다. 상세는 [`wage-risk.md` 11절](wage-risk.md)에 있다.

| # | 내용 | 담당 |
| --- | --- | --- |
| 1 | **운영 DB에 스키마 주석 0건** — release dump 의 `--no-comments` 로 49건이 전부 제외됐다. `COMMENT ON` 재실행 필요(데이터 변경 없음) | 사용자 DB 담당 · 인프라 담당 |
| 2 | **테스트 블록리스트에 `risk_tier` 없음** — 숫자 원점수는 막지만 등급 라벨은 통과한다 | 인프라 담당 |
| 3 | `watch` 85.7% 편중을 반영한 위험카드 시각 설계 | 화면 담당 · 정보설계 담당 |
| 4 | 화면별 기준일 표시(`as_of_date` vs `target_month`) 지정 | 화면 담당 · 정보설계 담당 |
| 5 | `inspector_queue.reasons` 의 **영문 원본 피처명 11종** 라벨화 — **선행: 저장소에 정의가 없어 모델 담당의 피처 사전이 먼저 필요** ([wage-risk.md 4.6](wage-risk.md)) | 모델 담당 → 정보설계 담당 |
| 6 | 미연결 3개 지표(이직률·고용 추이·데이터 충실도) 공개 데이터 계약 | ML·DB 검토 담당 (별도 과제) |

6번은 본선 제안서 3.1.5의 보완 과제이며 공개 데이터 조사가 필요해 일정을 별도로 잡는다.
