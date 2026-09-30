-- Current browsing names only. Keep source/model history and its region codes intact.
ALTER TABLE public.firms ADD COLUMN sido_source text;
--> statement-breakpoint
UPDATE public.firms SET sido_source = sido WHERE sido_source IS NULL;
--> statement-breakpoint
UPDATE public.firms
   SET sido = CASE sido
     WHEN '광주광역시' THEN '전남광주통합특별시'
     WHEN '전라남도' THEN '전남광주통합특별시'
     WHEN '광주특별시' THEN '전남광주통합특별시'
     WHEN '강원도' THEN '강원특별자치도'
     WHEN '전라북도' THEN '전북특별자치도'
     WHEN '제주도' THEN '제주특별자치도'
     WHEN '세종시' THEN '세종특별자치시'
     ELSE sido END
 WHERE sido IN ('광주광역시', '전라남도', '광주특별시',
                '강원도', '전라북도', '제주도', '세종시');
