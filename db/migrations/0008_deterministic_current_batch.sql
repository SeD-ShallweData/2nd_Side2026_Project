-- 같은 as_of_date에 여러 model_version 배치가 존재할 수 있다.
-- 기준월을 먼저 고르고, 동률일 때만 가장 최근 적재와 id를 결정적 보조 기준으로 사용한다.
CREATE OR REPLACE VIEW v_current_batch AS
SELECT * FROM batches
WHERE as_of_date IS NOT NULL
ORDER BY as_of_date DESC, ingested_at DESC, id DESC
LIMIT 1;

COMMENT ON VIEW v_current_batch IS
  '가장 최근 as_of_date 배치 한 행. 같은 기준일은 ingested_at, id 내림차순으로 결정한다. 백필 때문에 id만으로 최신 배치를 고르지 않는다.';
