-- seed_local.sql
-- 감독관 화면용 로컬 seed 데이터
--
-- 대상: public.firms, public.batches, public.scored_active,
--       public.inspector_queue, industrial_safety.v_llm_firm_safety_context
--
-- v_llm_firm_safety_context는 뷰라 직접 INSERT 불가 — 밑에 있는
-- industrial_safety.pipeline_runs, industrial_safety.firm_risk_results에
-- 넣어서 뷰에 자동으로 나타나게 한다.
--
-- 실행: docker exec -i <db-container> psql -U wageguard -d wageguard -f - < seed_local.sql
-- 또는:  psql -f seed_local.sql (DATABASE_URL 환경변수 설정된 상태에서)

BEGIN;

-- ── 1. firms (사업장) ──────────────────────────────────────────
INSERT INTO public.firms (firm_id, corp_key, name, biz_no, sido, industry, first_seen, last_seen)
VALUES
  ('f0000000000000a1', 'c0000000000000a1', '가나다물류㈜',       '123-45-****', '서울', '운수업',   '2020-01-01', '2026-08-01'),
  ('f0000000000000a2', 'c0000000000000a2', '한빛건설',           '234-56-****', '경기', '건설업',   '2019-03-15', '2026-08-01'),
  ('f0000000000000a3', 'c0000000000000a3', '푸른식품가공',       '345-67-****', '부산', '제조업',   '2021-06-01', '2026-08-01'),
  ('f0000000000000a4', 'c0000000000000a4', '대성전자부품',       '456-78-****', '경북', '제조업',   '2018-11-20', '2026-08-01'),
  ('f0000000000000a5', 'c0000000000000a5', '늘봄요양센터',       '567-89-****', '인천', '보건업',   '2022-02-10', '2026-08-01'),
  ('f0000000000000a6', 'c0000000000000a6', '청록물산',           '678-90-****', '전남', '도소매업', '2017-05-05', '2026-08-01'),
  ('f0000000000000a7', 'c0000000000000a7', '미래테크놀로지',     '789-01-****', '대전', '제조업',   '2020-09-09', '2026-08-01')
ON CONFLICT (firm_id) DO NOTHING;

-- ── 2. batches ─────────────────────────────────────────────────
INSERT INTO public.batches (as_of_date, target_month, model_version, model_sha, source, n_scored, n_queue, n_safe)
VALUES
  ('2026-04-01', '2026-10-01', 'door1-voting-39f-v1', 'a1b2c3d4e5f6a1b2', 'seed_local', 7, 5, 2)
ON CONFLICT (as_of_date, model_version) DO NOTHING;

-- 방금 넣은 batch의 id를 변수처럼 재사용하기 위해 CTE 대신 DO 블록 사용
DO $$
DECLARE
  v_batch_id integer;
BEGIN
  SELECT id INTO v_batch_id FROM public.batches
  WHERE as_of_date = '2026-04-01' AND model_version = 'door1-voting-39f-v1';

  -- ── 3. scored_active (7곳 전부 채점) ───────────────────────
  INSERT INTO public.scored_active (firm_id, batch_id, n_months, risk_full, risk_tier, sido_code, industry_category)
  VALUES
    ('f0000000000000a1', v_batch_id, 13, 0.91, '매우높음', '11', '운수업'),
    ('f0000000000000a2', v_batch_id, 13, 0.83, '높음',     '41', '건설업'),
    ('f0000000000000a3', v_batch_id, 13, 0.62, '다소높음', '26', '제조업'),
    ('f0000000000000a4', v_batch_id, 13, 0.55, '다소높음', '47', '제조업'),
    ('f0000000000000a5', v_batch_id, 13, 0.20, '일반',     '28', '보건업'),
    ('f0000000000000a6', v_batch_id, 13, 0.15, '일반',     '46', '도소매업'),
    ('f0000000000000a7', v_batch_id, 13, NULL, NULL,       '30', '제조업')  -- 정보부족 케이스
  ON CONFLICT (firm_id, batch_id) DO NOTHING;

  -- ── 4. inspector_queue (상위 5곳만 큐에 진입) ──────────────
  INSERT INTO public.inspector_queue (firm_id, batch_id, rank, queue_priority, risk_full, reasons)
  VALUES
    ('f0000000000000a1', v_batch_id, 1, '긴급', 0.91, ARRAY['급여체불이력','고용변동성','업력짧음']),
    ('f0000000000000a2', v_batch_id, 2, '긴급', 0.83, ARRAY['체납이력','인건비급락']),
    ('f0000000000000a3', v_batch_id, 3, '우선', 0.62, ARRAY['이직률증가']),
    ('f0000000000000a4', v_batch_id, 4, '우선', 0.55, ARRAY['근로자수감소']),
    ('f0000000000000a5', v_batch_id, 5, '주의', 0.20, ARRAY['변동성낮음'])
  ON CONFLICT (firm_id, batch_id) DO NOTHING;
