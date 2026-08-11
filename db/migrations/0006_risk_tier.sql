-- 위험등급 체계 정리 — 두 개념을 분리한다.
--
-- 배경: 처음에는 "전체 분포 등급" 과 "큐 안 우선순위" 가 둘 다 '긴급/우선/주의' 라는
-- 같은 단어를 썼다. 그런데 가리키는 집합이 25배 달랐다.
--   · 큐 우선순위 '긴급' = 큐 순위 100위 이내         → 100곳
--   · 전체 분포  '긴급' = 전체 채점가능군 상위 0.5%  → 2,519곳
-- 게다가 큐는 3,000곳뿐이라 백분위 컷을 큐에 적용하면 84%가 한 등급에 몰려
-- 큐 안에서 변별이 되지 않았다. ML팀 확인 후 아래처럼 갈랐다.
--
--   risk_tier       scored_active 전체 · 백분위 기준 · 매우높음/높음/다소높음/일반
--   queue_priority  큐 top3000 내부 · 순위 기준     · 긴급/우선/주의/관찰
--
-- 큐 화면 정렬은 계속 rank 로 한다. risk_tier 로 큐를 정렬하지 않는다.

/* ── ① 전체 분포 등급 ─────────────────────────────────────── */

ALTER TABLE scored_active ADD COLUMN IF NOT EXISTS risk_tier text;

COMMENT ON COLUMN scored_active.risk_tier IS
  '전체 분포 기준 위험등급. 매우높음(상위 0.5%)/높음(~2%)/다소높음(~10%)/일반 + 정보부족/이미공개. '
  '백분위 모집단은 batch 안에서 risk_full IS NOT NULL AND 체불배제 = false 인 행만. '
  '감독관 전용 — 구직자 화면에 노출 금지(명예훼손 리스크).';

-- 등급별 필터·집계용. batch 안에서만 의미가 있으므로 batch_id 를 앞에 둔다.
CREATE INDEX IF NOT EXISTS scored_batch_tier_idx ON scored_active (batch_id, risk_tier);

/* ── ② 큐 우선순위 (이름만 바꾼다, 값은 그대로) ──────────── */

ALTER TABLE inspector_queue RENAME COLUMN grade TO queue_priority;
ALTER INDEX queue_batch_grade_idx RENAME TO queue_batch_priority_idx;

COMMENT ON COLUMN inspector_queue.queue_priority IS
  '큐 top3000 안에서의 순위 기반 우선순위. 긴급(rank<100)/우선(<500)/주의(<1500)/관찰. '
  'scored_active.risk_tier 와 다른 척도다 — 같은 단어로 부르지 말 것.';

/* ── ③ 모델 지문 ──────────────────────────────────────────── */

-- model_version 은 "레시피 정체"(door1-voting-39f-v1)를 가리키고 월 갱신에도 안 바뀐다.
-- 그래서 이것만으로는 "이번 달 점수가 정말 같은 모델에서 나왔는가" 를 증명할 수 없다.
-- 월 재추론은 매 실행 재학습을 하고, 학습셋·하이퍼파라미터·시드가 고정이라
-- 결정론적으로 같은 모델이 나온다 — 단 **동일 환경(lightgbm==4.6.0 등)에서만** 성립한다.
-- pkl 해시를 배치마다 남겨두면 순위가 크게 흔들려도 "모델이 아니라 데이터 때문" 이라고
-- 한 줄로 답할 수 있다.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS model_sha text;

COMMENT ON COLUMN batches.model_sha IS
  '이 배치를 만든 모델 pkl 의 sha256 앞 16자. model_version 이 같아도 이 값이 다르면 '
  '가중치가 실제로 바뀐 것이다. 동일 환경 전제에서만 재현이 보장된다.';

/* ── ④ 등급 해설표 ────────────────────────────────────────── */

-- lift = "이 구간이 평균 대비 몇 배 더 자주 실제 명단공개되는가".
-- ML팀이 라벨 있는 CV(LORO, firm당 1행)로 실측한 값이다.
-- DB 에는 라벨이 없어 우리가 재계산할 수 없다 — 받은 값을 그대로 보존한다.
CREATE TABLE IF NOT EXISTS risk_tier_meta (
  tier            text PRIMARY KEY,
  sort_order      smallint NOT NULL,
  percentile_from real,
  percentile_to   real,
  recall_cum      real,
  lift_low        real,
  lift_high       real,
  label           text NOT NULL,
  is_prediction   boolean NOT NULL DEFAULT true
);

COMMENT ON TABLE risk_tier_meta IS
  '위험등급 범례·툴팁용 해설표. lift 는 ML팀 실측값이며 DB 에서 재계산 불가 — 임의로 고치지 말 것.';
COMMENT ON COLUMN risk_tier_meta.lift_low IS
  'pooled(전체 회차) 기준 = 보수적. 화면에는 lift_low~lift_high 범위로 표기한다.';
COMMENT ON COLUMN risk_tier_meta.lift_high IS
  'recent(2023~2026 배포대상) 기준 = 낙관적.';
COMMENT ON COLUMN risk_tier_meta.is_prediction IS
  'false 면 예측이 아니라 사실·상태다(이미공개·정보부족). 위험 예측과 섞어 표시하지 말 것.';

INSERT INTO risk_tier_meta
  (tier, sort_order, percentile_from, percentile_to, recall_cum, lift_low, lift_high, label, is_prediction)
VALUES
  ('매우높음', 1, 0.000, 0.005, 0.047, 4.7, 9.3,  '최고위험 · 평균 대비 약 5~9배',  true),
  ('높음',     2, 0.005, 0.020, 0.221, 4.4, 11.0, '고위험 · 평균 대비 약 4~11배',   true),
  ('다소높음', 3, 0.020, 0.100, 0.419, 2.7, 4.2,  '관찰 필요 · 평균 대비 약 3~4배', true),
  ('일반',     4, 0.100, 1.000, NULL,  1.0, 1.0,  '특이신호 없음',                  true),
  ('정보부족', 5, NULL,  NULL,  NULL,  NULL, NULL, '데이터 부족으로 평가 보류',      false),
  ('이미공개', 6, NULL,  NULL,  NULL,  NULL, NULL, '이미 명단공개된 곳',             false)
ON CONFLICT (tier) DO UPDATE SET
  sort_order      = EXCLUDED.sort_order,
  percentile_from = EXCLUDED.percentile_from,
  percentile_to   = EXCLUDED.percentile_to,
  recall_cum      = EXCLUDED.recall_cum,
  lift_low        = EXCLUDED.lift_low,
  lift_high       = EXCLUDED.lift_high,
  label           = EXCLUDED.label,
  is_prediction   = EXCLUDED.is_prediction;
