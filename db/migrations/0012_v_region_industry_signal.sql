-- Custom SQL migration file, put your code below! --

CREATE OR REPLACE VIEW public.v_region_industry_signal AS
WITH base AS (
  SELECT
    COALESCE(NULLIF(f.sido, ''), '지역 미상')                       AS sido,
    CASE WHEN s.industry_category ~ '업$' THEN s.industry_category
         ELSE '업종 미상' END                                       AS industry,
    CASE
      WHEN v.판정 = '안정신호' THEN 'normal'
      WHEN v.판정 = '유보'     THEN 'watch'
      WHEN v.판정 LIKE '배제%' THEN 'review'
      ELSE 'unknown'
    END                                                             AS signal_level
  FROM v_current_scored s
  LEFT JOIN v_current_safe v USING (firm_id, batch_id)
  JOIN public.firms       f USING (firm_id)
)
SELECT
  sido,
  industry,
  COUNT(*)                                            AS firm_count,
  COUNT(*) FILTER (WHERE signal_level = 'normal')      AS normal_count,
  COUNT(*) FILTER (WHERE signal_level = 'watch')       AS watch_count,
  COUNT(*) FILTER (WHERE signal_level = 'review')      AS review_count,
  COUNT(*) FILTER (WHERE signal_level = 'unknown')     AS unknown_count
FROM base
GROUP BY 1, 2;

COMMENT ON VIEW public.v_region_industry_signal IS
  '지역·업종별 표시등급 집계. 모집단은 최신 배치 채점 대상 553,598(v_current_scored). unknown 은 유보_정보부족과 판정 없음을 합친 값으로 개별 조회 화면과 같은 기준. 개별 사업장 점수·순위 없음';

-- wg_bot 은 Path B 세션 가드 때문에 로컬 개발 환경엔 보통 없다.
-- 롤이 있을 때만 GRANT해서, 없는 환경(로컬 등)에서도 migration이 통과하게 한다.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wg_bot') THEN
    EXECUTE 'GRANT SELECT ON public.v_region_industry_signal TO wg_bot';
  END IF;
END $$;