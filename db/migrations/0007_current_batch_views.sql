-- 현재 배치만 보는 뷰.
--
-- 왜 필요한가: 백필로 여러 달치가 쌓이면 `batch_id` 를 빠뜨린 쿼리가 **조용히 여러 배를
-- 반환한다.** 에러가 안 나기 때문에 화면 숫자가 틀린 줄 아무도 모른다.
--
--   SELECT count(*) FROM scored_active WHERE risk_tier='매우높음';
--   -- 1개 배치: 2,519      7개 배치: 17,000 남짓   ← 둘 다 에러 없음
--
-- 그래서 "지금 화면에 보여줄 값" 은 이 뷰만 쓰게 한다.
-- 추이 그래프처럼 여러 달이 필요할 때만 원본 테이블을 직접 본다.
--
-- 최신 배치의 기준은 `as_of_date` 내림차순이다. `id` 가 아니다 —
-- 백필은 과거 달을 나중에 넣으므로 id 가 큰 배치가 최신 달이 아니다.

CREATE OR REPLACE VIEW v_current_batch AS
SELECT * FROM batches
WHERE as_of_date IS NOT NULL
ORDER BY as_of_date DESC
LIMIT 1;

COMMENT ON VIEW v_current_batch IS
  '가장 최근 as_of_date 배치 한 행. id 가 아니라 as_of_date 기준이다 — 백필은 과거 달을 나중에 넣기 때문.';

CREATE OR REPLACE VIEW v_current_scored AS
SELECT s.* FROM scored_active s
WHERE s.batch_id = (SELECT id FROM v_current_batch);

CREATE OR REPLACE VIEW v_current_queue AS
SELECT q.* FROM inspector_queue q
WHERE q.batch_id = (SELECT id FROM v_current_batch);

CREATE OR REPLACE VIEW v_current_safe AS
SELECT r.* FROM safe_recommendation r
WHERE r.batch_id = (SELECT id FROM v_current_batch);

COMMENT ON VIEW v_current_scored IS
  '현재 배치의 scored_active. 화면·챗봇은 원본 대신 이걸 쓴다 — batch_id 를 빠뜨려도 안전하다.';
COMMENT ON VIEW v_current_queue IS
  '현재 배치의 inspector_queue. 정렬은 rank 로 한다(queue_priority 나 risk_tier 로 정렬하지 말 것).';
COMMENT ON VIEW v_current_safe IS
  '현재 배치의 safe_recommendation. 구직자 화면은 위험등급 대신 이 판정만 쓴다.';

-- 추이 조회용 인덱스.
-- 한 사업장의 여러 달을 뽑는 패턴이라 firm_id 를 앞에 둔다.
-- 기존 PK 는 (firm_id, batch_id) 라 batch_id 로 정렬해도 as_of_date 순이 아니다
-- (백필은 과거 달의 batch_id 가 더 크다).
CREATE INDEX IF NOT EXISTS scored_firm_batch_idx ON scored_active (firm_id, batch_id);

-- 사업장 하나의 위험도 추이. 화면에서 바로 쓰도록 as_of_date 로 정렬 가능하게 묶어둔다.
CREATE OR REPLACE VIEW v_risk_history AS
SELECT s.firm_id,
       b.as_of_date,
       b.target_month,
       s.risk_full,
       s.risk_tier,
       r.판정   AS verdict,
       q.rank   AS queue_rank
FROM scored_active s
JOIN batches b ON b.id = s.batch_id
LEFT JOIN safe_recommendation r ON r.firm_id = s.firm_id AND r.batch_id = s.batch_id
LEFT JOIN inspector_queue     q ON q.firm_id = s.firm_id AND q.batch_id = s.batch_id;

COMMENT ON VIEW v_risk_history IS
  '사업장별 월간 위험도 추이. WHERE firm_id = ? ORDER BY as_of_date 로 쓴다. '
  '과거 달에 없던 사업장은 행이 없다(폐업·신규 = 정상) — 선을 잇지 말고 끊어서 그릴 것. '
  '주의: 체불배제·체납배제 플래그는 점-인-타임이 아니라 현재 상태다. risk_full 에는 영향이 없다.';