END $$;

-- ── 5. industrial_safety.v_llm_firm_safety_context ──────────────
-- 뷰 자체엔 못 넣으니, 뷰가 참조하는 pipeline_runs + firm_risk_results에 넣는다.

INSERT INTO industrial_safety.pipeline_runs (
  run_kind, publication_scope, pipeline_name, pipeline_version, contract_version,
  model_name, model_version, population_tier, scenario_id, target_definition,
  calibration_status, probability_status, risk_value_type, priority_reference_population,
  target_week_start_min, target_week_start_max,
  primary_artifact_path, primary_artifact_sha256, run_fingerprint,
  expected_row_count, loaded_row_count, status, is_current,
  source_generated_at, validated_at, published_at
) VALUES (
  'firm_risk',
  'industrial_safety.firm_risk.existing_firms.nps',
  'existing_firms_projection', 'v1', 'v1',
  'door1-voting-39f', 'v1', 'existing_firms', 'baseline', 'weekly_incident_risk',
  'calibrated', 'validated', 'probability', 'existing_firms_population',
  -- 다음주 월요일 기준 (isodow=1 체크 통과용, 실제 실행 시점에 맞게 조정 필요)
  date_trunc('week', now() + interval '1 week')::date,
  date_trunc('week', now() + interval '1 week')::date,
  'seed/local/fake_artifact.parquet',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  5, 5, 'published', true,
  now() - interval '1 day', now() - interval '12 hours', now() - interval '1 hour'
);

DO $$
DECLARE
  v_run_id bigint;
  v_week date;
BEGIN
  SELECT run_id INTO v_run_id FROM industrial_safety.pipeline_runs
  WHERE run_fingerprint = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  v_week := date_trunc('week', now() + interval '1 week')::date;

  INSERT INTO industrial_safety.firm_risk_results (
    run_id, firm_id, target_week_start, prediction_as_of,
    source_workplace_id, validation_status, match_method, confidence_tier,
    provisional_population_priority_percentile, provisional_population_priority_band,
    research_only_provisional_probability
  ) VALUES
    (v_run_id, 'f0000000000000a1', v_week, now() - interval '2 hours',
     'npss_11111111111111111111', 'verified_exact', 'exact_name_masked_business_registration_sido_industry', 'exact_unique',
     0.005, '상위1%', 0.88),
    (v_run_id, 'f0000000000000a2', v_week, now() - interval '2 hours',
     'npss_22222222222222222222', 'verified_exact', 'exact_name_masked_business_registration_sido_industry', 'exact_unique',
     0.03, '상위5%', 0.71),
    (v_run_id, 'f0000000000000a3', v_week, now() - interval '2 hours',
     'npss_33333333333333333333', 'verified_exact', 'exact_name_masked_business_registration_sido_industry', 'exact_unique',
     0.08, '상위10%', 0.45),
    (v_run_id, 'f0000000000000a4', v_week, now() - interval '2 hours',
     'npss_44444444444444444444', 'verified_exact', 'exact_name_masked_business_registration_sido_industry', 'exact_unique',
     0.09, '상위10%', 0.40),
    (v_run_id, 'f0000000000000a5', v_week, now() - interval '2 hours',
     'npss_55555555555555555555', 'verified_exact', 'exact_name_masked_business_registration_sido_industry', 'exact_unique',
     0.30, '일반', 0.12)
  ON CONFLICT DO NOTHING;
END $$;

COMMIT;

-- ── 확인용 쿼리 (실행 후 눈으로 검증) ─────────────────────────
-- SELECT count(*) FROM public.firms;
-- SELECT count(*) FROM public.batches;
-- SELECT count(*) FROM public.scored_active;
-- SELECT count(*) FROM public.inspector_queue;
-- SELECT count(*) FROM industrial_safety.v_llm_firm_safety_context;
